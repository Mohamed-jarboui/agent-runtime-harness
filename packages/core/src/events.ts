/**
 * The complete vocabulary of structured execution events. Every state change
 * in the runtime emits exactly one of these; traces, metrics, evaluation and
 * the terminal renderer are all derived from the same event stream.
 */
export const EVENT_TYPES = [
  'run.started',
  'run.resumed',
  'run.paused',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'agent.selected',
  'agent.handoff',
  'agent.delegation.started',
  'agent.delegation.completed',
  'model.request',
  'model.response',
  'model.retry',
  'model.fallback',
  'model.error',
  'tool.requested',
  'tool.policy',
  'tool.approved',
  'tool.rejected',
  'tool.denied',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'approval.requested',
  'approval.decided',
  'workflow.started',
  'workflow.resumed',
  'workflow.node.started',
  'workflow.node.completed',
  'workflow.node.failed',
  'workflow.node.retry',
  'workflow.transition',
  'workflow.checkpoint',
  'workflow.paused',
  'workflow.completed',
  'workflow.failed',
  'context.built',
  'context.compacted',
  'memory.recalled',
  'memory.stored',
  'recovery.attempted',
  'limit.exceeded',
  'security.flagged',
  'error',
] as const;

export type RuntimeEventType = (typeof EVENT_TYPES)[number];

export interface RuntimeEvent {
  id: string;
  type: RuntimeEventType;
  /** ISO-8601 timestamp. */
  timestamp: string;
  sessionId: string;
  runId: string;
  /** Root of the run tree (workflow run or top-level agent run). */
  rootRunId: string;
  agentId?: string;
  nodeId?: string;
  durationMs?: number;
  data: Record<string, unknown>;
}

export type EventInput = Omit<RuntimeEvent, 'id' | 'timestamp'> & { timestamp?: string };

export interface EventSink {
  emit(event: EventInput): RuntimeEvent;
}
