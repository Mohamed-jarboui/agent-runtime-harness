import { AsyncLocalStorage } from 'node:async_hooks';
import {
  LoopSmithError,
  nowIso,
  serializeError,
  type ApprovalRecord,
  type EventSink,
  type ErrorCategory,
  type ExecutionLimits,
  type RunRecord,
  type RuntimeEventType,
  type StateStore,
  type ToolCallRecord,
} from '@loopsmith/core';
import {
  DeferApprovals,
  summarizeApproval,
  type ApprovalResolver,
  type PolicyEngine,
} from '@loopsmith/policies';
import type { AgentRunResult, AgentRuntime } from '@loopsmith/runtime';
import type { ToolExecutor, ToolRegistry, WorkspaceSandbox } from '@loopsmith/tools';
import type { MemoryService } from '@loopsmith/core';
import type { NodeOutcome, NodeRequestBase, WorkflowServices } from '@loopsmith/workflow-engine';

/** Per-execution context carried through async calls (approval resolver, provider override). */
export interface ExecutionScope {
  approvals: ApprovalResolver;
}

export const executionScope = new AsyncLocalStorage<ExecutionScope>();

const RETRYABLE_AGENT_FAILURES: ReadonlySet<ErrorCategory> = new Set([
  'provider_transient',
  'provider_rate_limit',
  'provider_timeout',
  'invalid_model_response',
]);

export interface ServiceDeps {
  store: StateStore;
  events: EventSink;
  runtime: AgentRuntime;
  tools: ToolRegistry;
  executor: ToolExecutor;
  policy: PolicyEngine;
  workspace?: WorkspaceSandbox;
  memory?: MemoryService;
}

/**
 * Bridges the provider-agnostic workflow engine to the agent runtime:
 * agent nodes become child agent runs, tool nodes go through the same policy
 * engine and executor as agent tool calls, and approval nodes create
 * persisted human gates.
 */
export class RuntimeWorkflowServices implements WorkflowServices {
  constructor(private readonly deps: ServiceDeps) {}

  private get approvals(): ApprovalResolver {
    return executionScope.getStore()?.approvals ?? new DeferApprovals();
  }

  private workflowRun(id: string): RunRecord {
    const run = this.deps.store.getRun(id);
    if (!run) throw new LoopSmithError('storage', `Workflow run not found: ${id}`);
    return run;
  }

  async runAgent(
    request: NodeRequestBase & {
      agentId: string;
      prompt: string;
      context: Record<string, unknown>;
    },
  ): Promise<NodeOutcome> {
    const wf = this.workflowRun(request.workflowRunId);
    const signalOpt = request.signal ? { signal: request.signal } : {};
    let result: AgentRunResult;
    if (request.resumeRef) {
      result = await this.deps.runtime.resumeRun(request.resumeRef, {
        ...signalOpt,
        approvals: this.approvals,
      });
    } else {
      result = await this.deps.runtime.startRun({
        agentId: request.agentId,
        goal: request.prompt,
        sessionId: wf.sessionId,
        parentRunId: wf.id,
        rootRunId: wf.rootRunId,
        nodeId: request.nodeId,
        workflowId: wf.workflowId ?? undefined,
        workflowContext: request.context,
        ...(wf.config.limits ? { limits: wf.config.limits as Partial<ExecutionLimits> } : {}),
        ...(typeof wf.config.providerOverride === 'string'
          ? { providerOverride: wf.config.providerOverride }
          : {}),
        ...signalOpt,
        approvals: this.approvals,
      } as Parameters<AgentRuntime['startRun']>[0]);
    }
    switch (result.status) {
      case 'completed':
        return {
          status: 'completed',
          output: result.structured ?? result.output,
          ref: result.runId,
        };
      case 'awaiting_approval':
        return { status: 'paused', ref: result.runId, approvals: result.pendingApprovals };
      case 'cancelled':
        throw new LoopSmithError('cancelled', 'Agent node was cancelled');
      case 'failed': {
        const error =
          result.error ?? serializeError(new LoopSmithError('internal', 'Agent run failed'));
        return {
          status: 'failed',
          error,
          retryable: RETRYABLE_AGENT_FAILURES.has(error.category),
          ref: result.runId,
        };
      }
    }
  }

  async runTool(request: NodeRequestBase & { tool: string; args: unknown }): Promise<NodeOutcome> {
    const { store, executor, policy } = this.deps;
    const wf = this.workflowRun(request.workflowRunId);
    const recordId = request.resumeRef ?? `${wf.id}:${request.nodeId}:${request.attempt}`;
    let record = store.getToolCall(recordId);

    const prepared = executor.prepare({ name: request.tool, arguments: request.args });
    if (!prepared.ok)
      return { status: 'failed', error: serializeError(prepared.error), retryable: false };
    const tool = prepared.tool;

    if (!record) {
      record = {
        id: recordId,
        runId: wf.id,
        modelCallId: `${request.nodeId}:${request.attempt}`,
        messageSeq: -1,
        agentId: null,
        toolName: tool.name,
        arguments: prepared.input,
        status: 'requested',
        policyEffect: null,
        approvalId: null,
        childRunId: null,
        resultContent: null,
        isError: false,
        error: null,
        resultAppended: true,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        createdAt: nowIso(),
      } satisfies ToolCallRecord;
      const decision = policy.evaluate({ toolName: tool.name, category: tool.category });
      record.policyEffect = decision.effect;
      store.upsertToolCall(record);
      this.emit(wf, request.nodeId, 'tool.policy', {
        tool: tool.name,
        effect: decision.effect,
        rule: decision.rule,
        reason: decision.reason,
      });
      if (decision.effect === 'deny') {
        record.status = 'denied';
        store.upsertToolCall(record);
        this.emit(wf, request.nodeId, 'tool.denied', { tool: tool.name, reason: decision.reason });
        return {
          status: 'failed',
          error: serializeError(new LoopSmithError('permission_denied', decision.reason)),
          retryable: false,
          ref: record.id,
        };
      }
      if (decision.effect === 'require_approval') {
        const approval = store.createApproval({
          runId: wf.id,
          rootRunId: wf.rootRunId,
          kind: 'tool',
          toolCallId: record.id,
          toolName: tool.name,
          arguments: prepared.input,
          agentId: null,
          nodeId: request.nodeId,
          reason: decision.reason,
        });
        record.status = 'awaiting_approval';
        record.approvalId = approval.id;
        store.upsertToolCall(record);
        this.emit(wf, request.nodeId, 'approval.requested', {
          approvalId: approval.id,
          tool: tool.name,
          summary: summarizeApproval(approval),
        });
        const decided = await this.decideNow(wf, request.nodeId, approval);
        if (!decided) return { status: 'paused', ref: record.id, approvals: [approval] };
      }
    }

    if (record.status === 'awaiting_approval') {
      const approval = record.approvalId ? store.getApproval(record.approvalId) : undefined;
      if (!approval || approval.status === 'pending')
        return { status: 'paused', ref: record.id, approvals: approval ? [approval] : [] };
      if (approval.status === 'rejected') {
        record.status = 'rejected';
        store.upsertToolCall(record);
        this.emit(wf, request.nodeId, 'tool.rejected', {
          tool: tool.name,
          approvalId: approval.id,
        });
        return {
          status: 'failed',
          error: serializeError(
            new LoopSmithError('approval_rejected', `Human rejected ${tool.name}`),
          ),
          retryable: false,
          ref: record.id,
        };
      }
      record.status = 'requested';
    }
    if (record.status === 'completed')
      return { status: 'completed', output: safeParse(record.resultContent), ref: record.id };
    if (record.status === 'executing' && !tool.idempotent) {
      return {
        status: 'failed',
        error: serializeError(
          new LoopSmithError(
            'tool_execution',
            `${tool.name} was interrupted; outcome unknown, not retried`,
            { code: 'interrupted_unknown_outcome' },
          ),
        ),
        retryable: false,
        ref: record.id,
      };
    }

    record.status = 'executing';
    record.startedAt = nowIso();
    store.upsertToolCall(record);
    this.emit(wf, request.nodeId, 'tool.started', { tool: tool.name, arguments: prepared.input });
    const result = await executor.execute(tool, prepared.input, {
      runId: wf.id,
      sessionId: wf.sessionId,
      agentId: 'workflow',
      toolCallId: record.id,
      signal: request.signal ?? new AbortController().signal,
      ...(this.deps.workspace ? { workspace: this.deps.workspace } : {}),
      ...(this.deps.memory ? { memory: this.deps.memory } : {}),
    });
    record.status = result.ok ? 'completed' : 'failed';
    record.resultContent = result.content;
    record.isError = !result.ok;
    record.error = result.error ?? null;
    record.endedAt = nowIso();
    record.durationMs = result.durationMs;
    store.upsertToolCall(record);
    this.emit(
      wf,
      request.nodeId,
      result.ok ? 'tool.completed' : 'tool.failed',
      {
        tool: tool.name,
        arguments: prepared.input,
        ...(result.ok ? {} : { category: result.error?.category, message: result.error?.message }),
      },
      result.durationMs,
    );
    if (result.ok) return { status: 'completed', output: result.data, ref: record.id };
    return {
      status: 'failed',
      error: result.error as NonNullable<typeof result.error>,
      // Never silently retry side effects: only idempotent tools are retryable.
      retryable:
        tool.idempotent &&
        (result.error?.category === 'tool_timeout' || result.error?.category === 'tool_execution'),
      ref: record.id,
    };
  }

  async requestApproval(
    request: NodeRequestBase & { prompt: string },
  ): Promise<{ status: 'approved' | 'rejected' | 'pending'; approval: ApprovalRecord }> {
    const { store } = this.deps;
    const wf = this.workflowRun(request.workflowRunId);
    if (request.resumeRef) {
      const existing = store.getApproval(request.resumeRef);
      if (existing) return { status: existing.status, approval: existing };
    }
    const approval = store.createApproval({
      runId: wf.id,
      rootRunId: wf.rootRunId,
      kind: 'workflow_gate',
      toolCallId: null,
      toolName: null,
      arguments: null,
      agentId: null,
      nodeId: request.nodeId,
      reason: request.prompt,
    });
    this.emit(wf, request.nodeId, 'approval.requested', {
      approvalId: approval.id,
      summary: summarizeApproval(approval),
    });
    const decided = await this.decideNow(wf, request.nodeId, approval);
    return decided
      ? { status: decided.status, approval: decided }
      : { status: 'pending', approval };
  }

  private async decideNow(
    wf: RunRecord,
    nodeId: string,
    approval: ApprovalRecord,
  ): Promise<ApprovalRecord | undefined> {
    const outcome = await this.approvals.resolve(approval);
    if (outcome.decision === 'defer') return undefined;
    const decided = this.deps.store.decideApproval(approval.id, {
      status: outcome.decision,
      by: outcome.by,
      ...(outcome.note ? { note: outcome.note } : {}),
    });
    this.emit(wf, nodeId, 'approval.decided', {
      approvalId: decided.id,
      status: decided.status,
      by: decided.decidedBy,
    });
    return decided;
  }

  private emit(
    run: RunRecord,
    nodeId: string,
    type: RuntimeEventType,
    data: Record<string, unknown>,
    durationMs?: number,
  ): void {
    this.deps.events.emit({
      type,
      sessionId: run.sessionId,
      runId: run.id,
      rootRunId: run.rootRunId,
      nodeId,
      ...(durationMs === undefined ? {} : { durationMs }),
      data,
    });
  }
}

function safeParse(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
