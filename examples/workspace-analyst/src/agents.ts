import { z } from 'zod';
import type { AgentDefinition } from '@loopsmith/core';

export const PlanSchema = z.object({
  objective: z.string(),
  steps: z.array(z.string()).min(1),
  focusFiles: z.array(z.string()),
  inventory: z.object({
    files: z.number(),
    directories: z.number(),
    hasTests: z.boolean(),
    hasLicense: z.boolean(),
    hasCi: z.boolean(),
    envFiles: z.array(z.string()),
  }),
});

const EvidenceSchema = z.object({
  path: z.string(),
  line: z.number().optional(),
  excerpt: z.string().optional(),
});

export const FindingsSchema = z.object({
  workspace: z.string(),
  findings: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      severity: z.enum(['high', 'medium', 'low']),
      category: z.string(),
      evidence: z.array(EvidenceSchema),
      recommendation: z.string(),
    }),
  ),
  metrics: z.record(z.string(), z.unknown()),
  summary: z.object({ total: z.number(), high: z.number(), medium: z.number(), low: z.number() }),
});

export const ReviewSchema = z.object({
  verdict: z.enum(['approved', 'needs_changes']),
  issues: z.array(z.string()),
  checkedEvidence: z.array(z.object({ location: z.string(), confirmed: z.boolean() })).default([]),
});

/**
 * The analyst agents. Instructions are written for real models; the
 * deterministic policies in `policies.ts` stand in for a model in offline mode.
 */
export const plannerAgent: AgentDefinition = {
  id: 'planner',
  name: 'Planner',
  description:
    'Breaks a workspace-analysis goal into a concrete plan and selects files to inspect.',
  instructions: [
    'You plan software-workspace analyses. First call workspace.list (recursive) to see the workspace.',
    'Optionally call memory.search for earlier analyses. Then answer with a JSON plan:',
    '{"objective": string, "steps": string[], "focusFiles": string[] (max 8, most informative first),',
    ' "inventory": {"files": n, "directories": n, "hasTests": bool, "hasLicense": bool, "hasCi": bool, "envFiles": string[]}}.',
  ].join('\n'),
  tools: ['workspace.list', 'memory.search'],
  maxSteps: 4,
  output: {
    format: 'json',
    schema: PlanSchema,
    description: 'objective, steps, focusFiles, inventory',
  },
};

export const researcherAgent: AgentDefinition = {
  id: 'researcher',
  name: 'Researcher',
  description:
    'Inspects files with read/search tools and turns observations into evidence-backed findings.',
  instructions: [
    'You investigate a code workspace. Read the files in the plan, search for TODO/FIXME/HACK markers and',
    'hard-coded credentials, and use calculator.evaluate for any arithmetic (never compute numbers in your head).',
    'Store one concise summary fact with memory.store (scope "global") so future runs can recall it.',
    'Every finding must cite evidence (path, line, excerpt). Answer with JSON:',
    '{"workspace": string, "findings": [{"id","title","severity":"high|medium|low","category","evidence":[{"path","line","excerpt"}],"recommendation"}],',
    ' "metrics": {...}, "summary": {"total","high","medium","low"}}.',
  ].join('\n'),
  tools: [
    'workspace.list',
    'workspace.read',
    'workspace.search',
    'calculator.evaluate',
    'memory.store',
  ],
  maxSteps: 8,
  output: {
    format: 'json',
    schema: FindingsSchema,
    description: 'workspace, findings[], metrics, summary',
  },
};

export const executorAgent: AgentDefinition = {
  id: 'executor',
  name: 'Executor',
  description:
    'Drafts the improvement report and, once approved by review, saves it to the workspace.',
  instructions: [
    'You turn findings into a clear Markdown improvement report with the sections:',
    '"## Executive summary", "## Findings" (one "### n. [SEVERITY] title" block each, with evidence and recommendation),',
    '"## Prioritized recommendations", "## Method", "## Limitations". Address all reviewer feedback when present.',
    'Only when explicitly asked to save a report, call workspace.write with mode "overwrite" and the exact report text.',
  ].join('\n'),
  tools: ['workspace.write'],
  maxSteps: 4,
};

export const reviewerAgent: AgentDefinition = {
  id: 'reviewer',
  name: 'Reviewer',
  description:
    'Validates the draft against a rubric and spot-checks cited evidence with read-only tools.',
  instructions: [
    'You review improvement reports. Spot-check at least one cited file/line with workspace.read.',
    'Rubric: all required sections present; every HIGH finding quotes the offending line; cited evidence exists.',
    'Answer with JSON: {"verdict": "approved" | "needs_changes", "issues": string[], "checkedEvidence": [{"location", "confirmed"}]}.',
  ].join('\n'),
  tools: ['workspace.read'],
  maxSteps: 4,
  permissions: { write: 'deny' },
  output: { format: 'json', schema: ReviewSchema, description: 'verdict, issues, checkedEvidence' },
};

export const coordinatorAgent: AgentDefinition = {
  id: 'coordinator',
  name: 'Coordinator',
  description:
    'Delegates investigation to the researcher, then hands the report-writing task to the executor.',
  instructions: [
    'You coordinate specialists. Delegate the investigation to "researcher" with agent.delegate, then transfer',
    'ownership to "executor" with agent.handoff, passing the findings in the payload. Do not inspect files yourself.',
  ].join('\n'),
  tools: [],
  delegates: ['researcher'],
  handoffs: ['executor'],
  maxSteps: 4,
};

export const analystAgents: AgentDefinition[] = [
  plannerAgent,
  researcherAgent,
  executorAgent,
  reviewerAgent,
  coordinatorAgent,
];
