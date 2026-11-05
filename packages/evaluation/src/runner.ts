import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serializeError } from '@loopsmith/core';
import { LoopSmith, type RunOutcome } from '@loopsmith/orchestration';
import {
  AutoApprove,
  AutoReject,
  DeferApprovals,
  type ApprovalResolver,
} from '@loopsmith/policies';
import { ProviderRegistry, ScriptedProvider } from '@loopsmith/providers';
import type { EvalCheck, EvalReport, EvalSummary, EvalTask, EvalTaskResult } from './types.js';

export interface EvalRunOptions {
  /** `mock` uses each task's script; `live` runs liveCompatible tasks on a real provider. */
  mode?: 'mock' | 'live';
  /** Live mode: registry with real providers, and the provider name to use. */
  providers?: ProviderRegistry;
  provider?: string;
  filter?: (task: EvalTask) => boolean;
  onTaskComplete?: (result: EvalTaskResult) => void;
}

const SIDE_EFFECT_CATEGORIES = new Set(['write', 'execute', 'external', 'destructive', 'network']);

function makeWorkspace(task: EvalTask): string {
  const root = mkdtempSync(path.join(tmpdir(), `loopsmith-eval-${task.id}-`));
  if (task.workspaceDir) cpSync(task.workspaceDir, root, { recursive: true });
  for (const [rel, content] of Object.entries(task.files ?? {})) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

function resolverFor(task: EvalTask): ApprovalResolver {
  if (task.approvals === 'approve') return new AutoApprove('eval');
  if (task.approvals === 'reject') return new AutoReject('eval');
  return new DeferApprovals();
}

export async function runTask(
  task: EvalTask,
  options: EvalRunOptions = {},
): Promise<EvalTaskResult> {
  const mode = options.mode ?? 'mock';
  const workspace = makeWorkspace(task);
  let providers: ProviderRegistry;
  let providerOverride: string | undefined;
  if (mode === 'live') {
    if (!options.providers || !options.provider)
      throw new Error('live mode requires providers and provider');
    providers = options.providers;
    providerOverride = options.provider;
  } else {
    providers = new ProviderRegistry({ baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 10_000 });
    providers.register(new ScriptedProvider({ name: 'mock', agents: task.script }));
  }

  const started = Date.now();
  const ls = await LoopSmith.create({
    database: ':memory:',
    workspace,
    providers,
    agents: task.agents ?? [],
    workflows: task.workflows ?? [],
    ...(task.handlers ? { handlers: task.handlers } : {}),
    ...(task.tools ? { tools: task.tools } : {}),
    ...(task.policy ? { policy: task.policy } : {}),
    ...(task.compaction ? { compaction: task.compaction } : {}),
    limits: { maxRuntimeMs: 60_000, ...task.limits },
  });
  let outcome: RunOutcome | undefined;
  let error: string | undefined;
  try {
    const runOptions = {
      approvals: resolverFor(task),
      ...(providerOverride ? { provider: providerOverride } : {}),
    };
    outcome =
      'agent' in task.target
        ? await ls.runAgent(task.target.agent, task.goal, runOptions)
        : await ls.runWorkflow(task.target.workflow, task.goal, runOptions);
  } catch (err) {
    error = serializeError(err).message;
  }
  const durationMs = Date.now() - started;

  const checks: EvalCheck[] = [];
  const check = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };
  let result: EvalTaskResult;
  if (!outcome) {
    check('run-executed', false, error ?? 'run threw');
    result = emptyResult(task, checks, durationMs, error);
  } else {
    const inspection = ls.inspect(outcome.runId);
    const m = inspection.metrics;
    const executed = inspection.toolCalls
      .filter((t) => t.status === 'completed')
      .map((t) => t.toolName);
    const e = task.expect;

    if (e.status)
      check('status', outcome.status === e.status, `expected ${e.status}, got ${outcome.status}`);
    if (e.errorCategory)
      check(
        'error-category',
        outcome.error?.category === e.errorCategory,
        `expected ${e.errorCategory}, got ${outcome.error?.category ?? 'none'}`,
      );
    for (const text of e.outputIncludes ?? [])
      check(
        `output-includes:${text}`,
        (outcome.output ?? '').includes(text),
        `output ${outcome.output ? 'present' : 'missing'}`,
      );
    for (const tool of e.toolsExecuted ?? [])
      check(
        `executed:${tool}`,
        executed.includes(tool),
        `executed: [${[...new Set(executed)].join(', ')}]`,
      );
    for (const tool of e.toolsNotExecuted ?? [])
      check(
        `not-executed:${tool}`,
        !executed.includes(tool),
        `executed: [${[...new Set(executed)].join(', ')}]`,
      );
    if (e.maxModelCalls !== undefined)
      check(
        'max-model-calls',
        m.modelCalls <= e.maxModelCalls,
        `${m.modelCalls} <= ${e.maxModelCalls}`,
      );
    if (e.maxToolCalls !== undefined)
      check('max-tool-calls', m.toolCalls <= e.maxToolCalls, `${m.toolCalls} <= ${e.maxToolCalls}`);
    if (e.approvalsRequested !== undefined)
      check(
        'approvals-requested',
        m.approvalsRequested === e.approvalsRequested,
        `expected ${e.approvalsRequested}, got ${m.approvalsRequested}`,
      );
    for (const type of e.events ?? [])
      check(
        `event:${type}`,
        inspection.events.some((ev) => ev.type === type),
        'event present in trace',
      );
    for (const [rel, f] of Object.entries(e.files ?? {})) {
      const abs = path.join(workspace, rel);
      const exists = existsSync(abs);
      check(
        `file:${rel}`,
        exists === f.exists &&
          (!f.includes || (exists && readFileSync(abs, 'utf8').includes(f.includes))),
        `exists=${exists}`,
      );
    }
    if (e.transfers !== undefined)
      check(
        'transfers',
        inspection.handoffs.length === e.transfers,
        `expected ${e.transfers}, got ${inspection.handoffs.length}`,
      );
    if (e.finalAgent)
      check(
        'final-agent',
        outcome.finalAgentId === e.finalAgent,
        `expected ${e.finalAgent}, got ${outcome.finalAgentId ?? 'n/a'}`,
      );
    if (e.workflowPath) {
      const pathTaken = inspection.events
        .filter((ev) => ev.type === 'workflow.node.started')
        .map((ev) => ev.nodeId ?? '');
      check(
        'workflow-path',
        JSON.stringify(pathTaken) === JSON.stringify(e.workflowPath),
        pathTaken.join(' → '),
      );
    }

    // Global invariant: no side effect ran without a recorded human approval.
    const unapproved = inspection.toolCalls.filter((t) => {
      const tool = ls.tools.get(t.toolName);
      if (!tool || !SIDE_EFFECT_CATEGORIES.has(tool.category) || t.status !== 'completed')
        return false;
      const approval = t.approvalId
        ? inspection.approvals.find((a) => a.id === t.approvalId)
        : undefined;
      const effect = ls.policy.evaluate({ toolName: tool.name, category: tool.category }).effect;
      return effect !== 'allow' && approval?.status !== 'approved';
    });
    check(
      'invariant:no-unapproved-side-effects',
      unapproved.length === 0,
      `${unapproved.length} unapproved side effects`,
    );

    result = {
      id: task.id,
      title: task.title,
      category: task.category,
      passed: checks.every((c) => c.passed),
      status: outcome.status,
      checks,
      modelCalls: m.modelCalls,
      toolCalls: m.toolCalls,
      invalidToolArguments: inspection.toolCalls.filter(
        (t) => t.error?.category === 'invalid_tool_arguments',
      ).length,
      approvalsRequested: m.approvalsRequested,
      retries: m.retries,
      recoveries: m.recoveries,
      durationMs,
      tokens: {
        input: m.usage.inputTokens,
        output: m.usage.outputTokens,
        reported: m.usage.reported,
      },
      runId: outcome.runId,
    };
  }
  ls.close();
  rmSync(workspace, { recursive: true, force: true });
  return result;
}

function emptyResult(
  task: EvalTask,
  checks: EvalCheck[],
  durationMs: number,
  error?: string,
): EvalTaskResult {
  return {
    id: task.id,
    title: task.title,
    category: task.category,
    passed: false,
    status: 'error',
    checks,
    modelCalls: 0,
    toolCalls: 0,
    invalidToolArguments: 0,
    approvalsRequested: 0,
    retries: 0,
    recoveries: 0,
    durationMs,
    tokens: { input: 0, output: 0, reported: false },
    runId: '',
    ...(error ? { error } : {}),
  };
}

const ratio = (num: number, den: number): number | null =>
  den === 0 ? null : Math.round((num / den) * 1000) / 1000;
const avg = (values: number[]): number =>
  values.length === 0
    ? 0
    : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;

export async function runEvalSuite(
  tasks: EvalTask[],
  options: EvalRunOptions = {},
): Promise<EvalReport> {
  const mode = options.mode ?? 'mock';
  const selected = tasks
    .filter((t) => (mode === 'live' ? t.liveCompatible : true))
    .filter(options.filter ?? (() => true));
  const results: EvalTaskResult[] = [];
  for (const task of selected) {
    const result = await runTask(task, options);
    results.push(result);
    options.onTaskComplete?.(result);
  }
  return {
    summary: summarize(selected, results, mode, options.provider ?? 'mock (scripted)'),
    results,
  };
}

export function summarize(
  tasks: EvalTask[],
  results: EvalTaskResult[],
  mode: 'mock' | 'live',
  provider: string,
): EvalSummary {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const expectsCompletion = results.filter((r) => byId.get(r.id)?.expect.status === 'completed');
  const toolSelection = results.filter((r) => {
    const e = byId.get(r.id)?.expect;
    return (e?.toolsExecuted?.length ?? 0) + (e?.toolsNotExecuted?.length ?? 0) > 0;
  });
  const toolChecksPassed = toolSelection.filter((r) =>
    r.checks
      .filter((c) => c.name.startsWith('executed:') || c.name.startsWith('not-executed:'))
      .every((c) => c.passed),
  );
  const workflows = results.filter((r) => 'workflow' in (byId.get(r.id)?.target ?? {}));
  const recovery = results.filter((r) => r.category === 'recovery');
  const totalToolCalls = results.reduce((n, r) => n + r.toolCalls, 0);
  const invalid = results.reduce((n, r) => n + r.invalidToolArguments, 0);
  const invariant = results.filter(
    (r) => r.checks.find((c) => c.name === 'invariant:no-unapproved-side-effects')?.passed,
  );
  const byCategory: Record<string, { tasks: number; passed: number }> = {};
  for (const r of results) {
    const entry = (byCategory[r.category] ??= { tasks: 0, passed: 0 });
    entry.tasks++;
    if (r.passed) entry.passed++;
  }
  const reported = results.some((r) => r.tokens.reported);
  return {
    mode,
    provider,
    generatedAt: new Date().toISOString(),
    tasks: results.length,
    passed: results.filter((r) => r.passed).length,
    passRate: ratio(results.filter((r) => r.passed).length, results.length) ?? 0,
    completionRate: ratio(
      expectsCompletion.filter((r) => r.status === 'completed').length,
      expectsCompletion.length,
    ),
    toolSelectionAccuracy: ratio(toolChecksPassed.length, toolSelection.length),
    toolArgumentValidity: ratio(totalToolCalls - invalid, totalToolCalls),
    workflowCompletionRate: ratio(
      workflows.filter((r) => r.status === 'completed').length,
      workflows.length,
    ),
    approvalPolicyEnforcement: ratio(invariant.length, results.length) ?? 0,
    recoveryPassRate: ratio(recovery.filter((r) => r.passed).length, recovery.length),
    avgModelCalls: avg(results.map((r) => r.modelCalls)),
    avgToolCalls: avg(results.map((r) => r.toolCalls)),
    avgDurationMs: avg(results.map((r) => r.durationMs)),
    tokens: {
      input: results.reduce((n, r) => n + r.tokens.input, 0),
      output: results.reduce((n, r) => n + r.tokens.output, 0),
      reported,
    },
    byCategory,
  };
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

export function reportToMarkdown(report: EvalReport): string {
  const s = report.summary;
  const lines = [
    `# LoopSmith evaluation report`,
    '',
    `- **Mode:** ${s.mode === 'mock' ? 'deterministic mock provider (scripted model behaviour — measures the runtime, not model quality)' : `live provider \`${s.provider}\``}`,
    `- **Generated:** ${s.generatedAt}`,
    `- **Tasks:** ${s.passed}/${s.tasks} passed (${pct(s.passRate)})`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Task completion rate (tasks expected to complete) | ${pct(s.completionRate)} |`,
    `| Tool selection correctness | ${pct(s.toolSelectionAccuracy)} |`,
    `| Tool argument validity (valid / all tool calls) | ${pct(s.toolArgumentValidity)} |`,
    `| Workflow completion rate | ${pct(s.workflowCompletionRate)} |`,
    `| Approval policy enforcement (no unapproved side effects) | ${pct(s.approvalPolicyEnforcement)} |`,
    `| Recovery tasks passed | ${pct(s.recoveryPassRate)} |`,
    `| Avg model calls / task | ${s.avgModelCalls} |`,
    `| Avg tool calls / task | ${s.avgToolCalls} |`,
    `| Avg duration / task | ${s.avgDurationMs} ms |`,
    `| Tokens | ${s.tokens.reported ? `${s.tokens.input} in / ${s.tokens.output} out` : 'not reported (mock provider does not invent usage)'} |`,
    '',
    '| Task | Category | Result | Status | Model calls | Tool calls | Failed checks |',
    '|---|---|---|---|---|---|---|',
    ...report.results.map(
      (r) =>
        `| \`${r.id}\` | ${r.category} | ${r.passed ? '✅ pass' : '❌ fail'} | ${r.status} | ${r.modelCalls} | ${r.toolCalls} | ${
          r.checks
            .filter((c) => !c.passed)
            .map((c) => `${c.name} (${c.detail})`)
            .join('; ') || '—'
        } |`,
    ),
    '',
  ];
  if (s.mode === 'mock') {
    lines.push(
      '> Mock-mode scores verify runtime behaviour (loop control, policies, recovery, persistence) under scripted model',
      '> responses, including deliberately bad ones. They say nothing about how well a real model performs the tasks.',
      '',
    );
  }
  return lines.join('\n');
}
