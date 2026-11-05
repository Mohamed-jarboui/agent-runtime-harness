import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analystAgents,
  analystHandlers,
  analystScripts,
  analystWorkflows,
  REPORT_PATH,
} from '@loopsmith/workspace-analyst';
import { AutoReject } from '@loopsmith/policies';
import { createHarness, tempDb, type Harness } from '../helpers.js';

const SAMPLE = fileURLToPath(new URL('../../examples/sample-workspace', import.meta.url));

function copySample(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loopsmith-sample-'));
  cpSync(SAMPLE, dir, { recursive: true });
  return dir;
}

let h: Harness | undefined;
afterEach(() => h?.ls.close());

async function analyst(database = tempDb(), workspace = copySample()): Promise<Harness> {
  return createHarness({
    script: { agents: analystScripts },
    agents: analystAgents,
    workflows: analystWorkflows,
    workspace,
    database,
    extra: { handlers: analystHandlers },
  });
}

describe('workspace-analyst workflow (deterministic provider)', () => {
  it('plans, researches, drafts, reviews, pauses for approval, then publishes after resume', async () => {
    h = await analyst();
    const first = await h.ls.runWorkflow(
      'workspace-analyst',
      'Analyze this workspace and produce an improvement report',
    );
    expect(first.status).toBe('awaiting_approval');
    expect(first.pendingApprovals).toHaveLength(1);
    const approval = first.pendingApprovals[0];
    expect(approval?.toolName).toBe('workspace.write');
    expect(existsSync(path.join(h.workspace, REPORT_PATH))).toBe(false);

    // State before approval: one refinement loop happened.
    const state = first.state ?? {};
    expect((state.review as { verdict: string }).verdict).toBe('approved');
    expect(state.revisions).toBe(2);

    h.ls.decide(approval?.id ?? '', 'approved', 'tester');
    const done = await h.ls.resume(first.runId);
    expect(done.status).toBe('completed');
    expect(done.output).toContain('Report saved to reports/workspace-analysis.md');

    const report = readFileSync(path.join(h.workspace, REPORT_PATH), 'utf8');
    expect(report).toContain('[HIGH] Hard-coded credentials in source code');
    expect(report).toContain('[HIGH] Dynamic code execution with eval()');
    expect(report).toContain('`src/inventory.js:');
    expect(report).not.toContain('changeme'); // credential value redacted
    expect(report).not.toContain('example-only-not-a-real-secret'); // .env was never read

    const inspection = h.ls.inspect(first.runId);
    const nodes = inspection.events
      .filter((e) => e.type === 'workflow.node.started')
      .map((e) => e.nodeId);
    expect(nodes).toEqual([
      'plan',
      'research',
      'draft',
      'verify',
      'review',
      'draft',
      'verify',
      'review',
      'publish',
    ]);
    expect(inspection.events.some((e) => e.type === 'security.flagged')).toBe(true);
    expect(
      inspection.toolCalls.find(
        (t) =>
          t.toolName === 'workspace.read' &&
          String((t.arguments as { path: string }).path) === '.env',
      )?.status,
    ).toBe('failed');
    expect(inspection.metrics.approvalsApproved).toBe(1);
  });

  it('resumes from the checkpoint in a fresh process-equivalent instance', async () => {
    const database = tempDb();
    const workspace = copySample();
    h = await analyst(database, workspace);
    const first = await h.ls.runWorkflow('workspace-analyst', 'Analyze this workspace');
    const approvalId = first.pendingApprovals[0]?.id ?? '';
    const modelCallsBefore = h.provider.calls.length;
    h.ls.close();

    // New instance, same database: nothing completed is re-executed.
    h = await analyst(database, workspace);
    h.ls.decide(approvalId, 'approved', 'tester');
    const done = await h.ls.resume(first.runId);
    expect(done.status).toBe('completed');
    expect(h.provider.calls.length).toBe(1); // only the publisher's final turn
    expect(modelCallsBefore).toBeGreaterThan(8);
  });

  it('does not write the report when the human rejects the write', async () => {
    h = await analyst();
    const result = await h.ls.runWorkflow('workspace-analyst', 'Analyze this workspace', {
      approvals: new AutoReject('tester'),
    });
    expect(result.status).toBe('completed');
    expect(existsSync(path.join(h.workspace, REPORT_PATH))).toBe(false);
    expect(String(result.state?.publication)).toContain('not saved');
  });

  it('coordinator delegates to the researcher and hands off to the executor', async () => {
    h = await analyst();
    const result = await h.ls.runAgent(
      'coordinator',
      'Assess this workspace and write up the findings',
    );
    expect(result.status).toBe('completed');
    expect(result.finalAgentId).toBe('executor');
    expect(result.output).toContain('## Prioritized recommendations');
    const inspection = h.ls.inspect(result.runId);
    expect(inspection.handoffs.map((x) => `${x.kind}:${x.fromAgent}->${x.toAgent}`)).toEqual([
      'delegation:coordinator->researcher',
      'handoff:coordinator->executor',
    ]);
    expect(inspection.runs).toHaveLength(2);
  });
});
