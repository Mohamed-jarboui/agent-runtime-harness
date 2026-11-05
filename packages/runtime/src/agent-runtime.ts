import {
  LoopSmithError,
  TERMINAL_RUN_STATUSES,
  anySignal,
  extractJson,
  nowIso,
  resolveLimits,
  safeStringify,
  serializeError,
  throwIfAborted,
  toLoopSmithError,
  type AgentDefinition,
  type ApprovalRecord,
  type AssistantMessage,
  type EventSink,
  type ExecutionLimits,
  type MemoryService,
  type MessageRecord,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type RunRecord,
  type RuntimeEventType,
  type SerializedError,
  type StateStore,
  type ToolCall,
  type ToolCallRecord,
  type ToolSpec,
  type AgentModelConfig,
} from '@loopsmith/core';
import { ContextManager, detectInjectionSignals, UNTRUSTED_NOTICE } from '@loopsmith/context';
import {
  DeferApprovals,
  summarizeApproval,
  type ApprovalResolver,
  type PolicyEngine,
} from '@loopsmith/policies';
import {
  ToolExecutor,
  type RegisteredTool,
  type ToolRegistry,
  type WorkspaceSandbox,
} from '@loopsmith/tools';
import type { AgentRegistry } from './agent-registry.js';
import {
  HANDOFF_TOOL,
  META_TOOLS,
  delegateSchema,
  handoffSchema,
  metaToolSpecs,
  parseMeta,
} from './meta-tools.js';

export interface ProviderResolver {
  resolve(
    config: AgentModelConfig | undefined,
    override?: string,
  ): { provider: ModelProvider; model: string };
}

export interface AgentRuntimeDeps {
  store: StateStore;
  events: EventSink;
  agents: AgentRegistry;
  tools: ToolRegistry;
  policy: PolicyEngine;
  providers: ProviderResolver;
  context?: ContextManager;
  memory?: MemoryService;
  approvals?: ApprovalResolver;
  workspace?: WorkspaceSandbox;
  limits?: Partial<ExecutionLimits>;
  /** Default max output tokens per model call. */
  maxOutputTokens?: number;
}

export interface StartAgentRunOptions {
  agentId: string;
  goal: string;
  sessionId?: string;
  parentRunId?: string;
  rootRunId?: string;
  nodeId?: string;
  workflowId?: string;
  delegationDepth?: number;
  workflowContext?: Record<string, unknown>;
  limits?: Partial<ExecutionLimits>;
  /** Force every agent in this run onto one provider (e.g. `mock`, `anthropic`). */
  providerOverride?: string;
  signal?: AbortSignal;
  approvals?: ApprovalResolver;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
  approvals?: ApprovalResolver;
}

export type AgentRunStatus = 'completed' | 'awaiting_approval' | 'failed' | 'cancelled';

export interface AgentRunResult {
  runId: string;
  rootRunId: string;
  sessionId: string;
  status: AgentRunStatus;
  /** Agent that owns the final answer (changes on handoff). */
  agentId: string;
  output: string | null;
  structured?: unknown;
  error?: SerializedError;
  pendingApprovals: ApprovalRecord[];
}

interface ExecContext {
  signal?: AbortSignal;
  /** Signal that also aborts at the runtime deadline. */
  combined: AbortSignal;
  deadline: AbortSignal;
  approvals: ApprovalResolver;
  limits: ExecutionLimits;
}

type ProcessOutcome =
  | { kind: 'none' }
  | { kind: 'done' }
  | { kind: 'paused'; approvals: ApprovalRecord[] }
  | { kind: 'handoff' };

const READ_LIKE = new Set(['read', 'search', 'external', 'memory.read']);

function limitError(limit: string, value: number): LoopSmithError {
  return new LoopSmithError('limit_exceeded', `Execution limit reached: ${limit} (${value})`, {
    code: `limit_${limit}`,
    details: { limit, value },
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The LoopSmith agent loop.
 *
 *   goal → context → model → decision ─┬─ final answer      → finish
 *                                      ├─ tool calls        → policy → (approval | execute) → observe → loop
 *                                      ├─ agent.handoff     → switch owner agent → loop
 *                                      ├─ agent.delegate    → bounded child run → observe → loop
 *                                      └─ invalid response  → bounded recovery prompt → loop
 *
 * Every transition is persisted before it is acted on, so a run can be
 * paused (approvals), interrupted (crash, Ctrl-C) and resumed in another
 * process without repeating completed tool calls. Every loop is bounded.
 */
export class AgentRuntime {
  private readonly context: ContextManager;
  private readonly executor: ToolExecutor;
  private readonly defaultApprovals: ApprovalResolver;
  private readonly baseLimits: ExecutionLimits;

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.context = deps.context ?? new ContextManager();
    this.defaultApprovals = deps.approvals ?? new DeferApprovals();
    this.baseLimits = resolveLimits(deps.limits);
    this.executor = new ToolExecutor(deps.tools, {
      defaultTimeoutMs: this.baseLimits.toolTimeoutMs,
      maxOutputChars: this.baseLimits.maxToolOutputChars,
    });
  }

  get limits(): ExecutionLimits {
    return this.baseLimits;
  }

  /** Create and execute a new agent run. */
  async startRun(options: StartAgentRunOptions): Promise<AgentRunResult> {
    const { store } = this.deps;
    const agent = this.deps.agents.get(options.agentId);
    const sessionId =
      options.sessionId ?? store.createSession({ title: options.goal.slice(0, 80) }).id;
    const limits = resolveLimits(this.deps.limits, options.limits);
    const run = store.transaction(() => {
      const created = store.createRun({
        sessionId,
        kind: 'agent',
        goal: options.goal,
        agentId: agent.id,
        parentRunId: options.parentRunId ?? null,
        ...(options.rootRunId ? { rootRunId: options.rootRunId } : {}),
        nodeId: options.nodeId ?? null,
        workflowId: options.workflowId ?? null,
        delegationDepth: options.delegationDepth ?? 0,
        status: 'pending',
        config: {
          limits,
          ...(options.providerOverride ? { providerOverride: options.providerOverride } : {}),
          ...(options.workflowContext ? { workflowContext: options.workflowContext } : {}),
        },
      });
      store.appendMessage(created.id, { role: 'user', content: options.goal }, null);
      return created;
    });
    this.emit(run, 'run.started', {
      kind: 'agent',
      target: agent.id,
      goal: options.goal.slice(0, 500),
      parentRunId: run.parentRunId,
    });
    return this.execute(
      run.id,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.approvals ? { approvals: options.approvals } : {}),
      },
      false,
    );
  }

  /** Continue a paused or interrupted run. Completed tool calls are never repeated. */
  async resumeRun(runId: string, options: ExecuteOptions = {}): Promise<AgentRunResult> {
    const run = this.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return this.toResult(run);
    if (
      run.status === 'running' &&
      run.ownerPid &&
      run.ownerPid !== process.pid &&
      isProcessAlive(run.ownerPid)
    ) {
      throw new LoopSmithError(
        'configuration',
        `Run ${runId} is still active in process ${run.ownerPid}`,
        {
          code: 'run_active',
        },
      );
    }
    this.emit(run, 'run.resumed', {
      reason: run.status === 'running' ? 'interrupted' : run.status,
    });
    return this.execute(runId, options, true);
  }

  // ------------------------------------------------------------------ loop

  private async execute(
    runId: string,
    options: ExecuteOptions,
    _resumed: boolean,
  ): Promise<AgentRunResult> {
    const { store } = this.deps;
    let run = this.requireRun(runId);
    const limits = resolveLimits(
      this.baseLimits,
      run.config.limits as Partial<ExecutionLimits> | undefined,
    );
    const deadline = AbortSignal.timeout(limits.maxRuntimeMs);
    const ctx: ExecContext = {
      ...(options.signal ? { signal: options.signal } : {}),
      combined: anySignal(options.signal, deadline),
      deadline,
      approvals: options.approvals ?? this.defaultApprovals,
      limits,
    };
    const startedMs = Date.now();
    run = store.updateRun(runId, {
      status: 'running',
      ownerPid: process.pid,
      startedAt: run.startedAt ?? nowIso(),
    });

    // Hard safety cap on loop turns, on top of the per-limit checks below.
    const hardCap = limits.maxIterations * 2 + limits.maxRecoveryAttempts + limits.maxHandoffs + 4;
    try {
      for (let turn = 0; turn < hardCap; turn++) {
        this.checkInterrupts(ctx);
        run = this.requireRun(runId);
        const agent = this.deps.agents.get(run.agentId as string);

        // Phase A — resolve tool calls left by the previous assistant message.
        const outcome = await this.processToolCalls(run, agent, ctx);
        if (outcome.kind === 'paused') return this.pause(run, outcome.approvals);
        if (outcome.kind === 'handoff') continue;
        run = this.requireRun(runId);

        // Phase B — limits.
        const transcript = store.listMessages(runId);
        const agentTurn = transcript.filter(
          (m) => m.message.role === 'assistant' && m.agentId === agent.id,
        ).length;
        if (run.iteration >= limits.maxIterations)
          throw limitError('maxIterations', limits.maxIterations);
        if (agent.maxSteps !== undefined && agentTurn >= agent.maxSteps)
          throw limitError('agent.maxSteps', agent.maxSteps);

        // Phase C — context.
        const tools = this.toolSpecsFor(agent);
        const memories =
          agent.memory?.recall && this.deps.memory
            ? this.deps.memory.search(run.goal, {
                sessionId: run.sessionId,
                scope: agent.memory.scope,
                limit: agent.memory.maxItems,
              })
            : [];
        if (memories.length > 0 && agentTurn === 0)
          this.emit(run, 'memory.recalled', {
            count: memories.length,
            ids: memories.map((m) => m.id),
          });
        const summary = store.getLatestSummary(runId);
        const built = await this.context.build({
          runId,
          agent,
          transcript,
          compactedThroughSeq: run.compactedThroughSeq,
          ...(summary ? { summary } : {}),
          tools,
          ...(run.config.workflowContext
            ? { workflowContext: run.config.workflowContext as Record<string, unknown> }
            : {}),
          memories,
          budgetTokens: limits.contextBudgetTokens,
          signal: ctx.combined,
        });
        if (built.compaction) {
          const c = built.compaction;
          store.transaction(() => {
            store.saveSummary({
              runId,
              throughSeq: c.throughSeq,
              content: c.summary,
              strategy: c.strategy,
              tokensBefore: c.tokensBefore,
              tokensAfter: c.tokensAfter,
            });
            store.updateRun(runId, { compactedThroughSeq: c.throughSeq });
          });
          this.emit(run, 'context.compacted', {
            strategy: c.strategy,
            throughSeq: c.throughSeq,
            tokensBefore: c.tokensBefore,
            tokensAfter: c.tokensAfter,
            droppedMessages: c.droppedMessages,
          });
        }

        // Phase D — model request.
        const { provider, model } = this.deps.providers.resolve(
          agent.model,
          run.config.providerOverride as string | undefined,
        );
        if (agentTurn === 0 && turn === 0)
          this.emit(run, 'agent.selected', { provider: provider.name, model });
        const request: ModelRequest = {
          model,
          system: built.system,
          messages: built.messages,
          tools,
          maxOutputTokens: agent.model?.maxOutputTokens ?? this.deps.maxOutputTokens ?? 16_000,
          ...(agent.model?.temperature === undefined
            ? {}
            : { temperature: agent.model.temperature }),
          ...(agent.model?.providerOptions ? { providerOptions: agent.model.providerOptions } : {}),
          metadata: {
            runId,
            agentId: agent.id,
            iteration: run.iteration,
            agentTurn,
            sessionId: run.sessionId,
          },
        };
        run = store.updateRun(runId, { iteration: run.iteration + 1 });
        this.emit(run, 'model.request', {
          iteration: run.iteration,
          provider: provider.name,
          model,
          estimatedTokens: built.estimatedTokens,
          messages: built.messages.length,
          tools: tools.length,
          elidedToolOutputs: built.elidedToolOutputs,
        });
        const t0 = Date.now();
        let response: ModelResponse;
        try {
          response = await provider.complete(request, {
            signal: ctx.combined,
            observer: {
              onRetry: (e) => this.emit(run, 'model.retry', { ...e }),
              onFallback: (e) => this.emit(run, 'model.fallback', { ...e }),
            },
          });
        } catch (raw) {
          const err = toLoopSmithError(raw, 'provider_transient');
          this.emit(run, 'model.error', {
            category: err.category,
            message: err.message,
            provider: provider.name,
          });
          throw err;
        }
        this.emit(
          run,
          'model.response',
          {
            provider: response.provider,
            providerKind: provider.kind === 'composite' ? undefined : provider.kind,
            model: response.model,
            stopReason: response.stopReason,
            toolCalls: response.toolCalls.length,
            tools: response.toolCalls.map((c) => c.name),
            textChars: response.content.length,
            ...(response.usage ? { usage: response.usage } : {}),
          },
          Date.now() - t0,
        );
        if (response.usage) {
          store.updateRun(runId, {
            usage: {
              inputTokens: run.usage.inputTokens + response.usage.inputTokens,
              outputTokens: run.usage.outputTokens + response.usage.outputTokens,
              reported: true,
            },
          });
        }

        // Phase E — decision engine.
        if (response.stopReason === 'refusal') {
          store.appendMessage(runId, this.assistantMessage(response), agent.id);
          throw new LoopSmithError('model_refusal', 'The model declined the request', {
            details: { provider: response.provider },
          });
        }
        if (response.toolCalls.length > 0) {
          this.recordToolCalls(run, agent, response);
          continue;
        }
        const assistantRecord = store.appendMessage(
          runId,
          this.assistantMessage(response),
          agent.id,
        );
        const text = response.content.trim();
        if (response.stopReason === 'max_tokens' || response.stopReason === 'pause_turn') {
          this.recover(
            run,
            ctx,
            'truncated_response',
            'Your previous response was cut off. Continue, and keep the final answer concise.',
          );
          continue;
        }
        if (text === '') {
          this.recover(
            run,
            ctx,
            'empty_response',
            'Your previous response was empty. Either call a tool or give your final answer.',
          );
          continue;
        }
        let structured: unknown;
        if (agent.output?.format === 'json') {
          const parsed = extractJson(text);
          let issues: string[] = [];
          if (!parsed.ok) issues = [parsed.error];
          else if (agent.output.schema) {
            const check = agent.output.schema.safeParse(parsed.value);
            if (!check.success)
              issues = check.error.issues.map(
                (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
              );
            else structured = check.data;
          } else structured = parsed.value;
          if (issues.length > 0) {
            this.recover(
              run,
              ctx,
              'invalid_structured_output',
              `Your final answer did not match the required JSON format: ${issues.join('; ')}. Reply again with only the corrected JSON.`,
            );
            continue;
          }
        }
        return this.finish(run, agent, text, structured, assistantRecord.seq, startedMs);
      }
      throw limitError('loopTurns', hardCap);
    } catch (raw) {
      return this.fail(runId, raw, ctx, startedMs);
    }
  }

  // ------------------------------------------------------- tool processing

  private recordToolCalls(run: RunRecord, agent: AgentDefinition, response: ModelResponse): void {
    const { store } = this.deps;
    store.transaction(() => {
      const record = store.appendMessage(run.id, this.assistantMessage(response), agent.id);
      for (const call of response.toolCalls) {
        store.upsertToolCall(this.newToolCallRecord(run, agent, call, record.seq));
      }
    });
    for (const call of response.toolCalls) {
      this.emit(run, 'tool.requested', {
        tool: call.name,
        callId: call.id,
        arguments: call.arguments,
        ...(call.parseError ? { parseError: call.parseError } : {}),
      });
    }
  }

  private newToolCallRecord(
    run: RunRecord,
    agent: AgentDefinition,
    call: ToolCall,
    seq: number,
  ): ToolCallRecord {
    return {
      id: `${run.id}:${call.id}`,
      runId: run.id,
      modelCallId: call.id,
      messageSeq: seq,
      agentId: agent.id,
      toolName: call.name,
      arguments: call.arguments,
      status: 'requested',
      policyEffect: null,
      approvalId: null,
      childRunId: null,
      resultContent: null,
      isError: false,
      error: null,
      resultAppended: false,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      createdAt: nowIso(),
    };
  }

  private async processToolCalls(
    run: RunRecord,
    agent: AgentDefinition,
    ctx: ExecContext,
  ): Promise<ProcessOutcome> {
    const { store } = this.deps;
    const transcript = store.listMessages(run.id);
    const last = [...transcript].reverse().find((m) => m.message.role === 'assistant') as
      MessageRecord | undefined;
    const message = last?.message as AssistantMessage | undefined;
    if (!last || !message?.toolCalls?.length) return { kind: 'none' };

    const existing = new Map(
      store
        .listToolCalls(run.id)
        .filter((r) => r.messageSeq === last.seq)
        .map((r) => [r.modelCallId, r]),
    );
    const owner = last.agentId ? this.deps.agents.get(last.agentId) : agent;
    const paused: ApprovalRecord[] = [];
    let handoff: { to: string; reason: string; payload: unknown } | undefined;

    for (const call of message.toolCalls) {
      let record = existing.get(call.id);
      if (!record) {
        record = this.newToolCallRecord(run, owner, call, last.seq);
        store.upsertToolCall(record);
      }
      if (record.resultAppended) continue;

      switch (record.status) {
        case 'completed':
        case 'failed':
        case 'denied':
        case 'rejected':
          this.appendResult(run, record);
          break;
        case 'requested': {
          const result = await this.dispatch(run, owner, call, record, ctx, handoff !== undefined);
          if (result.kind === 'paused') paused.push(...result.approvals);
          if (result.kind === 'handoff') handoff = result.handoff;
          break;
        }
        case 'awaiting_approval': {
          const approval = record.approvalId ? store.getApproval(record.approvalId) : undefined;
          if (!approval || approval.status === 'pending') {
            if (approval) paused.push(approval);
            break;
          }
          if (approval.status === 'rejected') {
            this.rejectCall(run, owner, record, approval);
          } else {
            const prepared = this.executor.prepare(call);
            if (!prepared.ok) this.completeWithError(run, owner, record, prepared.error, 'failed');
            else await this.executeTool(run, owner, record, prepared.tool, prepared.input, ctx);
          }
          break;
        }
        case 'executing': {
          // The process died mid-execution: the outcome is unknown.
          const tool = this.deps.tools.get(record.toolName);
          if (tool?.idempotent) {
            this.emit(run, 'recovery.attempted', {
              reason: 'interrupted_tool',
              tool: record.toolName,
              attempt: 1,
              action: 're-executing idempotent tool',
            });
            const prepared = this.executor.prepare(call);
            if (prepared.ok)
              await this.executeTool(run, owner, record, prepared.tool, prepared.input, ctx);
            else this.completeWithError(run, owner, record, prepared.error, 'failed');
          } else {
            this.emit(run, 'recovery.attempted', {
              reason: 'interrupted_tool',
              tool: record.toolName,
              attempt: 1,
              action: 'not retried: non-idempotent side effect',
            });
            this.completeWithError(
              run,
              owner,
              record,
              new LoopSmithError(
                'tool_execution',
                `Execution of ${record.toolName} was interrupted; its outcome is unknown and it was not retried automatically because it has side effects. Verify the state before trying again.`,
                { code: 'interrupted_unknown_outcome' },
              ),
              'failed',
            );
          }
          break;
        }
        case 'awaiting_child': {
          const result = await this.continueDelegation(run, owner, record, ctx);
          if (result.kind === 'paused') paused.push(...result.approvals);
          break;
        }
      }
    }

    if (paused.length > 0) return { kind: 'paused', approvals: paused };
    if (handoff) {
      this.applyHandoff(run, owner, handoff);
      return { kind: 'handoff' };
    }
    return { kind: 'done' };
  }

  private async dispatch(
    run: RunRecord,
    agent: AgentDefinition,
    call: ToolCall,
    record: ToolCallRecord,
    ctx: ExecContext,
    handoffAlreadyRequested: boolean,
  ): Promise<
    | { kind: 'done' }
    | { kind: 'paused'; approvals: ApprovalRecord[] }
    | { kind: 'handoff'; handoff: { to: string; reason: string; payload: unknown } }
  > {
    const { store } = this.deps;
    if (META_TOOLS.has(call.name)) {
      const decision = this.deps.policy.evaluate({
        toolName: call.name,
        category: 'orchestration',
        agent: { ...agent, tools: [...agent.tools, ...META_TOOLS] },
      });
      if (decision.effect !== 'allow') {
        this.completeWithError(
          run,
          agent,
          record,
          new LoopSmithError('permission_denied', decision.reason),
          'denied',
        );
        return { kind: 'done' };
      }
      if (call.name === HANDOFF_TOOL)
        return this.requestHandoff(run, agent, call, record, handoffAlreadyRequested);
      return this.delegate(run, agent, call, record, ctx);
    }

    const current = this.requireRun(run.id);
    if (current.toolCallCount >= ctx.limits.maxToolCalls)
      throw limitError('maxToolCalls', ctx.limits.maxToolCalls);

    const tool = this.deps.tools.get(call.name);
    if (!tool) {
      const prepared = this.executor.prepare(call);
      this.completeWithError(
        run,
        agent,
        record,
        prepared.ok ? new LoopSmithError('unknown_tool', call.name) : prepared.error,
        'failed',
      );
      return { kind: 'done' };
    }

    const decision = this.deps.policy.evaluate({
      toolName: tool.name,
      category: tool.category,
      agent,
    });
    record.policyEffect = decision.effect;
    store.upsertToolCall(record);
    this.emit(run, 'tool.policy', {
      tool: tool.name,
      callId: call.id,
      effect: decision.effect,
      rule: decision.rule,
      reason: decision.reason,
    });
    if (decision.effect === 'deny') {
      this.emit(run, 'tool.denied', { tool: tool.name, callId: call.id, reason: decision.reason });
      this.completeWithError(
        run,
        agent,
        record,
        new LoopSmithError('permission_denied', decision.reason),
        'denied',
      );
      return { kind: 'done' };
    }

    const prepared = this.executor.prepare(call);
    if (!prepared.ok) {
      this.completeWithError(run, agent, record, prepared.error, 'failed');
      return { kind: 'done' };
    }

    if (decision.effect === 'require_approval') {
      const approval = store.transaction(() => {
        const created = store.createApproval({
          runId: run.id,
          rootRunId: run.rootRunId,
          kind: 'tool',
          toolCallId: record.id,
          toolName: tool.name,
          arguments: prepared.input,
          agentId: agent.id,
          nodeId: run.nodeId,
          reason: decision.reason,
        });
        record.status = 'awaiting_approval';
        record.approvalId = created.id;
        store.upsertToolCall(record);
        return created;
      });
      this.emit(run, 'approval.requested', {
        approvalId: approval.id,
        tool: tool.name,
        callId: call.id,
        summary: summarizeApproval(approval),
      });
      const outcome = await ctx.approvals.resolve(approval);
      if (outcome.decision === 'defer') return { kind: 'paused', approvals: [approval] };
      const decided = store.decideApproval(approval.id, {
        status: outcome.decision,
        by: outcome.by,
        ...(outcome.note ? { note: outcome.note } : {}),
      });
      this.emit(run, 'approval.decided', {
        approvalId: decided.id,
        status: decided.status,
        by: decided.decidedBy,
        tool: tool.name,
      });
      if (decided.status === 'rejected') {
        this.rejectCall(run, agent, record, decided);
        return { kind: 'done' };
      }
      this.emit(run, 'tool.approved', { tool: tool.name, callId: call.id, approvalId: decided.id });
    }

    await this.executeTool(run, agent, record, prepared.tool, prepared.input, ctx);
    return { kind: 'done' };
  }

  private async executeTool(
    run: RunRecord,
    agent: AgentDefinition,
    record: ToolCallRecord,
    tool: RegisteredTool,
    input: unknown,
    ctx: ExecContext,
  ): Promise<void> {
    const { store } = this.deps;
    const current = this.requireRun(run.id);
    if (current.toolCallCount >= ctx.limits.maxToolCalls)
      throw limitError('maxToolCalls', ctx.limits.maxToolCalls);
    store.transaction(() => {
      record.status = 'executing';
      record.startedAt = nowIso();
      store.upsertToolCall(record);
      store.updateRun(run.id, { toolCallCount: current.toolCallCount + 1 });
    });
    this.emit(run, 'tool.started', {
      tool: tool.name,
      callId: record.modelCallId,
      arguments: input,
    });

    const result = await this.executor.execute(tool, input, {
      runId: run.id,
      sessionId: run.sessionId,
      agentId: agent.id,
      toolCallId: record.id,
      signal: ctx.combined,
      ...(this.deps.workspace ? { workspace: this.deps.workspace } : {}),
      ...(this.deps.memory ? { memory: this.deps.memory } : {}),
    });

    let content = result.content;
    if (result.ok && READ_LIKE.has(tool.category)) {
      const signals = detectInjectionSignals(content);
      if (signals.length > 0) {
        this.emit(run, 'security.flagged', {
          source: tool.name,
          callId: record.modelCallId,
          signal: signals.join(', '),
        });
        content = `${UNTRUSTED_NOTICE}\n${content}`;
      }
    }
    if (result.ok && tool.name === 'memory.store') {
      this.emit(run, 'memory.stored', {
        content: String((input as { content?: string }).content ?? '').slice(0, 200),
      });
    }

    record.status = result.ok ? 'completed' : 'failed';
    record.resultContent = content;
    record.isError = !result.ok;
    record.error = result.error ?? null;
    record.endedAt = nowIso();
    record.durationMs = result.durationMs;
    store.upsertToolCall(record);
    this.emit(
      run,
      result.ok ? 'tool.completed' : 'tool.failed',
      {
        tool: tool.name,
        callId: record.modelCallId,
        arguments: input,
        ...(result.ok
          ? { outputChars: result.content.length, truncated: result.truncated }
          : { category: result.error?.category, message: result.error?.message }),
      },
      result.durationMs,
    );
    this.appendResult(run, record);
  }

  private completeWithError(
    run: RunRecord,
    agent: AgentDefinition,
    record: ToolCallRecord,
    error: unknown,
    status: 'failed' | 'denied' | 'rejected',
  ): void {
    const serialized = serializeError(error);
    record.status = status;
    record.isError = true;
    record.error = serialized;
    record.resultContent = safeStringify({
      error: { category: serialized.category, message: serialized.message },
    });
    record.endedAt = nowIso();
    this.deps.store.upsertToolCall(record);
    if (status === 'failed') {
      this.emit(
        run,
        'tool.failed',
        {
          tool: record.toolName,
          callId: record.modelCallId,
          arguments: record.arguments,
          category: serialized.category,
          message: serialized.message,
        },
        0,
      );
    }
    this.appendResult(run, record);
    void agent;
  }

  private rejectCall(
    run: RunRecord,
    agent: AgentDefinition,
    record: ToolCallRecord,
    approval: ApprovalRecord,
  ): void {
    this.emit(run, 'tool.rejected', {
      tool: record.toolName,
      callId: record.modelCallId,
      approvalId: approval.id,
      by: approval.decidedBy,
    });
    this.completeWithError(
      run,
      agent,
      record,
      new LoopSmithError(
        'approval_rejected',
        `A human rejected this ${record.toolName} call${approval.decisionNote ? `: ${approval.decisionNote}` : ''}. Do not retry it; adapt your plan.`,
      ),
      'rejected',
    );
  }

  /** Append a tool result to the transcript exactly once (idempotent). */
  private appendResult(run: RunRecord, record: ToolCallRecord): void {
    if (record.resultAppended) return;
    const { store } = this.deps;
    store.transaction(() => {
      store.appendMessage(
        run.id,
        {
          role: 'tool',
          toolCallId: record.modelCallId,
          toolName: record.toolName,
          content: record.resultContent ?? '',
          isError: record.isError,
        },
        record.agentId,
      );
      record.resultAppended = true;
      store.upsertToolCall(record);
    });
  }

  // --------------------------------------------------- multi-agent control

  private transfersUsed(run: RunRecord): number {
    return this.deps.store.listHandoffs(run.rootRunId).length;
  }

  private requestHandoff(
    run: RunRecord,
    agent: AgentDefinition,
    call: ToolCall,
    record: ToolCallRecord,
    alreadyRequested: boolean,
  ):
    | { kind: 'done' }
    | { kind: 'handoff'; handoff: { to: string; reason: string; payload: unknown } } {
    const targets = agent.handoffs ?? [];
    const fail = (message: string): { kind: 'done' } => {
      this.completeWithError(
        run,
        agent,
        record,
        new LoopSmithError('permission_denied', message),
        'denied',
      );
      return { kind: 'done' };
    };
    if (targets.length === 0) return fail(`${agent.id} has no handoff targets`);
    if (alreadyRequested) return fail('Only one handoff per turn is allowed');
    const parsed = parseMeta(handoffSchema(targets as [string, ...string[]]), call.arguments);
    if (!parsed.ok) {
      this.completeWithError(
        run,
        agent,
        record,
        new LoopSmithError('invalid_tool_arguments', parsed.issues.join('; ')),
        'failed',
      );
      return { kind: 'done' };
    }
    const limits = resolveLimits(this.baseLimits, run.config.limits as Partial<ExecutionLimits>);
    if (this.transfersUsed(run) >= limits.maxHandoffs) {
      this.emit(run, 'limit.exceeded', { limit: 'maxHandoffs', value: limits.maxHandoffs });
      return fail(`Handoff limit reached (${limits.maxHandoffs}); finish the task yourself`);
    }
    if (!this.deps.agents.has(parsed.value.agent))
      return fail(`Unknown agent ${parsed.value.agent}`);
    record.status = 'completed';
    record.resultContent = safeStringify({ handoff: 'accepted', to: parsed.value.agent });
    record.endedAt = nowIso();
    this.deps.store.upsertToolCall(record);
    this.appendResult(run, record);
    return {
      kind: 'handoff',
      handoff: {
        to: parsed.value.agent,
        reason: parsed.value.reason,
        payload: parsed.value.payload ?? null,
      },
    };
  }

  private applyHandoff(
    run: RunRecord,
    from: AgentDefinition,
    handoff: { to: string; reason: string; payload: unknown },
  ): void {
    const { store } = this.deps;
    const current = this.requireRun(run.id);
    store.transaction(() => {
      store.recordHandoff({
        rootRunId: run.rootRunId,
        runId: run.id,
        kind: 'handoff',
        fromAgent: from.id,
        toAgent: handoff.to,
        reason: handoff.reason,
        payload: handoff.payload,
        depth: run.delegationDepth,
        childRunId: null,
      });
      store.updateRun(run.id, { agentId: handoff.to, handoffCount: current.handoffCount + 1 });
      store.appendMessage(
        run.id,
        {
          role: 'user',
          synthetic: 'handoff',
          content:
            `[Handoff from ${from.id} to ${handoff.to}]\nReason: ${handoff.reason}\n` +
            (handoff.payload ? `Handoff payload (data): ${safeStringify(handoff.payload)}\n` : '') +
            `You (${handoff.to}) now own this task and its final answer. Continue from the conversation above.`,
        },
        null,
      );
    });
    this.emit(run, 'agent.handoff', { from: from.id, to: handoff.to, reason: handoff.reason });
  }

  private async delegate(
    run: RunRecord,
    agent: AgentDefinition,
    call: ToolCall,
    record: ToolCallRecord,
    ctx: ExecContext,
  ): Promise<{ kind: 'done' } | { kind: 'paused'; approvals: ApprovalRecord[] }> {
    const { store } = this.deps;
    const targets = agent.delegates ?? [];
    const deny = (message: string): { kind: 'done' } => {
      this.completeWithError(
        run,
        agent,
        record,
        new LoopSmithError('permission_denied', message),
        'denied',
      );
      return { kind: 'done' };
    };
    if (targets.length === 0) return deny(`${agent.id} has no delegation targets`);
    const parsed = parseMeta(delegateSchema(targets as [string, ...string[]]), call.arguments);
    if (!parsed.ok) {
      this.completeWithError(
        run,
        agent,
        record,
        new LoopSmithError('invalid_tool_arguments', parsed.issues.join('; ')),
        'failed',
      );
      return { kind: 'done' };
    }
    if (run.delegationDepth + 1 > ctx.limits.maxDelegationDepth) {
      this.emit(run, 'limit.exceeded', {
        limit: 'maxDelegationDepth',
        value: ctx.limits.maxDelegationDepth,
      });
      return deny(
        `Delegation depth limit reached (${ctx.limits.maxDelegationDepth}); do the work yourself`,
      );
    }
    if (this.transfersUsed(run) >= ctx.limits.maxHandoffs) {
      this.emit(run, 'limit.exceeded', { limit: 'maxHandoffs', value: ctx.limits.maxHandoffs });
      return deny(`Handoff/delegation limit reached (${ctx.limits.maxHandoffs})`);
    }
    const target = parsed.value.agent;
    const goal = parsed.value.context
      ? `${parsed.value.task}\n\nContext from ${agent.id} (data):\n${parsed.value.context}`
      : parsed.value.task;

    // Persist intent *before* starting the child so a crash can be resumed.
    const childRun = store.transaction(() => {
      const child = store.createRun({
        sessionId: run.sessionId,
        kind: 'agent',
        goal,
        agentId: target,
        parentRunId: run.id,
        rootRunId: run.rootRunId,
        nodeId: run.nodeId,
        workflowId: run.workflowId,
        delegationDepth: run.delegationDepth + 1,
        status: 'pending',
        config: { ...run.config },
      });
      store.appendMessage(child.id, { role: 'user', content: goal, synthetic: 'delegation' }, null);
      record.status = 'awaiting_child';
      record.childRunId = child.id;
      record.startedAt = nowIso();
      store.upsertToolCall(record);
      store.recordHandoff({
        rootRunId: run.rootRunId,
        runId: run.id,
        kind: 'delegation',
        fromAgent: agent.id,
        toAgent: target,
        reason: parsed.value.task.slice(0, 500),
        payload: parsed.value.context ?? null,
        depth: run.delegationDepth + 1,
        childRunId: child.id,
      });
      return child;
    });
    this.emit(run, 'agent.delegation.started', {
      to: target,
      task: parsed.value.task,
      childRunId: childRun.id,
    });
    this.emit(childRun, 'run.started', {
      kind: 'agent',
      target,
      goal: goal.slice(0, 300),
      parentRunId: run.id,
    });
    const result = await this.execute(
      childRun.id,
      { ...(ctx.signal ? { signal: ctx.signal } : {}), approvals: ctx.approvals },
      false,
    );
    return this.settleDelegation(run, agent, record, result);
  }

  private async continueDelegation(
    run: RunRecord,
    agent: AgentDefinition,
    record: ToolCallRecord,
    ctx: ExecContext,
  ): Promise<{ kind: 'done' } | { kind: 'paused'; approvals: ApprovalRecord[] }> {
    const child = record.childRunId ? this.deps.store.getRun(record.childRunId) : undefined;
    if (!child) {
      this.completeWithError(
        run,
        agent,
        record,
        new LoopSmithError('internal', 'Delegated run is missing'),
        'failed',
      );
      return { kind: 'done' };
    }
    const result = TERMINAL_RUN_STATUSES.has(child.status)
      ? this.toResult(child)
      : await this.resumeRun(child.id, {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          approvals: ctx.approvals,
        });
    return this.settleDelegation(run, agent, record, result);
  }

  private settleDelegation(
    run: RunRecord,
    agent: AgentDefinition,
    record: ToolCallRecord,
    result: AgentRunResult,
  ): { kind: 'done' } | { kind: 'paused'; approvals: ApprovalRecord[] } {
    if (result.status === 'awaiting_approval')
      return { kind: 'paused', approvals: result.pendingApprovals };
    if (result.status === 'cancelled')
      throw new LoopSmithError('cancelled', 'Delegated run was cancelled');
    this.emit(run, 'agent.delegation.completed', {
      to: result.agentId,
      status: result.status,
      childRunId: result.runId,
    });
    if (result.status === 'failed') {
      this.completeWithError(
        run,
        agent,
        record,
        new LoopSmithError(
          'tool_execution',
          `Delegated agent ${result.agentId} failed: ${result.error?.message ?? 'unknown error'}`,
        ),
        'failed',
      );
      return { kind: 'done' };
    }
    record.status = 'completed';
    record.resultContent = safeStringify(
      { agent: result.agentId, status: result.status, output: result.structured ?? result.output },
      2,
    );
    record.endedAt = nowIso();
    this.deps.store.upsertToolCall(record);
    this.appendResult(run, record);
    return { kind: 'done' };
  }

  // ------------------------------------------------------------- outcomes

  private recover(run: RunRecord, ctx: ExecContext, reason: string, instruction: string): void {
    const current = this.requireRun(run.id);
    if (current.recoveryCount >= ctx.limits.maxRecoveryAttempts) {
      throw new LoopSmithError(
        'invalid_model_response',
        `Model response could not be used (${reason}) after ${current.recoveryCount} recovery attempts`,
        {
          code: reason,
        },
      );
    }
    this.deps.store.transaction(() => {
      this.deps.store.updateRun(run.id, { recoveryCount: current.recoveryCount + 1 });
      this.deps.store.appendMessage(
        run.id,
        { role: 'user', synthetic: 'recovery', content: `[LoopSmith runtime] ${instruction}` },
        null,
      );
    });
    this.emit(run, 'recovery.attempted', { reason, attempt: current.recoveryCount + 1 });
  }

  private pause(run: RunRecord, approvals: ApprovalRecord[]): AgentRunResult {
    const updated = this.deps.store.updateRun(run.id, {
      status: 'awaiting_approval',
      ownerPid: null,
    });
    this.emit(updated, 'run.paused', {
      reason: 'awaiting_approval',
      approvals: approvals.map((a) => a.id),
    });
    return { ...this.toResult(updated), pendingApprovals: approvals };
  }

  private finish(
    run: RunRecord,
    agent: AgentDefinition,
    text: string,
    structured: unknown,
    seq: number,
    startedMs: number,
  ): AgentRunResult {
    const updated = this.deps.store.updateRun(run.id, {
      status: 'completed',
      output: {
        text,
        ...(structured === undefined ? {} : { structured }),
        finalAgentId: agent.id,
        messageSeq: seq,
      },
      endedAt: nowIso(),
      ownerPid: null,
    });
    this.emit(
      updated,
      'run.completed',
      { finalAgentId: agent.id, iterations: updated.iteration, toolCalls: updated.toolCallCount },
      Date.now() - startedMs,
    );
    return this.toResult(updated);
  }

  private fail(runId: string, raw: unknown, ctx: ExecContext, startedMs: number): AgentRunResult {
    let err = toLoopSmithError(raw);
    if (err.category === 'cancelled' && ctx.deadline.aborted && !ctx.signal?.aborted) {
      err = limitError('maxRuntimeMs', ctx.limits.maxRuntimeMs);
    }
    const cancelled = err.category === 'cancelled';
    const serialized = serializeError(err);
    const run = this.deps.store.updateRun(runId, {
      status: cancelled ? 'cancelled' : 'failed',
      error: serialized,
      endedAt: nowIso(),
      ownerPid: null,
    });
    if (err.category === 'limit_exceeded')
      this.emit(run, 'limit.exceeded', { limit: err.details.limit, value: err.details.value });
    this.emit(
      run,
      cancelled ? 'run.cancelled' : 'run.failed',
      { error: serialized },
      Date.now() - startedMs,
    );
    return this.toResult(run);
  }

  toResult(run: RunRecord): AgentRunResult {
    const output = run.output as {
      text?: string;
      structured?: unknown;
      finalAgentId?: string;
    } | null;
    const status: AgentRunStatus =
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'cancelled' ||
      run.status === 'awaiting_approval'
        ? run.status
        : 'failed';
    const result: AgentRunResult = {
      runId: run.id,
      rootRunId: run.rootRunId,
      sessionId: run.sessionId,
      status,
      agentId: output?.finalAgentId ?? run.agentId ?? 'unknown',
      output: output?.text ?? null,
      pendingApprovals: status === 'awaiting_approval' ? this.pendingApprovalsFor(run) : [],
    };
    if (output?.structured !== undefined) result.structured = output.structured;
    if (run.error) result.error = run.error;
    return result;
  }

  /** Pending approvals for a run, including those of delegated child runs. */
  private pendingApprovalsFor(run: RunRecord): ApprovalRecord[] {
    const { store } = this.deps;
    const ids = new Set<string>([run.id]);
    for (const child of store.listRuns({ rootRunId: run.rootRunId, limit: 10_000 })) {
      if (child.parentRunId && ids.has(child.parentRunId)) ids.add(child.id);
    }
    return store
      .listApprovals({ status: 'pending', rootRunId: run.rootRunId })
      .filter((a) => ids.has(a.runId));
  }

  // --------------------------------------------------------------- helpers

  private checkInterrupts(ctx: ExecContext): void {
    throwIfAborted(ctx.signal, 'Run');
    if (ctx.deadline.aborted) throw limitError('maxRuntimeMs', ctx.limits.maxRuntimeMs);
  }

  /** Tools the model may see: allow-listed, not policy-denied, plus meta tools. */
  toolSpecsFor(agent: AgentDefinition): ToolSpec[] {
    const visible = this.deps.tools
      .forPatterns(agent.tools)
      .filter(
        (tool) =>
          this.deps.policy.evaluate({ toolName: tool.name, category: tool.category, agent })
            .effect !== 'deny',
      );
    return [...this.deps.tools.specs(visible), ...metaToolSpecs(agent)];
  }

  private assistantMessage(response: ModelResponse): AssistantMessage {
    const message: AssistantMessage = { role: 'assistant', content: response.content };
    if (response.toolCalls.length > 0) message.toolCalls = response.toolCalls;
    if (response.providerState) message.providerState = response.providerState;
    return message;
  }

  private requireRun(runId: string): RunRecord {
    const run = this.deps.store.getRun(runId);
    if (!run) throw new LoopSmithError('storage', `Run not found: ${runId}`);
    return run;
  }

  private emit(
    run: RunRecord,
    type: RuntimeEventType,
    data: Record<string, unknown>,
    durationMs?: number,
  ): void {
    this.deps.events.emit({
      type,
      sessionId: run.sessionId,
      runId: run.id,
      rootRunId: run.rootRunId,
      ...(run.agentId ? { agentId: run.agentId } : {}),
      ...(run.nodeId ? { nodeId: run.nodeId } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      data: { ...data, depth: run.delegationDepth },
    });
  }
}
