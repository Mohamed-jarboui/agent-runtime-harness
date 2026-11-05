import { describe, expect, it } from 'vitest';
import type { ApprovalRecord } from '@loopsmith/core';
import { EventBus } from '@loopsmith/observability';
import { SqliteStateStore } from '@loopsmith/storage';
import {
  evaluateCondition,
  renderValue,
  toMermaid,
  validateWorkflow,
  WorkflowEngine,
  type NodeOutcome,
  type WorkflowDefinition,
  type WorkflowServices,
} from '@loopsmith/workflow-engine';

/** The engine runs with fake services: no agents, no provider, no LLM. */
function fakeServices(
  agentOutputs: Record<string, unknown[]>,
  failures: Record<string, number> = {},
): WorkflowServices & { calls: string[]; approvals: Map<string, ApprovalRecord> } {
  const calls: string[] = [];
  const counters = new Map<string, number>();
  const approvals = new Map<string, ApprovalRecord>();
  return {
    calls,
    approvals,
    async runAgent(req): Promise<NodeOutcome> {
      calls.push(`agent:${req.agentId}`);
      const n = counters.get(req.agentId) ?? 0;
      counters.set(req.agentId, n + 1);
      if ((failures[req.agentId] ?? 0) > n)
        return {
          status: 'failed',
          error: { category: 'provider_transient', code: 'x', message: 'flaky', retryable: true },
          retryable: true,
        };
      const outputs = agentOutputs[req.agentId] ?? [];
      return {
        status: 'completed',
        output: outputs[Math.min(n - (failures[req.agentId] ?? 0), outputs.length - 1)],
      };
    },
    async runTool(req): Promise<NodeOutcome> {
      calls.push(`tool:${req.tool}`);
      return { status: 'completed', output: { echoed: req.args } };
    },
    async requestApproval(req) {
      calls.push('approval');
      const existing = req.resumeRef ? approvals.get(req.resumeRef) : undefined;
      if (existing) return { status: existing.status, approval: existing };
      const approval = { id: `apr_${approvals.size}`, status: 'pending' } as ApprovalRecord;
      approvals.set(approval.id, approval);
      return { status: 'pending', approval };
    },
  };
}

const loop: WorkflowDefinition = {
  id: 'loop',
  name: 'Loop',
  description: 'review loop',
  version: '1',
  start: 'work',
  maxSteps: 20,
  nodes: {
    work: {
      type: 'agent',
      agent: 'worker',
      prompt: 'Do {{goal}} (attempt {{state.round}})',
      output: 'result',
      next: 'count',
      retry: { maxAttempts: 3, backoffMs: 1 },
    },
    count: { type: 'code', handler: 'inc', next: 'check' },
    check: {
      type: 'agent',
      agent: 'checker',
      prompt: 'Check {{json state.result}}',
      output: 'verdict',
      maxVisits: 3,
      onMaxVisits: 'gate',
      next: {
        cases: [{ when: { path: 'state.verdict.ok', equals: true }, to: 'publish' }],
        default: 'work',
      },
    },
    gate: {
      type: 'approval',
      prompt: 'Loop exhausted after {{state.round}} rounds; continue?',
      onApproved: 'publish',
      onRejected: 'stop',
    },
    publish: {
      type: 'tool',
      tool: 'workspace.write',
      args: { path: 'out.md', content: '{{state.result}}', meta: '{{state.verdict}}' },
      output: 'written',
      next: 'done',
    },
    done: { type: 'end', output: 'done after {{state.round}} rounds' },
    stop: { type: 'end', status: 'failed', output: 'stopped' },
  },
};

function engine(services: WorkflowServices) {
  const store = new SqliteStateStore({ path: ':memory:' });
  const events = new EventBus({ store });
  const wf = new WorkflowEngine({
    store,
    events,
    services,
    resolveWorkflow: () => loop,
    handlers: { inc: ({ state }) => ({ round: Number(state.round ?? 0) + 1 }) },
  });
  return { store, wf };
}

describe('workflow engine (provider-independent)', () => {
  it('validates graphs', () => {
    expect(() =>
      validateWorkflow({
        ...loop,
        nodes: { ...loop.nodes, work: { ...loop.nodes.work, next: 'nowhere' } },
      }),
    ).toThrow(/unknown node "nowhere"/);
    expect(() => validateWorkflow({ ...loop, start: 'missing' })).toThrow(/start node/);
    expect(validateWorkflow(loop).id).toBe('loop');
    expect(toMermaid(loop)).toContain(
      'check -->|state.verdict.ok = true| publish'.replace('state.', ''),
    );
  });

  it('loops back on conditions, retries transient failures and completes', async () => {
    const services = fakeServices(
      { worker: ['draft-1', 'draft-2'], checker: [{ ok: false }, { ok: true }] },
      { worker: 1 },
    );
    const { wf, store } = engine(services);
    const result = await wf.start({ workflow: loop, goal: 'the task' });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('done after 2 rounds');
    expect(services.calls).toEqual([
      'agent:worker',
      'agent:worker',
      'agent:checker',
      'agent:worker',
      'agent:checker',
      'tool:workspace.write',
    ]);
    expect(result.state.written).toEqual({
      echoed: { path: 'out.md', content: 'draft-2', meta: { ok: true } },
    });
    const types = store.listEvents({ rootRunId: result.runId }).map((e) => e.type);
    expect(types).toContain('workflow.node.retry');
    expect(store.listCheckpoints(result.runId).length).toBeGreaterThan(5);
  });

  it('bounds loops with maxVisits, pauses at the approval gate and resumes from the checkpoint', async () => {
    const services = fakeServices({ worker: ['d'], checker: [{ ok: false }] });
    const { wf, store } = engine(services);
    const paused = await wf.start({ workflow: loop, goal: 'g' });
    expect(paused.status).toBe('awaiting_approval');
    expect(services.calls.filter((c) => c === 'agent:checker')).toHaveLength(3);
    const events = store.listEvents({ rootRunId: paused.runId });
    expect(events.some((e) => e.type === 'limit.exceeded' && e.data.limit === 'maxVisits')).toBe(
      true,
    );

    // Decide and resume: completed nodes are not re-run.
    const approval = [...services.approvals.values()][0] as ApprovalRecord;
    approval.status = 'approved';
    const before = services.calls.length;
    const done = await wf.resume(paused.runId);
    expect(done.status).toBe('completed');
    expect(services.calls.slice(before)).toEqual(['approval', 'tool:workspace.write']);
  });

  it('fails the run when maxSteps is exceeded', async () => {
    const tiny: WorkflowDefinition = { ...loop, id: 'tiny', maxSteps: 3 };
    const services = fakeServices({ worker: ['d'], checker: [{ ok: false }] });
    const store = new SqliteStateStore({ path: ':memory:' });
    const wf = new WorkflowEngine({
      store,
      events: new EventBus({ store }),
      services,
      resolveWorkflow: () => tiny,
      handlers: { inc: () => ({}) },
    });
    const result = await wf.start({ workflow: tiny, goal: 'g' });
    expect(result.status).toBe('failed');
    expect(result.error?.category).toBe('limit_exceeded');
  });

  it('templates keep raw types for whole-value placeholders and conditions compose', () => {
    const scope = { goal: 'g', state: { n: 3, list: ['a'], obj: { k: 1 } }, input: null };
    expect(
      renderValue(
        { a: '{{state.n}}', b: 'n={{state.n}}', c: '{{json state.obj}}', d: ['{{state.list}}'] },
        scope,
      ),
    ).toEqual({ a: 3, b: 'n=3', c: '{\n  "k": 1\n}', d: [['a']] });
    expect(
      evaluateCondition(
        {
          all: [
            { path: 'state.n', gte: 3 },
            { not: { path: 'state.missing', exists: true } },
            { path: 'state.list', contains: 'a' },
          ],
        },
        scope,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          any: [
            { path: 'state.n', lt: 0 },
            { path: 'goal', in: ['x'] },
          ],
        },
        scope,
      ),
    ).toBe(false);
  });
});
