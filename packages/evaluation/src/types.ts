import type {
  AgentDefinition,
  ErrorCategory,
  ExecutionLimits,
  RuntimeEventType,
} from '@loopsmith/core';
import type { CompactionConfig } from '@loopsmith/context';
import type { PolicyConfigInput } from '@loopsmith/policies';
import type { AgentScript } from '@loopsmith/providers';
import type { RegisteredTool } from '@loopsmith/tools';
import type { CodeHandler, WorkflowDefinition } from '@loopsmith/workflow-engine';

export type EvalCategory =
  | 'tool-use'
  | 'recovery'
  | 'security'
  | 'approvals'
  | 'limits'
  | 'context'
  | 'multi-agent'
  | 'workflow';

export interface EvalExpectations {
  status?: 'completed' | 'awaiting_approval' | 'failed' | 'cancelled';
  errorCategory?: ErrorCategory;
  outputIncludes?: string[];
  /** Tools that must have executed successfully. */
  toolsExecuted?: string[];
  /** Tools that must not have executed successfully. */
  toolsNotExecuted?: string[];
  maxModelCalls?: number;
  maxToolCalls?: number;
  approvalsRequested?: number;
  /** Event types that must appear in the trace. */
  events?: RuntimeEventType[];
  files?: Record<string, { exists: boolean; includes?: string }>;
  transfers?: number;
  finalAgent?: string;
  /** Exact sequence of workflow nodes started. */
  workflowPath?: string[];
}

export interface EvalTask {
  id: string;
  title: string;
  category: EvalCategory;
  description: string;
  target: { agent: string } | { workflow: string };
  goal: string;
  /** Workspace fixture files, or a directory to copy. */
  files?: Record<string, string>;
  workspaceDir?: string;
  agents?: AgentDefinition[];
  workflows?: WorkflowDefinition[];
  handlers?: Record<string, CodeHandler>;
  tools?: RegisteredTool[];
  /** Deterministic model behaviour per agent (mock mode). */
  script: Record<string, AgentScript>;
  approvals?: 'approve' | 'reject' | 'none';
  limits?: Partial<ExecutionLimits>;
  policy?: PolicyConfigInput;
  compaction?: Partial<CompactionConfig>;
  expect: EvalExpectations;
  /** Meaningful against a live model (expectations do not rely on scripted misbehaviour). */
  liveCompatible?: boolean;
}

export interface EvalCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface EvalTaskResult {
  id: string;
  title: string;
  category: EvalCategory;
  passed: boolean;
  status: string;
  checks: EvalCheck[];
  modelCalls: number;
  toolCalls: number;
  invalidToolArguments: number;
  approvalsRequested: number;
  retries: number;
  recoveries: number;
  durationMs: number;
  tokens: { input: number; output: number; reported: boolean };
  runId: string;
  error?: string;
}

export interface EvalSummary {
  mode: 'mock' | 'live';
  provider: string;
  generatedAt: string;
  tasks: number;
  passed: number;
  passRate: number;
  completionRate: number | null;
  toolSelectionAccuracy: number | null;
  toolArgumentValidity: number | null;
  workflowCompletionRate: number | null;
  approvalPolicyEnforcement: number;
  recoveryPassRate: number | null;
  avgModelCalls: number;
  avgToolCalls: number;
  avgDurationMs: number;
  tokens: { input: number; output: number; reported: boolean };
  byCategory: Record<string, { tasks: number; passed: number }>;
}

export interface EvalReport {
  summary: EvalSummary;
  results: EvalTaskResult[];
}
