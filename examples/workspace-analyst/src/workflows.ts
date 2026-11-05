import type { CodeHandler, WorkflowDefinition } from '@loopsmith/workflow-engine';
import type { FindingsReport } from './analysis.js';

export const REPORT_PATH = 'reports/workspace-analysis.md';

const draftPrompt = [
  'Write the workspace improvement report in Markdown from these findings.',
  '<findings>{{json state.findings}}</findings>',
  '<revision>{{state.revisions}}</revision>',
  'Reviewer feedback on the previous draft (empty on the first draft):',
  '<review>{{json state.review}}</review>',
].join('\n');

const reviewPrompt = [
  'Review this draft improvement report against the rubric and spot-check cited evidence.',
  '<draft>{{state.draft}}</draft>',
  'Deterministic verification results:',
  '<verification>{{json state.verification}}</verification>',
].join('\n');

/**
 * Autonomous Workspace Analyst:
 * planner → researcher → executor (draft) → verify → reviewer ⟲ executor → publish (human approval) → done
 */
export const workspaceAnalystWorkflow: WorkflowDefinition = {
  id: 'workspace-analyst',
  name: 'Autonomous Workspace Analyst',
  description:
    'Inspect a workspace, identify technical weaknesses, review the report, and publish it after human approval.',
  version: '1.0.0',
  start: 'plan',
  maxSteps: 20,
  defaultMaxVisits: 3,
  initialState: { revisions: 0 },
  nodes: {
    plan: {
      type: 'agent',
      agent: 'planner',
      description: 'Break the goal down and choose files to inspect',
      prompt: 'Goal: {{goal}}\nInventory the workspace and produce an analysis plan.',
      output: 'plan',
      next: 'research',
      retry: { maxAttempts: 2, backoffMs: 200 },
    },
    research: {
      type: 'agent',
      agent: 'researcher',
      description: 'Inspect files and produce evidence-backed findings',
      prompt:
        'Goal: {{goal}}\nInvestigate the workspace following this plan.\n<plan>{{json state.plan}}</plan>',
      output: 'findings',
      contextKeys: ['plan'],
      next: 'draft',
      retry: { maxAttempts: 2, backoffMs: 200 },
    },
    draft: {
      type: 'agent',
      agent: 'executor',
      description: 'Draft (or revise) the improvement report',
      prompt: draftPrompt,
      output: 'draft',
      maxVisits: 3,
      onMaxVisits: 'escalate',
      next: 'verify',
    },
    verify: {
      type: 'code',
      handler: 'verifyReport',
      description: 'Deterministic structural checks on the draft',
      maxVisits: 3,
      next: 'review',
    },
    review: {
      type: 'agent',
      agent: 'reviewer',
      description: 'Rubric review with evidence spot-checks',
      prompt: reviewPrompt,
      output: 'review',
      maxVisits: 3,
      onMaxVisits: 'escalate',
      next: {
        cases: [
          {
            when: {
              all: [
                { path: 'state.review.verdict', equals: 'approved' },
                { path: 'state.verification.passed', equals: true },
              ],
            },
            to: 'publish',
            label: 'approved',
          },
        ],
        default: 'draft',
      },
    },
    escalate: {
      type: 'approval',
      description: 'Review loop exhausted: ask a human',
      prompt:
        'The reviewer did not approve the report after 3 drafts. Publish the latest draft anyway?',
      onApproved: 'publish',
      onRejected: 'abandoned',
    },
    publish: {
      type: 'agent',
      agent: 'executor',
      description: 'Save the approved report (workspace.write requires human approval)',
      prompt: `Save this approved report to the workspace.\n<path>${REPORT_PATH}</path>\n<report>{{state.draft}}</report>`,
      output: 'publication',
      next: 'done',
    },
    done: {
      type: 'end',
      output:
        'Report saved to ' +
        REPORT_PATH +
        ': {{state.findings.summary.total}} findings ({{state.findings.summary.high}} high, {{state.findings.summary.medium}} medium, {{state.findings.summary.low}} low). ' +
        'Review verdict: {{state.review.verdict}} after {{state.revisions}} draft(s). {{state.publication}}',
    },
    abandoned: {
      type: 'end',
      output: 'Report was not published: a human declined after the review loop was exhausted.',
    },
  },
};

/** Generic plan → execute → review loop (no side effects). */
export const planExecuteReviewWorkflow: WorkflowDefinition = {
  id: 'plan-execute-review',
  name: 'Plan · Execute · Review',
  description:
    'Plan, investigate, draft and review a report in a bounded refinement loop. Read-only.',
  version: '1.0.0',
  start: 'plan',
  maxSteps: 16,
  defaultMaxVisits: 3,
  initialState: { revisions: 0 },
  nodes: {
    plan: {
      ...(workspaceAnalystWorkflow.nodes.plan as object),
      next: 'execute',
    } as WorkflowDefinition['nodes'][string],
    execute: {
      ...(workspaceAnalystWorkflow.nodes.research as object),
      next: 'draft',
    } as WorkflowDefinition['nodes'][string],
    draft: {
      ...(workspaceAnalystWorkflow.nodes.draft as object),
      onMaxVisits: 'done',
      next: 'verify',
    } as WorkflowDefinition['nodes'][string],
    verify: workspaceAnalystWorkflow.nodes.verify as WorkflowDefinition['nodes'][string],
    review: {
      ...(workspaceAnalystWorkflow.nodes.review as object),
      onMaxVisits: 'done',
      next: {
        cases: [
          {
            when: { path: 'state.review.verdict', equals: 'approved' },
            to: 'done',
            label: 'approved',
          },
        ],
        default: 'draft',
      },
    } as WorkflowDefinition['nodes'][string],
    done: {
      type: 'end',
      output:
        'Review verdict: {{state.review.verdict}} after {{state.revisions}} draft(s).\n\n{{state.draft}}',
    },
  },
};

const REQUIRED = [
  '## Executive summary',
  '## Findings',
  '## Prioritized recommendations',
  '## Limitations',
];

/** Deterministic verification of the draft: structure, completeness, no credential values. */
export const verifyReport: CodeHandler = ({ state }) => {
  const draft = typeof state.draft === 'string' ? state.draft : '';
  const findings = (state.findings as FindingsReport | undefined)?.findings ?? [];
  const checks = [
    { name: 'required-sections', passed: REQUIRED.every((s) => draft.includes(s)) },
    { name: 'all-findings-reported', passed: findings.every((f) => draft.includes(f.title)) },
    { name: 'size-bounded', passed: draft.length > 200 && draft.length < 100_000 },
    {
      name: 'no-credential-values',
      passed: !/(password|secret|api[_-]?key)\s*[:=]\s*["'][^"'<]{3,}["']/i.test(draft),
    },
  ];
  return {
    verification: { passed: checks.every((c) => c.passed), checks },
    revisions: Number(state.revisions ?? 0) + 1,
  };
};

export const analystHandlers: Record<string, CodeHandler> = { verifyReport };
export const analystWorkflows: WorkflowDefinition[] = [
  workspaceAnalystWorkflow,
  planExecuteReviewWorkflow,
];
