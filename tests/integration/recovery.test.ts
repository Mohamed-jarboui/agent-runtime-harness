import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { call, say } from '@loopsmith/providers';
import { AutoApprove } from '@loopsmith/policies';
import { createHarness, tempDb, makeWorkspace, type Harness } from '../helpers.js';

let h: Harness | undefined;
afterEach(() => h?.ls.close());

/** Simulate a crash: the process died while a tool call was executing. */
/**
 * Simulate a crash: the process died while a tool call was executing (the
 * record says `executing`, the run says `running`, owned by a dead pid).
 */
function crashDuringTool(h: Harness, runId: string, tool: string): void {
  const record = h.ls.store.listToolCalls(runId).find((t) => t.toolName === tool);
  if (!record) throw new Error('no tool call');
  h.ls.store.upsertToolCall({
    ...record,
    status: 'executing',
    resultAppended: false,
    resultContent: null,
  });
  h.ls.store.updateRun(runId, {
    status: 'running',
    ownerPid: 999_999_999,
    endedAt: null,
    output: null,
    error: null,
  });
}

describe('execution recovery', () => {
  it('re-executes an interrupted idempotent tool after a crash, without repeating completed steps', async () => {
    const database = tempDb();
    const workspace = makeWorkspace({ 'a.txt': 'alpha' });
    const script = {
      agents: {
        assistant: [
          call('workspace.list', { path: '.' }),
          call('workspace.read', { path: 'a.txt' }),
          say('done'),
        ],
      },
    };
    // First process: stop right after the model requests the read (simulated by a 1-iteration budget).
    h = await createHarness({ script, database, workspace, limits: { maxIterations: 2 } });
    const first = await h.ls.runAgent('assistant', 'read a');
    expect(first.status).toBe('failed'); // iteration budget hit after requesting the read
    const runId = first.runId;
    // Pretend the read was mid-flight when the process died.
    const read = h.ls.store.listToolCalls(runId).find((t) => t.toolName === 'workspace.read');
    expect(read?.status).toBe('completed');
    h.ls.close();

    h = await createHarness({ script, database, workspace });
    const store = h.ls.store;
    const run = store.getRun(runId);
    if (!run || !read) throw new Error('missing');
    store.updateRun(runId, {
      status: 'running',
      ownerPid: 999_999_999,
      error: null,
      endedAt: null,
      config: { ...run.config, limits: { maxIterations: 5 } },
    });
    const resumed = await h.ls.resume(runId);
    expect(resumed.status).toBe('completed');
    // workspace.list ran once in the first process and was not repeated.
    expect(
      h.ls.inspect(runId).toolCalls.filter((t) => t.toolName === 'workspace.list'),
    ).toHaveLength(1);
    expect(h.provider.calls).toHaveLength(1); // only the final answer turn
  });

  it('never silently re-runs an interrupted non-idempotent side effect', async () => {
    const database = tempDb();
    const workspace = makeWorkspace({});
    const script = {
      agents: {
        assistant: [
          call('workspace.write', { path: 'log.txt', content: 'entry\n', mode: 'append' }),
          (req: { messages: Array<{ role: string; content: string }> }) =>
            say(
              req.messages.some(
                (m) => m.role === 'tool' && m.content.includes('outcome is unknown'),
              )
                ? 'Outcome unknown; please verify log.txt.'
                : 'ok',
            ),
        ],
      },
    };
    h = await createHarness({ script, database, workspace, limits: { maxIterations: 1 } });
    const first = await h.ls.runAgent('assistant', 'append', { approvals: new AutoApprove('t') });
    const runId = first.runId;
    crashDuringTool(h, runId, 'workspace.write');
    const runCfg = h.ls.store.getRun(runId)?.config ?? {};
    h.ls.store.updateRun(runId, { config: { ...runCfg, limits: { maxIterations: 5 } } });
    h.ls.close();

    h = await createHarness({ script, database, workspace });
    const resumed = await h.ls.resume(runId);
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toContain('Outcome unknown');
    expect(readFileSync(path.join(workspace, 'log.txt'), 'utf8')).toBe('entry\n'); // appended exactly once
    const events = h.ls.inspect(runId).events;
    expect(
      events.some((e) => e.type === 'recovery.attempted' && e.data.reason === 'interrupted_tool'),
    ).toBe(true);
  });

  it('refuses to resume a run that is still owned by a live process', async () => {
    h = await createHarness({ script: { agents: { assistant: [say('hi')] } } });
    const result = await h.ls.runAgent('assistant', 'hi');
    h.ls.store.updateRun(result.runId, { status: 'running', ownerPid: process.ppid });
    await expect(h.ls.resume(result.runId)).rejects.toMatchObject({ code: 'run_active' });
  });

  it('cancellation stops the run and persists the cancelled state', async () => {
    h = await createHarness({
      script: { agents: { assistant: [{ text: 'slow', delayMs: 5000 }] } },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await h.ls.runAgent('assistant', 'wait', { signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(h.ls.store.getRun(result.runId)?.status).toBe('cancelled');
    expect(h.ls.inspect(result.runId).events.some((e) => e.type === 'run.cancelled')).toBe(true);
  });

  it('maxRuntimeMs turns a hung model call into a limit failure', async () => {
    h = await createHarness({
      script: { agents: { assistant: [{ text: 'slow', delayMs: 5000 }] } },
      limits: { maxRuntimeMs: 100 },
    });
    const result = await h.ls.runAgent('assistant', 'wait');
    expect(result.status).toBe('failed');
    expect(result.error?.category).toBe('limit_exceeded');
  });

  it('approval decided in another process is honoured on resume (approvals are persisted)', async () => {
    const database = tempDb();
    const workspace = makeWorkspace({});
    const script = {
      agents: {
        assistant: [call('workspace.write', { path: 'r.md', content: 'R' }), say('written')],
      },
    };
    h = await createHarness({ script, database, workspace });
    const paused = await h.ls.runAgent('assistant', 'write r');
    h.ls.close();
    h = await createHarness({ script, database, workspace });
    expect(h.ls.store.listApprovals({ status: 'pending' })).toHaveLength(1);
    h.ls.decide(paused.pendingApprovals[0]?.id ?? '', 'approved', 'other-process');
    expect((await h.ls.resume(paused.runId)).status).toBe('completed');
    expect(existsSync(path.join(workspace, 'r.md'))).toBe(true);
    expect(() => h?.ls.decide(paused.pendingApprovals[0]?.id ?? '', 'rejected', 'late')).toThrow(
      /already approved/,
    );
  });
});
