import type { ModelRequest } from '@loopsmith/core';
import { call, calls, say, type AgentScript, type ScriptStep } from '@loopsmith/providers';
import { analyze, buildPlan, listingFrom, type FindingsReport, type Plan } from './analysis.js';
import {
  jsonInUserMessages,
  observations,
  tagged,
  taggedJson,
  type Observation,
} from './observations.js';
import { renderReport, reviewDraft, type ReviewVerdict } from './report.js';

/**
 * Deterministic model policies for offline mode.
 *
 * These functions stand in for an LLM: each one reads the *actual* request the
 * runtime built (prompt, tool observations, handoff payloads) and decides the
 * next action. They are pure functions of the request, so runs are fully
 * reproducible and resume-safe across processes. Findings are computed from
 * real tool output — nothing about the sample workspace is hard-coded.
 *
 * One scripted behaviour is intentional and documented: the executor's first
 * draft cites HIGH-severity evidence by location only, and the reviewer's
 * rubric requires quoted lines, so the refinement loop runs exactly once.
 */
const goalLine = (req: ModelRequest): string => {
  const first = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const match = /Goal:\s*(.+)/.exec(first);
  return (match?.[1] ?? first.split('\n')[0] ?? '').trim();
};

const LIST_ARGS = { path: '.', recursive: true, maxEntries: 300 };

function workspaceName(obs: Observation[]): string {
  for (const o of obs) {
    const data = o.data as { path?: string; content?: string } | undefined;
    if (o.tool === 'workspace.read' && o.ok && data?.path?.endsWith('package.json')) {
      try {
        const name = (JSON.parse(data.content ?? '{}') as { name?: string }).name;
        if (name) return name;
      } catch {
        /* not JSON */
      }
    }
  }
  return 'workspace';
}

export const plannerPolicy = (req: ModelRequest): ScriptStep => {
  const obs = observations(req);
  if (!obs.some((o) => o.tool === 'workspace.list')) {
    return calls(
      [
        ['workspace.list', LIST_ARGS],
        ['memory.search', { query: 'workspace analysis findings' }],
      ],
      'I will inventory the workspace and check memory for earlier analyses.',
    );
  }
  return say(JSON.stringify(buildPlan(goalLine(req), listingFrom(obs)), null, 2));
};

export const researcherPolicy = (req: ModelRequest): ScriptStep => {
  const obs = observations(req);
  let plan = taggedJson<Plan>(req, 'plan');
  if (!plan) {
    if (!obs.some((o) => o.tool === 'workspace.list'))
      return call(
        'workspace.list',
        LIST_ARGS,
        'No plan was provided; listing the workspace first.',
      );
    plan = buildPlan(goalLine(req), listingFrom(obs));
  }
  if (!obs.some((o) => o.tool === 'workspace.read')) {
    return calls(
      [
        ...plan.focusFiles.map((path): [string, unknown] => ['workspace.read', { path }]),
        ['workspace.search', { query: 'TODO|FIXME|HACK', regex: true }],
        ['workspace.search', { query: '(password|secret|api[_-]?key)\\s*[:=]', regex: true }],
      ],
      `Reading ${plan.focusFiles.length} files and searching for debt markers and credentials.`,
    );
  }
  const name = workspaceName(obs);
  const calc = obs.find((o) => o.tool === 'calculator.evaluate');
  if (!calc) {
    const draft = analyze(plan, obs, name, null);
    const lines = Math.max(1, draft.metrics.linesInspected);
    return call(
      'calculator.evaluate',
      { expression: `round(${draft.metrics.todoCount} / ${lines} * 1000, 2)` },
      'Computing TODO density per 1,000 lines.',
    );
  }
  const density = calc.ok ? ((calc.data as { result?: number }).result ?? null) : null;
  const report = analyze(plan, obs, name, density);
  if (!obs.some((o) => o.tool === 'memory.store')) {
    const high = report.findings.filter((f) => f.severity === 'high').map((f) => f.id);
    return call('memory.store', {
      content: `Workspace analysis of ${name}: ${report.summary.total} findings (${report.summary.high} high: ${high.join(', ') || 'none'}).`,
      tags: ['workspace-analysis', name],
      scope: 'global',
    });
  }
  return say(JSON.stringify(report, null, 2));
};

const isFindings = (v: unknown): v is FindingsReport =>
  typeof v === 'object' &&
  v !== null &&
  Array.isArray((v as FindingsReport).findings) &&
  typeof (v as FindingsReport).summary === 'object';

export const executorPolicy = (req: ModelRequest): ScriptStep => {
  const toSave = tagged(req, 'report');
  if (toSave !== undefined) {
    const path = tagged(req, 'path') ?? 'reports/workspace-analysis.md';
    const write = observations(req).find((o) => o.tool === 'workspace.write');
    if (!write)
      return call(
        'workspace.write',
        { path, content: `${toSave}\n`, mode: 'overwrite' },
        `Saving the approved report to ${path}.`,
      );
    if (write.ok)
      return say(
        `Saved the approved report to ${path} (${String((write.data as { bytes?: number }).bytes ?? '?')} bytes).`,
      );
    const message =
      (write.data as { error?: { message?: string } }).error?.message ?? 'unknown error';
    return say(`The report was not saved: ${message}. I will not retry the write.`);
  }
  const fromTag = taggedJson<FindingsReport>(req, 'findings');
  const findings =
    fromTag && isFindings(fromTag)
      ? fromTag
      : jsonInUserMessages<FindingsReport | { findings: FindingsReport }>(
          req,
          (v) => isFindings(v) || isFindings((v as { findings?: unknown })?.findings),
        );
  const resolved = findings && !isFindings(findings) ? findings.findings : findings;
  if (!resolved || !isFindings(resolved))
    return say('No findings were provided, so there is nothing to report.');
  const review = taggedJson<ReviewVerdict>(req, 'review');
  const revision = Number(tagged(req, 'revision') || '0') + 1;
  return say(
    renderReport(resolved, { quoteEvidence: review?.verdict === 'needs_changes', revision }),
  );
};

export const reviewerPolicy = (req: ModelRequest): ScriptStep => {
  const draft = tagged(req, 'draft') ?? '';
  const reads = observations(req).filter((o) => o.tool === 'workspace.read');
  if (reads.length === 0) {
    const cited = /`([^`\s]+?):(\d+)`/.exec(draft);
    if (cited) {
      const line = Number(cited[2]);
      return call(
        'workspace.read',
        { path: cited[1], startLine: line, endLine: line },
        `Spot-checking cited evidence ${cited[1]}:${line}.`,
      );
    }
  }
  const checks = reads.map((r) => ({
    location: `${String(r.args.path)}:${String(r.args.startLine ?? '')}`,
    confirmed: r.ok && String((r.data as { content?: string }).content ?? '').trim().length > 0,
  }));
  return say(JSON.stringify(reviewDraft(draft, checks), null, 2));
};

export const coordinatorPolicy = (req: ModelRequest): ScriptStep => {
  const obs = observations(req);
  const delegated = obs.find((o) => o.tool === 'agent.delegate');
  if (!delegated) {
    return call(
      'agent.delegate',
      {
        agent: 'researcher',
        task: 'Investigate this workspace and return evidence-backed findings as JSON.',
      },
      'Delegating the investigation.',
    );
  }
  if (!delegated.ok)
    return say(`Delegation failed, so I cannot produce a report: ${delegated.raw.slice(0, 200)}`);
  if (!obs.some((o) => o.tool === 'agent.handoff')) {
    const output = (delegated.data as { output?: unknown }).output;
    return call('agent.handoff', {
      agent: 'executor',
      reason: 'Findings are ready; the executor owns writing the final report.',
      payload: { findings: output },
    });
  }
  return say('Handed off to the executor.');
};

export const analystScripts: Record<string, AgentScript> = {
  planner: plannerPolicy,
  researcher: researcherPolicy,
  executor: executorPolicy,
  reviewer: reviewerPolicy,
  coordinator: coordinatorPolicy,
};
