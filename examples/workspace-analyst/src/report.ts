import type { Evidence, FindingsReport } from './analysis.js';

export interface ReportOptions {
  /** Quote the offending lines for each finding (the reviewer requires this for HIGH findings). */
  quoteEvidence: boolean;
  revision: number;
}

const loc = (e: Evidence): string => `\`${e.path}${e.line ? `:${e.line}` : ''}\``;

export function renderReport(report: FindingsReport, options: ReportOptions): string {
  const { summary, metrics } = report;
  const lines: string[] = [];
  lines.push(`# Workspace Improvement Report — ${report.workspace}`, '');
  lines.push(
    `_Produced by the LoopSmith \`workspace-analyst\` workflow (draft revision ${options.revision})._`,
    '',
  );
  lines.push('## Executive summary', '');
  lines.push(
    `- Inspected **${metrics.filesInspected} files** (${metrics.linesInspected} lines) and found **${summary.total} issues**: ` +
      `${summary.high} high, ${summary.medium} medium, ${summary.low} low.`,
  );
  lines.push(
    `- Technical-debt markers: ${metrics.todoCount} TODO/FIXME/HACK` +
      (metrics.todoDensityPer1k === null
        ? '.'
        : ` (${metrics.todoDensityPer1k} per 1,000 lines, computed with \`calculator.evaluate\`).`),
  );
  const top = report.findings
    .filter((f) => f.severity === 'high')
    .map((f) => f.title.toLowerCase());
  if (top.length > 0) lines.push(`- Most urgent: ${top.join('; ')}.`);
  lines.push('', '## Findings', '');
  report.findings.forEach((f, i) => {
    lines.push(`### ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}`, '');
    lines.push(`- **Category:** ${f.category}`);
    lines.push(`- **Evidence:** ${f.evidence.map(loc).join(', ') || 'n/a'}`);
    if (options.quoteEvidence || f.severity !== 'high') {
      for (const e of f.evidence.slice(0, 3))
        if (e.excerpt) lines.push(`  > ${e.excerpt.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    lines.push(`- **Recommendation:** ${f.recommendation}`, '');
  });
  lines.push('## Prioritized recommendations', '');
  report.findings
    .slice(0, 6)
    .forEach((f, i) => lines.push(`${i + 1}. ${f.recommendation} _(addresses: ${f.title})_`));
  lines.push('', '## Method', '');
  lines.push(
    '- `planner` listed the workspace and selected files; `researcher` read and searched them and quantified debt;',
  );
  lines.push(
    '  `executor` drafted this report; a deterministic verification step and the `reviewer` agent checked it;',
  );
  lines.push('  the report was written only after explicit human approval of `workspace.write`.');
  lines.push('', '## Limitations', '');
  lines.push('- Static, heuristic inspection of a bounded file sample; no code was executed.');
  lines.push('- Files blocked by the workspace policy (for example `.env`) were not read.');
  lines.push('- Severity is a triage aid, not a formal risk assessment.', '');
  return lines.join('\n');
}

export interface ReviewVerdict {
  verdict: 'approved' | 'needs_changes';
  issues: string[];
  checkedEvidence: Array<{ location: string; confirmed: boolean }>;
}

const REQUIRED_SECTIONS = [
  '## Executive summary',
  '## Findings',
  '## Prioritized recommendations',
  '## Limitations',
];

/** The reviewer's rubric, applied to the actual draft text. */
export function reviewDraft(
  draft: string,
  spotChecks: Array<{ location: string; confirmed: boolean }>,
): ReviewVerdict {
  const issues: string[] = [];
  for (const section of REQUIRED_SECTIONS)
    if (!draft.includes(section)) issues.push(`Missing section "${section.slice(3)}".`);
  const blocks = draft.split(/^### /m).slice(1);
  for (const block of blocks) {
    const title = block.split('\n')[0] ?? '';
    if (title.includes('[HIGH]') && !/^\s*> /m.test(block)) {
      issues.push(
        `High-severity finding "${title.replace(/^\d+\.\s*/, '')}" must quote the offending line(s).`,
      );
    }
  }
  for (const check of spotChecks)
    if (!check.confirmed) issues.push(`Cited evidence ${check.location} could not be confirmed.`);
  return {
    verdict: issues.length === 0 ? 'approved' : 'needs_changes',
    issues,
    checkedEvidence: spotChecks,
  };
}
