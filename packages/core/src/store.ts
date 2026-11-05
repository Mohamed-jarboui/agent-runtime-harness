/**
 * Storage contracts. The runtime depends only on these interfaces; the
 * SQLite implementation lives in `@loopsmith/storage`. The API is synchronous
 * on purpose: SQLite via better-sqlite3 is synchronous and transactional, and
 * keeping writes synchronous makes every state transition atomic with respect
 * to the event loop.
 */
import type { SerializedError } from './errors.js';
import type { RuntimeEvent } from './events.js';
import type { ChatMessage, TokenUsage } from './model.js';
import type { PermissionEffect } from './permissions.js';

export type RunKind = 'agent' | 'workflow';
export type RunStatus =
  'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  kind: RunKind;
  parentRunId: string | null;
  rootRunId: string;
  /** Current owner agent (changes on handoff). */
  agentId: string | null;
  workflowId: string | null;
  /** Workflow node that spawned this run, if any. */
  nodeId: string | null;
  goal: string;
  status: RunStatus;
  iteration: number;
  toolCallCount: number;
  handoffCount: number;
  delegationDepth: number;
  recoveryCount: number;
  input: unknown;
  output: unknown;
  error: SerializedError | null;
  usage: TokenUsage & { reported: boolean };
  config: Record<string, unknown>;
  compactedThroughSeq: number;
  ownerPid: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export type NewRun = Pick<RunRecord, 'sessionId' | 'kind' | 'goal'> &
  Partial<
    Pick<
      RunRecord,
      | 'id'
      | 'parentRunId'
      | 'rootRunId'
      | 'agentId'
      | 'workflowId'
      | 'nodeId'
      | 'delegationDepth'
      | 'input'
      | 'config'
      | 'status'
    >
  >;

export type RunPatch = Partial<
  Omit<RunRecord, 'id' | 'sessionId' | 'kind' | 'rootRunId' | 'createdAt'>
>;

export interface MessageRecord {
  id: string;
  runId: string;
  seq: number;
  agentId: string | null;
  message: ChatMessage;
  createdAt: string;
}

export type ToolCallStatus =
  | 'requested'
  | 'awaiting_approval'
  | 'executing'
  | 'awaiting_child'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'rejected';

export interface ToolCallRecord {
  /** Primary key: `${runId}:${modelCallId}`. */
  id: string;
  runId: string;
  modelCallId: string;
  messageSeq: number;
  agentId: string | null;
  toolName: string;
  arguments: unknown;
  status: ToolCallStatus;
  policyEffect: PermissionEffect | null;
  approvalId: string | null;
  childRunId: string | null;
  resultContent: string | null;
  isError: boolean;
  error: SerializedError | null;
  /** Whether the result has been appended to the transcript. */
  resultAppended: boolean;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  createdAt: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRecord {
  id: string;
  runId: string;
  rootRunId: string;
  kind: 'tool' | 'workflow_gate';
  toolCallId: string | null;
  toolName: string | null;
  arguments: unknown;
  agentId: string | null;
  nodeId: string | null;
  reason: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface CheckpointRecord {
  id: string;
  workflowRunId: string;
  seq: number;
  nodeId: string | null;
  status: RunStatus;
  state: Record<string, unknown>;
  visits: Record<string, number>;
  step: number;
  history: Array<{ nodeId: string; outcome: string; at: string; to?: string }>;
  pending: {
    nodeId: string;
    kind: 'agent' | 'tool' | 'approval';
    ref: string;
    attempt: number;
  } | null;
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  scope: 'session' | 'global';
  sessionId: string | null;
  runId: string | null;
  agentId: string | null;
  content: string;
  tags: string[];
  source: string;
  createdAt: string;
}

export interface MemorySearchHit extends MemoryRecord {
  /** Relevance score; higher is better. Comparable only within one query. */
  score: number;
}

export interface SummaryRecord {
  id: string;
  runId: string;
  throughSeq: number;
  content: string;
  strategy: string;
  tokensBefore: number;
  tokensAfter: number;
  createdAt: string;
}

export interface HandoffRecord {
  id: string;
  rootRunId: string;
  runId: string;
  kind: 'handoff' | 'delegation';
  fromAgent: string;
  toAgent: string;
  reason: string;
  payload: unknown;
  depth: number;
  childRunId: string | null;
  createdAt: string;
}

export interface ListRunsOptions {
  limit?: number;
  status?: RunStatus;
  rootOnly?: boolean;
  parentRunId?: string;
  rootRunId?: string;
}

export interface StateStore {
  transaction<T>(fn: () => T): T;
  close(): void;

  createSession(input: {
    id?: string;
    title: string;
    metadata?: Record<string, unknown>;
  }): SessionRecord;
  getSession(id: string): SessionRecord | undefined;

  createRun(input: NewRun): RunRecord;
  getRun(id: string): RunRecord | undefined;
  updateRun(id: string, patch: RunPatch): RunRecord;
  listRuns(options?: ListRunsOptions): RunRecord[];

  appendMessage(runId: string, message: ChatMessage, agentId: string | null): MessageRecord;
  listMessages(runId: string, afterSeq?: number): MessageRecord[];

  upsertToolCall(record: ToolCallRecord): void;
  getToolCall(id: string): ToolCallRecord | undefined;
  listToolCalls(runId: string): ToolCallRecord[];

  createApproval(
    input: Omit<
      ApprovalRecord,
      'id' | 'createdAt' | 'decidedAt' | 'decidedBy' | 'decisionNote' | 'status'
    > & { id?: string },
  ): ApprovalRecord;
  getApproval(id: string): ApprovalRecord | undefined;
  decideApproval(
    id: string,
    decision: { status: 'approved' | 'rejected'; by: string; note?: string },
  ): ApprovalRecord;
  listApprovals(options?: {
    status?: ApprovalStatus;
    runId?: string;
    rootRunId?: string;
    limit?: number;
  }): ApprovalRecord[];

  saveCheckpoint(input: Omit<CheckpointRecord, 'id' | 'seq' | 'createdAt'>): CheckpointRecord;
  getLatestCheckpoint(workflowRunId: string): CheckpointRecord | undefined;
  listCheckpoints(workflowRunId: string): CheckpointRecord[];

  appendEvent(event: RuntimeEvent): void;
  listEvents(options: { rootRunId?: string; runId?: string; limit?: number }): RuntimeEvent[];

  storeMemory(input: Omit<MemoryRecord, 'id' | 'createdAt'>): MemoryRecord;
  listMemory(options?: {
    sessionId?: string;
    scope?: 'session' | 'global';
    limit?: number;
  }): MemoryRecord[];
  /** Full-text search. `ftsQuery` must already be sanitised by the caller. */
  searchMemory(
    ftsQuery: string,
    options?: { sessionId?: string; scope?: 'session' | 'global' | 'all'; limit?: number },
  ): MemorySearchHit[];

  saveSummary(input: Omit<SummaryRecord, 'id' | 'createdAt'>): SummaryRecord;
  getLatestSummary(runId: string): SummaryRecord | undefined;

  recordHandoff(input: Omit<HandoffRecord, 'id' | 'createdAt'>): HandoffRecord;
  listHandoffs(rootRunId: string): HandoffRecord[];
}
