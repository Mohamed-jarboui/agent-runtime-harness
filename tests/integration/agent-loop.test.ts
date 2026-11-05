import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { call, calls, say } from '@loopsmith/providers';
import { AutoApprove, AutoReject } from '@loopsmith/policies';
import { assistantAgent, createHarness, type Harness } from '../helpers.js';

let h: Harness | undefined;
afterEach(() => h?.ls.close());

describe('agent loop', () => {
  it('runs a multi-step tool-calling loop to a final answer', async () => {
    h = await createHarness({
      files: { 'README.md': '# Project\nTODO: write docs\n', 'src/a.ts': 'export const a = 1;\n' },
      script: {
        agents: {
          assistant: [
            call('workspace.list', { path: '.', recursive: true }),
            calls([
              ['workspace.read', { path: 'README.md' }],
              ['workspace.search', { query: 'TODO' }],
            ]),
            call('calculator.evaluate', { expression: '2 * (3 + 4)' }),
            say('The README has 1 TODO. 2*(3+4)=14.'),
          ],
        },
      },
    });
    const result = await h.ls.runAgent('assistant', 'Inspect the workspace');
    expect(result.status).toBe('completed');
    expect(result.output).toContain('14');

    const inspection = h.ls.inspect(result.runId);
    expect(inspection.metrics.modelCalls).toBe(4);
    expect(inspection.metrics.toolCalls).toBe(4);
    expect(inspection.toolCalls.map((t) => t.toolName)).toEqual([
      'workspace.list',
      'workspace.read',
      'workspace.search',
      'calculator.evaluate',
    ]);
    expect(inspection.toolCalls.every((t) => t.status === 'completed')).toBe(true);

    // The model actually saw the tool observations on the next turn.
    const lastRequest = h.provider.calls.at(-1);
    const toolMessages = lastRequest?.messages.filter((m) => m.role === 'tool') ?? [];
    expect(toolMessages).toHaveLength(4);
    expect(toolMessages.some((m) => m.content.includes('"result": 14'))).toBe(true);
  });

  it('pauses for approval before writing and resumes the same run after approval', async () => {
    h = await createHarness({
      script: {
        agents: {
          assistant: [
            call('workspace.write', {
              path: 'out/report.md',
              content: '# Report\n',
              mode: 'create',
            }),
            say('Report written.'),
          ],
        },
      },
    });
    const first = await h.ls.runAgent('assistant', 'Write a report');
    expect(first.status).toBe('awaiting_approval');
    expect(first.pendingApprovals).toHaveLength(1);
    expect(existsSync(path.join(h.workspace, 'out/report.md'))).toBe(false);

    const approval = first.pendingApprovals[0];
    if (!approval) throw new Error('expected approval');
    h.ls.decide(approval.id, 'approved', 'tester');
    const resumed = await h.ls.resume(first.runId);
    expect(resumed.status).toBe('completed');
    expect(resumed.runId).toBe(first.runId);
    expect(readFileSync(path.join(h.workspace, 'out/report.md'), 'utf8')).toBe('# Report\n');
  });

  it('feeds a human rejection back to the model without executing the tool', async () => {
    h = await createHarness({
      script: {
        agents: {
          assistant: [
            call('workspace.write', { path: 'x.md', content: 'x' }),
            say('Understood, not writing.'),
          ],
        },
      },
    });
    const result = await h.ls.runAgent('assistant', 'Write x', {
      approvals: new AutoReject('tester'),
    });
    expect(result.status).toBe('completed');
    expect(existsSync(path.join(h.workspace, 'x.md'))).toBe(false);
    const toolMsg = h.provider.calls.at(-1)?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('approval_rejected');
  });

  it('auto-approval still records the decision', async () => {
    h = await createHarness({
      script: {
        agents: {
          assistant: [call('workspace.write', { path: 'y.md', content: 'y' }), say('done')],
        },
      },
    });
    const result = await h.ls.runAgent('assistant', 'Write y', {
      approvals: new AutoApprove('ci'),
    });
    expect(result.status).toBe('completed');
    const approvals = h.ls.inspect(result.runId).approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe('approved');
    expect(approvals[0]?.decidedBy).toBe('ci');
  });

  it('enforces the iteration limit', async () => {
    h = await createHarness({
      agents: [assistantAgent()],
      limits: { maxIterations: 3 },
      script: { agents: { assistant: () => call('calculator.evaluate', { expression: '1+1' }) } },
    });
    const result = await h.ls.runAgent('assistant', 'loop forever');
    expect(result.status).toBe('failed');
    expect(result.error?.category).toBe('limit_exceeded');
    expect(h.ls.inspect(result.runId).metrics.modelCalls).toBe(3);
  });
});
