import pc from 'picocolors';
import type { ApprovalRecord, RunRecord } from '@loopsmith/core';
import { formatEvent, PRICING_AS_OF, type RunMetrics } from '@loopsmith/observability';
import type { RunInspection, RunOutcome } from '@loopsmith/orchestration';
import { summarizeApproval } from '@loopsmith/policies';

export const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

export function table(rows: string[][], header: string[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => stripAnsi(r[i] ?? '').length)));
  const fmt = (r: string[]): string =>
    r
      .map((cell, i) => cell + ' '.repeat(Math.max(0, (widths[i] ?? 0) - stripAnsi(cell).length)))
      .join('  ');
  return [
    pc.bold(fmt(header)),
    pc.dim(widths.map((w) => '─'.repeat(w)).join('  ')),
    ...rows.map(fmt),
  ].join('\n');
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

export const statusColor = (status: string): string => {
  switch (status) {
    case 'completed':
    case 'approved':
      return pc.green(status);
    case 'awaiting_approval':
    case 'pending':
    case 'running':
      return pc.yellow(status);
    case 'failed':
    case 'cancelled':
    case 'rejected':
      return pc.red(status);
    default:
      return status;
  }
};

const truncate = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export function formatDuration(ms: number | null): string {
  if (ms === null) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

export function metricsLine(m: RunMetrics): string {
  return [
    `${m.modelCalls} model calls`,
    `${m.toolCalls} tool calls (${m.toolErrors} errors, ${m.toolsDenied} denied)`,
    `${m.approvalsRequested} approvals (${m.approvalsApproved} approved, ${m.approvalsRejected} rejected)`,
    `${m.handoffs} handoffs`,
    `${m.delegations} delegations`,
    `${m.retries} retries`,
    `${m.recoveries} recoveries`,
    `${m.compactions} compactions`,
    `duration ${formatDuration(m.durationMs)}`,
  ].join(' · ');
}

export function tokensLine(m: RunMetrics): string {
  if (!m.usage.reported)
    return 'tokens: not reported by the provider (the mock provider never invents usage)';
  const cost =
    m.estimatedCostUsd === null
      ? 'cost: no known pricing for this model'
      : `est. cost $${m.estimatedCostUsd.toFixed(4)} (list prices as of ${PRICING_AS_OF})`;
  return `tokens: ${m.usage.inputTokens} in / ${m.usage.outputTokens} out · ${cost}`;
}

export function approvalBlock(approval: ApprovalRecord): string[] {
  const args = approval.arguments as Record<string, unknown> | null;
  const lines = [
    `${pc.yellow('⏸  Approval required')} ${pc.bold(approval.id)}`,
    `   ${pc.dim('what:  ')} ${summarizeApproval(approval)}`,
    `   ${pc.dim('policy:')} ${approval.reason}`,
    `   ${pc.dim('run:   ')} ${approval.runId}${approval.nodeId ? ` (node ${approval.nodeId})` : ''}`,
  ];
  if (args && typeof args.content === 'string') {
    const preview = args.content.split('\n').slice(0, 8);
    lines.push(
      `   ${pc.dim('preview:')}`,
      ...preview.map((l) => `     ${pc.dim('│')} ${truncate(l, 100)}`),
    );
    if (args.content.split('\n').length > 8)
      lines.push(`     ${pc.dim(`│ … ${args.content.split('\n').length - 8} more lines`)}`);
  } else if (args) {
    lines.push(`   ${pc.dim('args:  ')} ${truncate(JSON.stringify(args), 160)}`);
  }
  return lines;
}

export function printOutcome(outcome: RunOutcome, inspection: RunInspection): void {
  const m = inspection.metrics;
  out();
  out(pc.dim('─'.repeat(72)));
  const target =
    inspection.run.kind === 'workflow'
      ? `workflow ${inspection.run.workflowId}`
      : `agent ${inspection.run.agentId}`;
  out(`${pc.bold('Run')} ${outcome.runId} · ${target} · ${statusColor(outcome.status)}`);
  if (outcome.finalAgentId && outcome.kind === 'agent')
    out(`${pc.dim('Final answer owned by:')} ${outcome.finalAgentId}`);
  out(pc.dim(metricsLine(m)));
  out(pc.dim(tokensLine(m)));
  if (outcome.output) {
    out();
    out(pc.bold('Output'));
    const lines = outcome.output.split('\n');
    for (const l of lines.slice(0, 40)) out(`  ${l}`);
    if (lines.length > 40)
      out(pc.dim(`  … ${lines.length - 40} more lines (loopsmith runs inspect ${outcome.runId})`));
  }
  if (outcome.error) out(pc.red(`Error [${outcome.error.category}]: ${outcome.error.message}`));
  if (outcome.status === 'awaiting_approval') {
    out();
    for (const a of outcome.pendingApprovals) for (const l of approvalBlock(a)) out(l);
    out();
    out(pc.bold('The run is paused and fully persisted. To continue:'));
    for (const a of outcome.pendingApprovals)
      out(
        `  loopsmith approvals approve ${a.id} --resume   ${pc.dim('# or: approvals reject ' + a.id)}`,
      );
    out(`  loopsmith runs resume ${outcome.runId}   ${pc.dim('# after deciding')}`);
  }
  out(pc.dim('─'.repeat(72)));
  out(
    pc.dim(
      `Inspect: loopsmith runs inspect ${outcome.runId}   Trace: loopsmith runs export ${outcome.runId} --out trace.jsonl`,
    ),
  );
}

function runLabel(run: RunRecord): string {
  return run.kind === 'workflow' ? `workflow:${run.workflowId}` : `agent:${run.agentId}`;
}

export function printRunsList(runs: RunRecord[]): void {
  if (runs.length === 0) {
    out('No runs yet. Try: loopsmith demo');
    return;
  }
  out(
    table(
      runs.map((r) => [
        r.id,
        runLabel(r),
        statusColor(r.status),
        String(r.kind === 'agent' ? r.iteration : ''),
        r.createdAt.replace('T', ' ').slice(0, 19),
        truncate(r.goal, 50),
      ]),
      ['RUN', 'TARGET', 'STATUS', 'ITER', 'CREATED (UTC)', 'GOAL'],
    ),
  );
}

export function printInspection(
  i: RunInspection,
  options: { events: boolean; verbose: boolean },
): void {
  const { run } = i;
  out(
    `${pc.bold('Run')} ${run.id} · ${runLabel(run)} · ${statusColor(run.status)} · session ${run.sessionId}`,
  );
  out(`${pc.dim('Goal:')} ${truncate(run.goal, 160)}`);
  out(pc.dim(metricsLine(i.metrics)));
  out(pc.dim(tokensLine(i.metrics)));
  if (i.metrics.providers.length) out(pc.dim(`providers: ${i.metrics.providers.join(', ')}`));
  if (run.error) out(pc.red(`error [${run.error.category}]: ${run.error.message}`));

  out();
  out(pc.bold('Run tree'));
  const children = new Map<string | null, RunRecord[]>();
  for (const r of i.runs) {
    const key = r.id === run.id ? null : r.parentRunId;
    children.set(key, [...(children.get(key) ?? []), r]);
  }
  const walk = (r: RunRecord, prefix: string, isLast: boolean, depth: number): void => {
    const branch = depth === 0 ? '' : isLast ? '└─ ' : '├─ ';
    const info =
      r.kind === 'agent'
        ? `${r.iteration} iter · ${r.toolCallCount} tools${r.handoffCount ? ` · ${r.handoffCount} handoffs` : ''}`
        : '';
    out(
      `  ${prefix}${branch}${r.id}  ${runLabel(r)}  ${statusColor(r.status)}  ${pc.dim(info)}${r.nodeId ? pc.dim(`  [node ${r.nodeId}]`) : ''}`,
    );
    const kids = (children.get(r.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    kids.forEach((k, idx) =>
      walk(
        k,
        depth === 0 ? '' : prefix + (isLast ? '   ' : '│  '),
        idx === kids.length - 1,
        depth + 1,
      ),
    );
  };
  walk(run, '', true, 0);

  if (i.toolCalls.length > 0) {
    out();
    out(pc.bold(`Tool calls (${i.toolCalls.length})`));
    out(
      table(
        i.toolCalls.map((t) => [
          t.agentId ?? 'workflow',
          t.toolName,
          statusColor(t.status),
          t.policyEffect ?? '-',
          t.durationMs === null ? '-' : `${t.durationMs}ms`,
          truncate(
            t.error ? `${t.error.category}: ${t.error.message}` : JSON.stringify(t.arguments ?? {}),
            60,
          ),
        ]),
        ['AGENT', 'TOOL', 'STATUS', 'POLICY', 'TIME', 'ARGS / ERROR'],
      ),
    );
  }
  if (i.approvals.length > 0) {
    out();
    out(pc.bold('Approvals'));
    out(
      table(
        i.approvals.map((a) => [
          a.id,
          statusColor(a.status),
          a.decidedBy ?? '-',
          truncate(summarizeApproval(a), 70),
        ]),
        ['APPROVAL', 'STATUS', 'BY', 'WHAT'],
      ),
    );
  }
  if (i.handoffs.length > 0) {
    out();
    out(pc.bold('Agent transitions'));
    out(
      table(
        i.handoffs.map((h) => [
          h.kind,
          `${h.fromAgent} → ${h.toAgent}`,
          String(h.depth),
          truncate(h.reason, 60),
        ]),
        ['KIND', 'FROM → TO', 'DEPTH', 'REASON'],
      ),
    );
  }
  if (i.checkpoints.length > 0) {
    const pathTaken = i.checkpoints
      .at(-1)
      ?.history.map((h) => h.nodeId)
      .join(' → ');
    out();
    out(`${pc.bold('Workflow')} ${i.checkpoints.length} checkpoints · path: ${pathTaken}`);
  }
  out();
  out(
    pc.bold(
      `Timeline (${i.events.length} events${options.events ? '' : ', condensed — use --events for all'})`,
    ),
  );
  const shown = options.events
    ? i.events
    : i.events.filter(
        (e) =>
          e.type !== 'workflow.checkpoint' &&
          e.type !== 'tool.policy' &&
          e.type !== 'model.request' &&
          e.type !== 'tool.started',
      );
  for (const e of shown) {
    const line = formatEvent(e, { timestamps: true, verbose: options.events || options.verbose });
    if (line) out(line);
  }
  const output = run.output as { text?: string } | null;
  if (output?.text) {
    out();
    out(pc.bold('Output'));
    for (const l of output.text.split('\n').slice(0, 30)) out(`  ${l}`);
  }
}
