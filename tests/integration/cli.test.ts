import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../apps/cli/dist/index.js', import.meta.url));

/** End-to-end through the real binary: separate processes for run, approve and resume. */
describe.skipIf(!existsSync(CLI))('loopsmith CLI (requires `pnpm build`)', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'loopsmith-cli-'));
  const env = { ...process.env, NO_COLOR: '1', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' };
  const run = (...args: string[]): string =>
    execFileSync(process.execPath, [CLI, '--no-color', ...args], { cwd, env, encoding: 'utf8' });

  it('demo pauses for approval, then approve --resume publishes the report', () => {
    const first = run('demo', '--defer');
    expect(first).toContain('approval required');
    expect(first).toContain('The run is paused and fully persisted');

    const approvals = JSON.parse(run('--json', 'approvals', 'list')) as Array<{
      id: string;
      toolName: string;
    }>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.toolName).toBe('workspace.write');
    const report = path.join(cwd, '.loopsmith/demo-workspace/reports/workspace-analysis.md');
    expect(existsSync(report)).toBe(false);

    const resumed = run('approvals', 'approve', approvals[0]?.id ?? '', '--resume');
    expect(resumed).toContain('workflow completed');
    expect(readFileSync(report, 'utf8')).toContain('# Workspace Improvement Report');

    const runs = JSON.parse(run('--json', 'runs', 'list')) as Array<{ id: string; status: string }>;
    expect(runs[0]?.status).toBe('completed');
    const inspection = JSON.parse(run('--json', 'runs', 'inspect', runs[0]?.id ?? '')) as {
      metrics: { approvalsApproved: number; modelCalls: number };
    };
    expect(inspection.metrics.approvalsApproved).toBe(1);
    expect(inspection.metrics.modelCalls).toBe(14);

    const jsonl = run('runs', 'export', runs[0]?.id ?? '');
    const events = jsonl
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
    expect(events[0]?.type).toBe('run.started');
    expect(events.at(-1)?.type).toBe('run.completed');
  });

  it('lists providers without leaking secrets', () => {
    const out = execFileSync(process.execPath, [CLI, '--no-color', 'providers'], {
      cwd,
      env: { ...env, ANTHROPIC_API_KEY: 'sk-ant-never-print-12' },
      encoding: 'utf8',
    });
    expect(out).toContain('ready (ANTHROPIC_API_KEY set)');
    expect(out).not.toContain('sk-ant-never-print');
  });
});
