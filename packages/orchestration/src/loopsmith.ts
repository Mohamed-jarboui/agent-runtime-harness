import {
  LoopSmithError,
  Redactor,
  resolveLimits,
  type AgentDefinition,
  type ApprovalRecord,
  type CheckpointRecord,
  type ExecutionLimits,
  type HandoffRecord,
  type RunRecord,
  type RuntimeEvent,
  type SerializedError,
  type StateStore,
  type ToolCallRecord,
} from '@loopsmith/core';
import { ContextManager, type CompactionConfig, type Summarizer } from '@loopsmith/context';
import { MemoryManager } from '@loopsmith/memory';
import { EventBus, computeRunMetrics, type RunMetrics } from '@loopsmith/observability';
import {
  DeferApprovals,
  PolicyEngine,
  type ApprovalResolver,
  type PolicyConfigInput,
} from '@loopsmith/policies';
import { type ProviderRegistry } from '@loopsmith/providers';
import { AgentRegistry, AgentRuntime, type AgentRunResult } from '@loopsmith/runtime';
import { SqliteStateStore } from '@loopsmith/storage';
import {
  ToolExecutor,
  ToolRegistry,
  WorkspaceSandbox,
  builtinTools,
  type RegisteredTool,
  type SandboxOptions,
} from '@loopsmith/tools';
import {
  WorkflowEngine,
  type CodeHandler,
  type WorkflowDefinition,
  type WorkflowResult,
} from '@loopsmith/workflow-engine';
import { WorkflowRegistry } from './workflow-registry.js';
import { RuntimeWorkflowServices, executionScope } from './workflow-services.js';

export interface LoopSmithOptions {
  /** SQLite file path or `:memory:`. */
  database: string;
  /** Workspace root for the sandboxed workspace tools (optional). */
  workspace?: string | SandboxOptions;
  providers: ProviderRegistry;
  limits?: Partial<ExecutionLimits>;
  policy?: PolicyConfigInput;
  compaction?: Partial<CompactionConfig>;
  summarizer?: Summarizer;
  /** Default approval resolver (defaults to deferring to a human). */
  approvals?: ApprovalResolver;
  agents?: AgentDefinition[];
  workflows?: WorkflowDefinition[];
  handlers?: Record<string, CodeHandler>;
  /** Extra tools (e.g. MCP adapters). Built-in tools are always registered. */
  tools?: RegisteredTool[];
  redactor?: Redactor;
  store?: StateStore;
}

export interface RunOptions {
  sessionId?: string;
  /** Run every agent on this provider (e.g. `mock`, `anthropic`). */
  provider?: string;
  limits?: Partial<ExecutionLimits>;
  approvals?: ApprovalResolver;
  signal?: AbortSignal;
}

export interface RunOutcome {
  kind: 'agent' | 'workflow';
  runId: string;
  sessionId: string;
  status: 'completed' | 'awaiting_approval' | 'failed' | 'cancelled';
  output: string | null;
  structured?: unknown;
  state?: Record<string, unknown>;
  pendingApprovals: ApprovalRecord[];
  error?: SerializedError;
  finalAgentId?: string;
}

export interface RunInspection {
  run: RunRecord;
  runs: RunRecord[];
  metrics: RunMetrics;
  approvals: ApprovalRecord[];
  toolCalls: ToolCallRecord[];
  handoffs: HandoffRecord[];
  checkpoints: CheckpointRecord[];
  events: RuntimeEvent[];
}

/**
 * Composition root. Wires storage, observability, providers, policies,
 * tools, memory, context, the agent runtime and the workflow engine into a
 * single object with a small API: run, resume, decide, inspect.
 */
export class LoopSmith {
  readonly store: StateStore;
  readonly events: EventBus;
  readonly redactor: Redactor;
  readonly agents = new AgentRegistry();
  readonly tools = new ToolRegistry();
  readonly workflows = new WorkflowRegistry();
  readonly providers: ProviderRegistry;
  readonly policy: PolicyEngine;
  readonly memory: MemoryManager;
  readonly runtime: AgentRuntime;
  readonly engine: WorkflowEngine;
  readonly workspace: WorkspaceSandbox | undefined;
  readonly limits: ExecutionLimits;
  private readonly defaultApprovals: ApprovalResolver;

  private constructor(options: LoopSmithOptions, workspace: WorkspaceSandbox | undefined) {
    this.redactor = options.redactor ?? new Redactor();
    this.store = options.store ?? new SqliteStateStore({ path: options.database });
    this.events = new EventBus({ store: this.store, redactor: this.redactor });
    this.providers = options.providers;
    this.policy = new PolicyEngine(options.policy);
    this.memory = new MemoryManager(this.store);
    this.workspace = workspace;
    this.limits = resolveLimits(options.limits);
    this.defaultApprovals = options.approvals ?? new DeferApprovals();

    this.tools.registerAll(builtinTools());
    for (const tool of options.tools ?? []) this.tools.register(tool);
    for (const agent of options.agents ?? []) this.agents.register(agent);
    for (const wf of options.workflows ?? []) this.workflows.register(wf);

    this.runtime = new AgentRuntime({
      store: this.store,
      events: this.events,
      agents: this.agents,
      tools: this.tools,
      policy: this.policy,
      providers: this.providers,
      context: new ContextManager(options.compaction, options.summarizer),
      memory: this.memory,
      approvals: this.defaultApprovals,
      ...(workspace ? { workspace } : {}),
      limits: this.limits,
    });
    const executor = new ToolExecutor(this.tools, {
      defaultTimeoutMs: this.limits.toolTimeoutMs,
      maxOutputChars: this.limits.maxToolOutputChars,
    });
    this.engine = new WorkflowEngine({
      store: this.store,
      events: this.events,
      services: new RuntimeWorkflowServices({
        store: this.store,
        events: this.events,
        runtime: this.runtime,
        tools: this.tools,
        executor,
        policy: this.policy,
        memory: this.memory,
        ...(workspace ? { workspace } : {}),
      }),
      resolveWorkflow: (id) => this.workflows.get(id),
      ...(options.handlers ? { handlers: options.handlers } : {}),
    });
  }

  static async create(options: LoopSmithOptions): Promise<LoopSmith> {
    const workspace = options.workspace
      ? await WorkspaceSandbox.create(
          typeof options.workspace === 'string' ? { root: options.workspace } : options.workspace,
        )
      : undefined;
    const instance = new LoopSmith(options, workspace);
    const problems = instance.agents.validateGraph();
    if (problems.length > 0)
      throw new LoopSmithError('configuration', `Invalid agent graph: ${problems.join('; ')}`);
    return instance;
  }

  /** New session that records where it ran, so another process can resume it. */
  private newSession(goal: string, provider?: string): string {
    return this.store.createSession({
      title: goal.slice(0, 80),
      metadata: {
        ...(this.workspace ? { workspaceRoot: this.workspace.root } : {}),
        ...(provider ? { provider } : {}),
      },
    }).id;
  }

  private scoped<T>(approvals: ApprovalResolver | undefined, fn: () => Promise<T>): Promise<T> {
    return executionScope.run({ approvals: approvals ?? this.defaultApprovals }, fn);
  }

  async runAgent(agentId: string, goal: string, options: RunOptions = {}): Promise<RunOutcome> {
    if (options.provider) this.providers.get(options.provider);
    const result = await this.scoped(options.approvals, () =>
      this.runtime.startRun({
        agentId,
        goal,
        sessionId: options.sessionId ?? this.newSession(goal, options.provider),
        ...(options.provider ? { providerOverride: options.provider } : {}),
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        approvals: options.approvals ?? this.defaultApprovals,
      }),
    );
    return fromAgent(result);
  }

  async runWorkflow(
    workflowId: string,
    goal: string,
    options: RunOptions & { input?: unknown } = {},
  ): Promise<RunOutcome> {
    const workflow = this.workflows.get(workflowId);
    if (options.provider) this.providers.get(options.provider);
    const result = await this.scoped(options.approvals, () =>
      this.engine.start({
        workflow,
        goal,
        sessionId: options.sessionId ?? this.newSession(goal, options.provider),
        ...(options.input === undefined ? {} : { input: options.input }),
        config: {
          ...(options.provider ? { providerOverride: options.provider } : {}),
          ...(options.limits ? { limits: options.limits } : {}),
          ...(this.workspace ? { workspaceRoot: this.workspace.root } : {}),
        },
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
    return fromWorkflow(result);
  }

  /** Resume a paused or interrupted run (any run id in the tree resumes its root). */
  async resume(
    runId: string,
    options: Pick<RunOptions, 'approvals' | 'signal'> = {},
  ): Promise<RunOutcome> {
    const run = this.store.getRun(runId);
    if (!run) throw new LoopSmithError('configuration', `Run not found: ${runId}`);
    const root = this.store.getRun(run.rootRunId) ?? run;
    const signalOpt = options.signal ? { signal: options.signal } : {};
    return this.scoped(options.approvals, async () => {
      if (root.kind === 'workflow')
        return fromWorkflow(await this.engine.resume(root.id, signalOpt));
      return fromAgent(
        await this.runtime.resumeRun(root.id, {
          ...signalOpt,
          approvals: options.approvals ?? this.defaultApprovals,
        }),
      );
    });
  }

  /** Record a human decision. Execution continues on the next `resume`. */
  decide(
    approvalId: string,
    status: 'approved' | 'rejected',
    by: string,
    note?: string,
  ): ApprovalRecord {
    const decided = this.store.decideApproval(approvalId, {
      status,
      by,
      ...(note ? { note } : {}),
    });
    const run = this.store.getRun(decided.runId);
    if (run) {
      this.events.emit({
        type: 'approval.decided',
        sessionId: run.sessionId,
        runId: run.id,
        rootRunId: run.rootRunId,
        ...(run.agentId ? { agentId: run.agentId } : {}),
        ...(decided.nodeId ? { nodeId: decided.nodeId } : {}),
        data: { approvalId: decided.id, status: decided.status, by, tool: decided.toolName },
      });
    }
    return decided;
  }

  inspect(runId: string): RunInspection {
    const run = this.store.getRun(runId);
    if (!run) throw new LoopSmithError('configuration', `Run not found: ${runId}`);
    const root = this.store.getRun(run.rootRunId) ?? run;
    const runs = this.store.listRuns({ rootRunId: root.id, limit: 10_000 }).reverse();
    return {
      run: root,
      runs,
      metrics: computeRunMetrics(this.store, root.id),
      approvals: this.store.listApprovals({ rootRunId: root.id }).reverse(),
      toolCalls: runs.flatMap((r) => this.store.listToolCalls(r.id)),
      handoffs: this.store.listHandoffs(root.id),
      checkpoints: root.kind === 'workflow' ? this.store.listCheckpoints(root.id) : [],
      events: this.store.listEvents({ rootRunId: root.id }),
    };
  }

  close(): void {
    this.store.close();
  }
}

function fromAgent(result: AgentRunResult): RunOutcome {
  const outcome: RunOutcome = {
    kind: 'agent',
    runId: result.rootRunId,
    sessionId: result.sessionId,
    status: result.status,
    output: result.output,
    pendingApprovals: result.pendingApprovals,
    finalAgentId: result.agentId,
  };
  if (result.structured !== undefined) outcome.structured = result.structured;
  if (result.error) outcome.error = result.error;
  return outcome;
}

function fromWorkflow(result: WorkflowResult): RunOutcome {
  const outcome: RunOutcome = {
    kind: 'workflow',
    runId: result.runId,
    sessionId: result.sessionId,
    status: result.status,
    output: result.output,
    state: result.state,
    pendingApprovals: result.pendingApprovals,
  };
  if (result.error) outcome.error = result.error;
  return outcome;
}
