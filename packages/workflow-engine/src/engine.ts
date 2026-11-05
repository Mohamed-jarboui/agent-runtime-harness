import {
  LoopSmithError,
  TERMINAL_RUN_STATUSES,
  nowIso,
  serializeError,
  sleep,
  throwIfAborted,
  toLoopSmithError,
  type ApprovalRecord,
  type CheckpointRecord,
  type EventSink,
  type RunRecord,
  type RuntimeEventType,
  type SerializedError,
  type StateStore,
} from '@loopsmith/core';
import type { WorkflowDefinition, WorkflowNode } from './definition.js';
import { renderTemplate, renderValue, resolveTransition, type TemplateScope } from './template.js';

export type NodeOutcome =
  | { status: 'completed'; output: unknown; ref?: string }
  | { status: 'paused'; ref: string; approvals: ApprovalRecord[] }
  | { status: 'failed'; error: SerializedError; retryable: boolean; ref?: string };

export interface NodeRequestBase {
  workflowRunId: string;
  rootRunId: string;
  sessionId: string;
  nodeId: string;
  attempt: number;
  /** Set when resuming a node that previously paused. */
  resumeRef?: string;
  signal?: AbortSignal;
}

/**
 * The engine is provider-agnostic: it only knows how to sequence nodes.
 * Agents, tools and approvals are executed through these injected services
 * (implemented by `@loopsmith/orchestration` on top of the agent runtime).
 */
export interface WorkflowServices {
  runAgent(
    request: NodeRequestBase & {
      agentId: string;
      prompt: string;
      context: Record<string, unknown>;
    },
  ): Promise<NodeOutcome>;
  runTool(request: NodeRequestBase & { tool: string; args: unknown }): Promise<NodeOutcome>;
  requestApproval(
    request: NodeRequestBase & { prompt: string },
  ): Promise<{ status: 'approved' | 'rejected' | 'pending'; approval: ApprovalRecord }>;
}

export type CodeHandler = (context: {
  state: Record<string, unknown>;
  goal: string;
  input: unknown;
  nodeId: string;
}) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface WorkflowResult {
  runId: string;
  sessionId: string;
  workflowId: string;
  status: 'completed' | 'awaiting_approval' | 'failed' | 'cancelled';
  output: string | null;
  state: Record<string, unknown>;
  pendingApprovals: ApprovalRecord[];
  error?: SerializedError;
  steps: number;
}

export interface WorkflowEngineDeps {
  store: StateStore;
  events: EventSink;
  services: WorkflowServices;
  resolveWorkflow: (id: string) => WorkflowDefinition;
  handlers?: Record<string, CodeHandler>;
}

export interface StartWorkflowOptions {
  workflow: WorkflowDefinition;
  goal: string;
  sessionId?: string;
  input?: unknown;
  config?: Record<string, unknown>;
  signal?: AbortSignal;
}

type Checkpoint = Omit<CheckpointRecord, 'id' | 'seq' | 'createdAt'>;

/**
 * Checkpointed workflow executor.
 *
 * After every node the full workflow state (current node, state object, visit
 * counts, history) is checkpointed. A paused or interrupted run resumes from
 * the last checkpoint, re-entering a paused node with its stored reference so
 * nothing that already completed is executed twice. Loops are bounded by
 * per-node `maxVisits` and the workflow-wide `maxSteps`.
 */
export class WorkflowEngine {
  private readonly handlers = new Map<string, CodeHandler>();

  constructor(private readonly deps: WorkflowEngineDeps) {
    for (const [name, fn] of Object.entries(deps.handlers ?? {})) this.handlers.set(name, fn);
  }

  registerHandler(name: string, handler: CodeHandler): void {
    this.handlers.set(name, handler);
  }

  async start(options: StartWorkflowOptions): Promise<WorkflowResult> {
    const { store } = this.deps;
    const def = options.workflow;
    const sessionId =
      options.sessionId ?? store.createSession({ title: options.goal.slice(0, 80) }).id;
    const run = store.createRun({
      sessionId,
      kind: 'workflow',
      goal: options.goal,
      workflowId: def.id,
      input: options.input ?? null,
      status: 'pending',
      config: { ...(options.config ?? {}), workflowVersion: def.version },
    });
    this.emit(run, 'run.started', {
      kind: 'workflow',
      target: def.id,
      goal: options.goal.slice(0, 500),
    });
    this.emit(run, 'workflow.started', {
      workflowId: def.id,
      version: def.version,
      start: def.start,
    });
    const initial: Checkpoint = {
      workflowRunId: run.id,
      nodeId: def.start,
      status: 'running',
      state: { ...(def.initialState ?? {}) },
      visits: {},
      step: 0,
      history: [],
      pending: null,
    };
    store.saveCheckpoint(initial);
    return this.execute(run, def, initial, options.signal);
  }

  async resume(
    workflowRunId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkflowResult> {
    const { store } = this.deps;
    const run = store.getRun(workflowRunId);
    if (!run || run.kind !== 'workflow' || !run.workflowId) {
      throw new LoopSmithError('configuration', `Not a workflow run: ${workflowRunId}`);
    }
    const checkpoint = store.getLatestCheckpoint(workflowRunId);
    if (!checkpoint)
      throw new LoopSmithError('storage', `No checkpoint for workflow run ${workflowRunId}`);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return this.result(run, checkpoint);
    const def = this.deps.resolveWorkflow(run.workflowId);
    this.emit(run, 'workflow.resumed', {
      nodeId: checkpoint.nodeId,
      step: checkpoint.step,
      pending: checkpoint.pending?.kind ?? null,
    });
    return this.execute(run, def, checkpoint, options.signal);
  }

  private async execute(
    run: RunRecord,
    def: WorkflowDefinition,
    from: Checkpoint,
    signal?: AbortSignal,
  ): Promise<WorkflowResult> {
    const { store } = this.deps;
    const startedMs = Date.now();
    store.updateRun(run.id, {
      status: 'running',
      ownerPid: process.pid,
      startedAt: run.startedAt ?? nowIso(),
    });
    let cp: Checkpoint = {
      ...from,
      state: { ...from.state },
      visits: { ...from.visits },
      history: [...from.history],
    };

    try {
      while (cp.step < def.maxSteps) {
        throwIfAborted(signal, 'Workflow');
        const nodeId = cp.nodeId as string;
        const node = def.nodes[nodeId];
        if (!node) throw new LoopSmithError('workflow', `Unknown node "${nodeId}"`);
        const scope: TemplateScope = { goal: run.goal, state: cp.state, input: run.input };

        if (node.type === 'end') return this.complete(run, def, cp, node, scope, startedMs);

        const resuming = cp.pending?.nodeId === nodeId ? cp.pending : null;
        if (!resuming) {
          const visits = (cp.visits[nodeId] ?? 0) + 1;
          const maxVisits = node.maxVisits ?? def.defaultMaxVisits ?? 5;
          if (visits > maxVisits) {
            this.emit(
              run,
              'limit.exceeded',
              { limit: 'maxVisits', node: nodeId, value: maxVisits },
              nodeId,
            );
            if (!node.onMaxVisits)
              throw new LoopSmithError(
                'limit_exceeded',
                `Node "${nodeId}" exceeded maxVisits (${maxVisits})`,
                { details: { limit: 'maxVisits', value: maxVisits } },
              );
            cp = this.advance(run, cp, nodeId, 'max_visits', node.onMaxVisits);
            continue;
          }
          cp.visits[nodeId] = visits;
          this.emit(
            run,
            'workflow.node.started',
            { nodeType: node.type, target: this.target(node), visit: visits, step: cp.step },
            nodeId,
          );
        }

        const attemptsAllowed = node.retry?.maxAttempts ?? 1;
        let attempt = resuming?.attempt ?? 1;
        let outcome: NodeOutcome | undefined;
        let approvalDecision: 'approved' | 'rejected' | undefined;
        const nodeStarted = Date.now();
        for (; attempt <= attemptsAllowed; attempt++) {
          const ref = attempt === (resuming?.attempt ?? 1) ? resuming?.ref : undefined;
          const base = {
            workflowRunId: run.id,
            rootRunId: run.rootRunId,
            sessionId: run.sessionId,
            nodeId,
            attempt,
            ...(ref ? { resumeRef: ref } : {}),
            ...(signal ? { signal } : {}),
          };
          if (node.type === 'approval') {
            const res = await this.deps.services.requestApproval({
              ...base,
              prompt: renderTemplate(node.prompt, scope),
            });
            if (res.status === 'pending')
              outcome = { status: 'paused', ref: res.approval.id, approvals: [res.approval] };
            else {
              approvalDecision = res.status;
              outcome = { status: 'completed', output: res.status, ref: res.approval.id };
            }
          } else {
            outcome = await this.runNode(node, nodeId, scope, base);
          }
          if (outcome.status !== 'failed' || !outcome.retryable || attempt >= attemptsAllowed)
            break;
          const delay = (node.retry?.backoffMs ?? 0) * 2 ** (attempt - 1);
          this.emit(
            run,
            'workflow.node.retry',
            { attempt: attempt + 1, delayMs: delay, error: outcome.error.message },
            nodeId,
          );
          if (delay > 0) await sleep(delay, signal);
        }
        if (!outcome) throw new LoopSmithError('internal', 'Node produced no outcome');

        if (outcome.status === 'paused') {
          cp = {
            ...cp,
            status: 'awaiting_approval',
            pending: {
              nodeId,
              kind: node.type === 'approval' ? 'approval' : node.type === 'tool' ? 'tool' : 'agent',
              ref: outcome.ref,
              attempt,
            },
          };
          store.saveCheckpoint(cp);
          const paused = store.updateRun(run.id, { status: 'awaiting_approval', ownerPid: null });
          this.emit(
            run,
            'workflow.paused',
            { nodeId, reason: 'awaiting_approval', approvals: outcome.approvals.map((a) => a.id) },
            nodeId,
          );
          this.emit(run, 'run.paused', {
            reason: 'awaiting_approval',
            approvals: outcome.approvals.map((a) => a.id),
          });
          return this.result(paused, cp, outcome.approvals);
        }

        if (outcome.status === 'failed') {
          this.emit(
            run,
            'workflow.node.failed',
            { message: outcome.error.message, category: outcome.error.category, attempts: attempt },
            nodeId,
          );
          if (!node.onError)
            throw new LoopSmithError(
              outcome.error.category,
              `Node "${nodeId}" failed: ${outcome.error.message}`,
              { details: { nodeId } },
            );
          cp.state = { ...cp.state, lastError: { nodeId, ...outcome.error } };
          cp = this.advance(run, cp, nodeId, 'error', node.onError);
          continue;
        }

        // Completed.
        const output = outcome.output;
        if (node.type === 'code')
          cp.state = { ...cp.state, ...(output as Record<string, unknown>) };
        else if (node.type !== 'approval' && node.output)
          cp.state = { ...cp.state, [node.output]: output };
        this.emit(
          run,
          'workflow.node.completed',
          {
            nodeType: node.type,
            ...(outcome.ref ? { ref: outcome.ref } : {}),
            outputKey:
              node.type === 'code'
                ? Object.keys(output as object)
                : node.type === 'approval'
                  ? null
                  : (node.output ?? null),
          },
          nodeId,
          Date.now() - nodeStarted,
        );

        let next: { to: string; label?: string };
        if (node.type === 'approval')
          next = {
            to: approvalDecision === 'approved' ? node.onApproved : node.onRejected,
            label: approvalDecision ?? 'rejected',
          };
        else
          next = resolveTransition(node.next, {
            goal: run.goal,
            state: cp.state,
            input: run.input,
          });
        cp = this.advance(run, cp, nodeId, next.label ?? 'next', next.to);
      }
      throw new LoopSmithError('limit_exceeded', `Workflow exceeded maxSteps (${def.maxSteps})`, {
        details: { limit: 'maxSteps', value: def.maxSteps },
      });
    } catch (raw) {
      const err = toLoopSmithError(raw, 'workflow');
      const cancelled = err.category === 'cancelled';
      const failed = store.updateRun(run.id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: serializeError(err),
        endedAt: nowIso(),
        ownerPid: null,
      });
      store.saveCheckpoint({ ...cp, status: failed.status });
      this.emit(
        run,
        'workflow.failed',
        { message: err.message, category: err.category },
        undefined,
        Date.now() - startedMs,
      );
      this.emit(
        run,
        cancelled ? 'run.cancelled' : 'run.failed',
        { error: serializeError(err) },
        undefined,
        Date.now() - startedMs,
      );
      return this.result(failed, cp);
    }
  }

  private async runNode(
    node: Exclude<WorkflowNode, { type: 'end' } | { type: 'approval' }>,
    nodeId: string,
    scope: TemplateScope,
    base: NodeRequestBase,
  ): Promise<NodeOutcome> {
    try {
      switch (node.type) {
        case 'agent': {
          const context: Record<string, unknown> = {};
          for (const key of node.contextKeys ?? [])
            if (key in scope.state) context[key] = scope.state[key];
          return await this.deps.services.runAgent({
            ...base,
            agentId: node.agent,
            prompt: renderTemplate(node.prompt, scope),
            context,
          });
        }
        case 'tool':
          return await this.deps.services.runTool({
            ...base,
            tool: node.tool,
            args: renderValue(node.args, scope),
          });
        case 'code': {
          const handler = this.handlers.get(node.handler);
          if (!handler)
            throw new LoopSmithError('configuration', `Unknown code handler "${node.handler}"`);
          const patch = await handler({
            state: scope.state,
            goal: scope.goal,
            input: scope.input,
            nodeId,
          });
          return { status: 'completed', output: patch };
        }
      }
    } catch (raw) {
      const err = toLoopSmithError(raw, 'workflow');
      if (err.category === 'cancelled') throw err;
      return { status: 'failed', error: serializeError(err), retryable: false };
    }
  }

  private advance(
    run: RunRecord,
    cp: Checkpoint,
    from: string,
    reason: string,
    to: string,
  ): Checkpoint {
    this.emit(run, 'workflow.transition', { from, to, reason }, from);
    const next: Checkpoint = {
      ...cp,
      status: 'running',
      nodeId: to,
      step: cp.step + 1,
      pending: null,
      history: [...cp.history, { nodeId: from, outcome: reason, at: nowIso(), to }],
    };
    const saved = this.deps.store.saveCheckpoint(next);
    this.emit(run, 'workflow.checkpoint', { seq: saved.seq, nodeId: to, step: next.step });
    return next;
  }

  private complete(
    run: RunRecord,
    def: WorkflowDefinition,
    cp: Checkpoint,
    node: Extract<WorkflowNode, { type: 'end' }>,
    scope: TemplateScope,
    startedMs: number,
  ): WorkflowResult {
    const { store } = this.deps;
    const output = node.output ? renderTemplate(node.output, scope) : null;
    const status = node.status === 'failed' ? 'failed' : 'completed';
    const final: Checkpoint = {
      ...cp,
      status,
      history: [...cp.history, { nodeId: cp.nodeId as string, outcome: 'end', at: nowIso() }],
    };
    store.saveCheckpoint(final);
    const updated = store.updateRun(run.id, {
      status,
      output: { text: output, state: cp.state },
      endedAt: nowIso(),
      ownerPid: null,
      ...(status === 'failed'
        ? {
            error: {
              category: 'workflow',
              code: 'end_failed',
              message: output ?? 'Workflow ended in a failure state',
              retryable: false,
            },
          }
        : {}),
    });
    const duration = Date.now() - startedMs;
    this.emit(
      run,
      status === 'completed' ? 'workflow.completed' : 'workflow.failed',
      { workflowId: def.id, steps: cp.step, endNode: cp.nodeId, message: output },
      undefined,
      duration,
    );
    this.emit(
      run,
      status === 'completed' ? 'run.completed' : 'run.failed',
      { steps: cp.step },
      undefined,
      duration,
    );
    return this.result(updated, final);
  }

  private result(
    run: RunRecord,
    cp: Pick<CheckpointRecord, 'state' | 'step'>,
    approvals: ApprovalRecord[] = [],
  ): WorkflowResult {
    const output = run.output as { text?: string | null } | null;
    const status =
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'cancelled' ||
      run.status === 'awaiting_approval'
        ? run.status
        : 'failed';
    const pending =
      status === 'awaiting_approval' && approvals.length === 0
        ? this.deps.store.listApprovals({ status: 'pending', rootRunId: run.id })
        : approvals;
    const result: WorkflowResult = {
      runId: run.id,
      sessionId: run.sessionId,
      workflowId: run.workflowId ?? 'unknown',
      status,
      output: output?.text ?? null,
      state: cp.state,
      pendingApprovals: pending,
      steps: cp.step,
    };
    if (run.error) result.error = run.error;
    return result;
  }

  private target(node: WorkflowNode): string | undefined {
    if (node.type === 'agent') return node.agent;
    if (node.type === 'tool') return node.tool;
    if (node.type === 'code') return node.handler;
    return undefined;
  }

  private emit(
    run: RunRecord,
    type: RuntimeEventType,
    data: Record<string, unknown>,
    nodeId?: string,
    durationMs?: number,
  ): void {
    this.deps.events.emit({
      type,
      sessionId: run.sessionId,
      runId: run.id,
      rootRunId: run.rootRunId,
      ...(nodeId ? { nodeId } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      data,
    });
  }
}
