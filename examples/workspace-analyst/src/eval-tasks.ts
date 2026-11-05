import type { EvalTask } from '@loopsmith/evaluation';
import { analystAgents } from './agents.js';
import { analystScripts } from './policies.js';
import { analystHandlers, analystWorkflows, REPORT_PATH } from './workflows.js';

/** End-to-end tasks for the Autonomous Workspace Analyst (need the sample workspace path). */
export function analystEvalTasks(sampleWorkspaceDir: string): EvalTask[] {
  const base = {
    workspaceDir: sampleWorkspaceDir,
    agents: analystAgents,
    workflows: analystWorkflows,
    handlers: analystHandlers,
    script: analystScripts,
  };
  return [
    {
      ...base,
      id: 'workspace-analyst-e2e',
      title: 'Autonomous Workspace Analyst end to end',
      category: 'workflow',
      description:
        'Plan → research → draft → verify → review (one refinement loop) → approved publish.',
      target: { workflow: 'workspace-analyst' },
      goal: 'Analyze this project workspace, identify technical weaknesses, and produce a structured improvement report.',
      approvals: 'approve',
      expect: {
        status: 'completed',
        workflowPath: [
          'plan',
          'research',
          'draft',
          'verify',
          'review',
          'draft',
          'verify',
          'review',
          'publish',
        ],
        toolsExecuted: [
          'workspace.list',
          'workspace.read',
          'workspace.search',
          'calculator.evaluate',
          'memory.store',
          'workspace.write',
        ],
        approvalsRequested: 1,
        events: ['security.flagged', 'memory.stored'],
        files: { [REPORT_PATH]: { exists: true, includes: '## Prioritized recommendations' } },
      },
      liveCompatible: true,
    },
    {
      ...base,
      id: 'workspace-analyst-rejected-publish',
      title: 'Rejected publication leaves the workspace untouched',
      category: 'approvals',
      description:
        'The full workflow runs, the human rejects the write, and no report file is created.',
      target: { workflow: 'workspace-analyst' },
      goal: 'Analyze this workspace and produce an improvement report.',
      approvals: 'reject',
      expect: {
        status: 'completed',
        toolsNotExecuted: ['workspace.write'],
        files: { [REPORT_PATH]: { exists: false } },
      },
    },
    {
      ...base,
      id: 'coordinator-delegate-handoff',
      title: 'Coordinator delegates, then hands off',
      category: 'multi-agent',
      description:
        'coordinator → (delegate) researcher → (handoff) executor, who owns the final report.',
      target: { agent: 'coordinator' },
      goal: 'Assess this workspace and write up the findings.',
      expect: {
        status: 'completed',
        finalAgent: 'executor',
        transfers: 2,
        outputIncludes: ['## Findings'],
      },
    },
  ];
}
