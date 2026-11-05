import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import {
  LoopSmithError,
  newId,
  nowIso,
  safeJsonParse,
  safeStringify,
  type ApprovalRecord,
  type ApprovalStatus,
  type ChatMessage,
  type CheckpointRecord,
  type HandoffRecord,
  type ListRunsOptions,
  type MemoryRecord,
  type MemorySearchHit,
  type MessageRecord,
  type NewRun,
  type RunPatch,
  type RunRecord,
  type RuntimeEvent,
  type SessionRecord,
  type StateStore,
  type SummaryRecord,
  type ToolCallRecord,
} from '@loopsmith/core';
import { MIGRATIONS } from './migrations.js';

type Row = Record<string, unknown>;

const json = (value: unknown): string | null => (value === undefined ? null : safeStringify(value));

function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  const parsed = safeJsonParse<T>(value);
  return parsed.ok ? parsed.value : fallback;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

export interface SqliteStoreOptions {
  /** File path, or `:memory:` for an ephemeral database. */
  path: string;
  readonly?: boolean;
}

/**
 * SQLite implementation of {@link StateStore}. Uses WAL mode so a CLI
 * inspecting runs never blocks a process that is executing one.
 */
export class SqliteStateStore implements StateStore {
  private readonly db: Database.Database;

  constructor(options: SqliteStoreOptions) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    try {
      this.db = new Database(options.path, { readonly: options.readonly ?? false });
    } catch (err) {
      throw new LoopSmithError('storage', `Cannot open database at ${options.path}`, {
        cause: err,
      });
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  /** Applied migration versions, newest last. */
  schemaVersions(): number[] {
    return (
      this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Row[]
    ).map((r) => num(r.version));
  }

  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    const applied = new Set(this.schemaVersions());
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, nowIso());
      })();
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  // ---------------------------------------------------------------- sessions

  createSession(input: {
    id?: string;
    title: string;
    metadata?: Record<string, unknown>;
  }): SessionRecord {
    const now = nowIso();
    const record: SessionRecord = {
      id: input.id ?? newId('ses'),
      title: input.title,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO sessions (id, title, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(record.id, record.title, json(record.metadata), now, now);
    return record;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: str(row.id),
      title: str(row.title),
      metadata: parse(row.metadata, {}),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  // -------------------------------------------------------------------- runs

  createRun(input: NewRun): RunRecord {
    const now = nowIso();
    const id = input.id ?? newId(input.kind === 'workflow' ? 'wf' : 'run');
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, kind, parent_run_id, root_run_id, agent_id, workflow_id, node_id,
          goal, status, delegation_depth, input, config, created_at, updated_at)
         VALUES (@id, @session_id, @kind, @parent_run_id, @root_run_id, @agent_id, @workflow_id, @node_id,
          @goal, @status, @delegation_depth, @input, @config, @now, @now)`,
      )
      .run({
        id,
        session_id: input.sessionId,
        kind: input.kind,
        parent_run_id: input.parentRunId ?? null,
        root_run_id: input.rootRunId ?? id,
        agent_id: input.agentId ?? null,
        workflow_id: input.workflowId ?? null,
        node_id: input.nodeId ?? null,
        goal: input.goal,
        status: input.status ?? 'pending',
        delegation_depth: input.delegationDepth ?? 0,
        input: json(input.input ?? null),
        config: json(input.config ?? {}),
        now,
      });
    return this.getRun(id) as RunRecord;
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toRun(row) : undefined;
  }

  updateRun(id: string, patch: RunPatch): RunRecord {
    const columns: Record<keyof RunPatch, string> = {
      parentRunId: 'parent_run_id',
      agentId: 'agent_id',
      workflowId: 'workflow_id',
      nodeId: 'node_id',
      goal: 'goal',
      status: 'status',
      iteration: 'iteration',
      toolCallCount: 'tool_call_count',
      handoffCount: 'handoff_count',
      delegationDepth: 'delegation_depth',
      recoveryCount: 'recovery_count',
      input: 'input',
      output: 'output',
      error: 'error',
      usage: 'usage',
      config: 'config',
      compactedThroughSeq: 'compacted_through_seq',
      ownerPid: 'owner_pid',
      updatedAt: 'updated_at',
      startedAt: 'started_at',
      endedAt: 'ended_at',
    };
    const jsonColumns = new Set(['input', 'output', 'error', 'usage', 'config']);
    const sets: string[] = [];
    const values: Record<string, unknown> = { id };
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key as keyof RunPatch];
      if (!column || value === undefined) continue;
      sets.push(`${column} = @${column}`);
      values[column] = jsonColumns.has(key) ? json(value) : value;
    }
    sets.push('updated_at = @updated_at');
    values.updated_at = nowIso();
    const result = this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = @id`).run(values);
    if (result.changes === 0) throw new LoopSmithError('storage', `Run not found: ${id}`);
    return this.getRun(id) as RunRecord;
  }

  listRuns(options: ListRunsOptions = {}): RunRecord[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 50 };
    if (options.status) {
      where.push('status = @status');
      params.status = options.status;
    }
    if (options.rootOnly) where.push('parent_run_id IS NULL');
    if (options.parentRunId) {
      where.push('parent_run_id = @parent');
      params.parent = options.parentRunId;
    }
    if (options.rootRunId) {
      where.push('root_run_id = @root');
      params.root = options.rootRunId;
    }
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, rowid DESC LIMIT @limit`;
    return (this.db.prepare(sql).all(params) as Row[]).map((r) => this.toRun(r));
  }

  private toRun(row: Row): RunRecord {
    return {
      id: str(row.id),
      sessionId: str(row.session_id),
      kind: str(row.kind) as RunRecord['kind'],
      parentRunId: strOrNull(row.parent_run_id),
      rootRunId: str(row.root_run_id),
      agentId: strOrNull(row.agent_id),
      workflowId: strOrNull(row.workflow_id),
      nodeId: strOrNull(row.node_id),
      goal: str(row.goal),
      status: str(row.status) as RunRecord['status'],
      iteration: num(row.iteration),
      toolCallCount: num(row.tool_call_count),
      handoffCount: num(row.handoff_count),
      delegationDepth: num(row.delegation_depth),
      recoveryCount: num(row.recovery_count),
      input: parse(row.input, null),
      output: parse(row.output, null),
      error: parse(row.error, null),
      usage: parse(row.usage, { inputTokens: 0, outputTokens: 0, reported: false }),
      config: parse(row.config, {}),
      compactedThroughSeq: num(row.compacted_through_seq),
      ownerPid: row.owner_pid === null || row.owner_pid === undefined ? null : num(row.owner_pid),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
      startedAt: strOrNull(row.started_at),
      endedAt: strOrNull(row.ended_at),
    };
  }

  // ---------------------------------------------------------------- messages

  appendMessage(runId: string, message: ChatMessage, agentId: string | null): MessageRecord {
    return this.transaction(() => {
      const next = this.db
        .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE run_id = ?')
        .get(runId) as Row;
      const record: MessageRecord = {
        id: newId('msg'),
        runId,
        seq: num(next.next),
        agentId,
        message,
        createdAt: nowIso(),
      };
      this.db
        .prepare(
          'INSERT INTO messages (id, run_id, seq, role, agent_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(record.id, runId, record.seq, message.role, agentId, json(message), record.createdAt);
      return record;
    });
  }

  listMessages(runId: string, afterSeq = -1): MessageRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE run_id = ? AND seq > ? ORDER BY seq')
      .all(runId, afterSeq) as Row[];
    return rows.map((row) => ({
      id: str(row.id),
      runId: str(row.run_id),
      seq: num(row.seq),
      agentId: strOrNull(row.agent_id),
      message: parse<ChatMessage>(row.content, { role: 'user', content: '' }),
      createdAt: str(row.created_at),
    }));
  }

  // -------------------------------------------------------------- tool calls

  upsertToolCall(record: ToolCallRecord): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, run_id, model_call_id, message_seq, agent_id, tool_name, arguments, status,
          policy_effect, approval_id, child_run_id, result_content, is_error, error, result_appended,
          started_at, ended_at, duration_ms, created_at)
         VALUES (@id, @run_id, @model_call_id, @message_seq, @agent_id, @tool_name, @arguments, @status,
          @policy_effect, @approval_id, @child_run_id, @result_content, @is_error, @error, @result_appended,
          @started_at, @ended_at, @duration_ms, @created_at)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, policy_effect = excluded.policy_effect,
          approval_id = excluded.approval_id, child_run_id = excluded.child_run_id,
          result_content = excluded.result_content, is_error = excluded.is_error, error = excluded.error,
          result_appended = excluded.result_appended, started_at = excluded.started_at,
          ended_at = excluded.ended_at, duration_ms = excluded.duration_ms`,
      )
      .run({
        id: record.id,
        run_id: record.runId,
        model_call_id: record.modelCallId,
        message_seq: record.messageSeq,
        agent_id: record.agentId,
        tool_name: record.toolName,
        arguments: json(record.arguments),
        status: record.status,
        policy_effect: record.policyEffect,
        approval_id: record.approvalId,
        child_run_id: record.childRunId,
        result_content: record.resultContent,
        is_error: record.isError ? 1 : 0,
        error: json(record.error),
        result_appended: record.resultAppended ? 1 : 0,
        started_at: record.startedAt,
        ended_at: record.endedAt,
        duration_ms: record.durationMs,
        created_at: record.createdAt,
      });
  }

  getToolCall(id: string): ToolCallRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toToolCall(row) : undefined;
  }

  listToolCalls(runId: string): ToolCallRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY message_seq, rowid')
        .all(runId) as Row[]
    ).map((r) => this.toToolCall(r));
  }

  private toToolCall(row: Row): ToolCallRecord {
    return {
      id: str(row.id),
      runId: str(row.run_id),
      modelCallId: str(row.model_call_id),
      messageSeq: num(row.message_seq),
      agentId: strOrNull(row.agent_id),
      toolName: str(row.tool_name),
      arguments: parse(row.arguments, null),
      status: str(row.status) as ToolCallRecord['status'],
      policyEffect: strOrNull(row.policy_effect) as ToolCallRecord['policyEffect'],
      approvalId: strOrNull(row.approval_id),
      childRunId: strOrNull(row.child_run_id),
      resultContent: strOrNull(row.result_content),
      isError: num(row.is_error) === 1,
      error: parse(row.error, null),
      resultAppended: num(row.result_appended) === 1,
      startedAt: strOrNull(row.started_at),
      endedAt: strOrNull(row.ended_at),
      durationMs: row.duration_ms === null ? null : num(row.duration_ms),
      createdAt: str(row.created_at),
    };
  }

  // --------------------------------------------------------------- approvals

  createApproval(
    input: Omit<
      ApprovalRecord,
      'id' | 'createdAt' | 'decidedAt' | 'decidedBy' | 'decisionNote' | 'status'
    > & {
      id?: string;
    },
  ): ApprovalRecord {
    const id = input.id ?? newId('apr');
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, root_run_id, kind, tool_call_id, tool_name, arguments, agent_id, node_id,
          reason, status, created_at)
         VALUES (@id, @run_id, @root_run_id, @kind, @tool_call_id, @tool_name, @arguments, @agent_id, @node_id,
          @reason, 'pending', @created_at)`,
      )
      .run({
        id,
        run_id: input.runId,
        root_run_id: input.rootRunId,
        kind: input.kind,
        tool_call_id: input.toolCallId,
        tool_name: input.toolName,
        arguments: json(input.arguments),
        agent_id: input.agentId,
        node_id: input.nodeId,
        reason: input.reason,
        created_at: nowIso(),
      });
    return this.getApproval(id) as ApprovalRecord;
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toApproval(row) : undefined;
  }

  decideApproval(
    id: string,
    decision: { status: 'approved' | 'rejected'; by: string; note?: string },
  ): ApprovalRecord {
    const existing = this.getApproval(id);
    if (!existing) throw new LoopSmithError('storage', `Approval not found: ${id}`);
    if (existing.status !== 'pending') {
      throw new LoopSmithError('configuration', `Approval ${id} was already ${existing.status}`, {
        code: 'approval_already_decided',
      });
    }
    this.db
      .prepare(
        'UPDATE approvals SET status = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ?',
      )
      .run(decision.status, decision.by, decision.note ?? null, nowIso(), id);
    return this.getApproval(id) as ApprovalRecord;
  }

  listApprovals(
    options: { status?: ApprovalStatus; runId?: string; rootRunId?: string; limit?: number } = {},
  ): ApprovalRecord[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 100 };
    if (options.status) {
      where.push('status = @status');
      params.status = options.status;
    }
    if (options.runId) {
      where.push('run_id = @run');
      params.run = options.runId;
    }
    if (options.rootRunId) {
      where.push('root_run_id = @root');
      params.root = options.rootRunId;
    }
    const sql = `SELECT * FROM approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, rowid DESC LIMIT @limit`;
    return (this.db.prepare(sql).all(params) as Row[]).map((r) => this.toApproval(r));
  }

  private toApproval(row: Row): ApprovalRecord {
    return {
      id: str(row.id),
      runId: str(row.run_id),
      rootRunId: str(row.root_run_id),
      kind: str(row.kind) as ApprovalRecord['kind'],
      toolCallId: strOrNull(row.tool_call_id),
      toolName: strOrNull(row.tool_name),
      arguments: parse(row.arguments, null),
      agentId: strOrNull(row.agent_id),
      nodeId: strOrNull(row.node_id),
      reason: str(row.reason),
      status: str(row.status) as ApprovalStatus,
      decidedBy: strOrNull(row.decided_by),
      decisionNote: strOrNull(row.decision_note),
      createdAt: str(row.created_at),
      decidedAt: strOrNull(row.decided_at),
    };
  }

  // ------------------------------------------------------------- checkpoints

  saveCheckpoint(input: Omit<CheckpointRecord, 'id' | 'seq' | 'createdAt'>): CheckpointRecord {
    return this.transaction(() => {
      const next = this.db
        .prepare(
          'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM checkpoints WHERE workflow_run_id = ?',
        )
        .get(input.workflowRunId) as Row;
      const record: CheckpointRecord = {
        ...input,
        id: newId('ckp'),
        seq: num(next.next),
        createdAt: nowIso(),
      };
      this.db
        .prepare(
          `INSERT INTO checkpoints (id, workflow_run_id, seq, node_id, status, state, visits, step, history, pending, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.workflowRunId,
          record.seq,
          record.nodeId,
          record.status,
          json(record.state),
          json(record.visits),
          record.step,
          json(record.history),
          json(record.pending),
          record.createdAt,
        );
      return record;
    });
  }

  getLatestCheckpoint(workflowRunId: string): CheckpointRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM checkpoints WHERE workflow_run_id = ? ORDER BY seq DESC LIMIT 1')
      .get(workflowRunId) as Row | undefined;
    return row ? this.toCheckpoint(row) : undefined;
  }

  listCheckpoints(workflowRunId: string): CheckpointRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM checkpoints WHERE workflow_run_id = ? ORDER BY seq')
        .all(workflowRunId) as Row[]
    ).map((r) => this.toCheckpoint(r));
  }

  private toCheckpoint(row: Row): CheckpointRecord {
    return {
      id: str(row.id),
      workflowRunId: str(row.workflow_run_id),
      seq: num(row.seq),
      nodeId: strOrNull(row.node_id),
      status: str(row.status) as CheckpointRecord['status'],
      state: parse(row.state, {}),
      visits: parse(row.visits, {}),
      step: num(row.step),
      history: parse(row.history, []),
      pending: parse(row.pending, null),
      createdAt: str(row.created_at),
    };
  }

  // ------------------------------------------------------------------ events

  appendEvent(event: RuntimeEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (id, type, session_id, run_id, root_run_id, agent_id, node_id, timestamp, duration_ms, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.type,
        event.sessionId,
        event.runId,
        event.rootRunId,
        event.agentId ?? null,
        event.nodeId ?? null,
        event.timestamp,
        event.durationMs ?? null,
        json(event.data),
      );
  }

  listEvents(options: { rootRunId?: string; runId?: string; limit?: number }): RuntimeEvent[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 100_000 };
    if (options.rootRunId) {
      where.push('root_run_id = @root');
      params.root = options.rootRunId;
    }
    if (options.runId) {
      where.push('run_id = @run');
      params.run = options.runId;
    }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq LIMIT @limit`;
    return (this.db.prepare(sql).all(params) as Row[]).map((row) => {
      const event: RuntimeEvent = {
        id: str(row.id),
        type: str(row.type) as RuntimeEvent['type'],
        timestamp: str(row.timestamp),
        sessionId: str(row.session_id),
        runId: str(row.run_id),
        rootRunId: str(row.root_run_id),
        data: parse(row.data, {}),
      };
      if (typeof row.agent_id === 'string') event.agentId = row.agent_id;
      if (typeof row.node_id === 'string') event.nodeId = row.node_id;
      if (typeof row.duration_ms === 'number') event.durationMs = row.duration_ms;
      return event;
    });
  }

  // ------------------------------------------------------------------ memory

  storeMemory(input: Omit<MemoryRecord, 'id' | 'createdAt'>): MemoryRecord {
    const record: MemoryRecord = { ...input, id: newId('mem'), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO memory_records (id, scope, session_id, run_id, agent_id, content, tags, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.scope,
        record.sessionId,
        record.runId,
        record.agentId,
        record.content,
        json(record.tags),
        record.source,
        record.createdAt,
      );
    return record;
  }

  listMemory(
    options: { sessionId?: string; scope?: 'session' | 'global'; limit?: number } = {},
  ): MemoryRecord[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 100 };
    if (options.sessionId) {
      where.push('session_id = @session');
      params.session = options.sessionId;
    }
    if (options.scope) {
      where.push('scope = @scope');
      params.scope = options.scope;
    }
    const sql = `SELECT * FROM memory_records ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY rowid DESC LIMIT @limit`;
    return (this.db.prepare(sql).all(params) as Row[]).map((r) => this.toMemory(r));
  }

  searchMemory(
    ftsQuery: string,
    options: { sessionId?: string; scope?: 'session' | 'global' | 'all'; limit?: number } = {},
  ): MemorySearchHit[] {
    if (ftsQuery.trim() === '') return [];
    const where = ['memory_fts MATCH @query'];
    const params: Record<string, unknown> = { query: ftsQuery, limit: options.limit ?? 10 };
    const scope = options.scope ?? 'all';
    if (scope === 'session') {
      where.push("m.scope = 'session' AND m.session_id = @session");
      params.session = options.sessionId ?? '';
    } else if (scope === 'global') {
      where.push("m.scope = 'global'");
    } else if (options.sessionId) {
      where.push("(m.scope = 'global' OR m.session_id = @session)");
      params.session = options.sessionId;
    }
    const sql = `SELECT m.*, bm25(memory_fts) AS rank FROM memory_fts
      JOIN memory_records m ON m.rowid = memory_fts.rowid
      WHERE ${where.join(' AND ')} ORDER BY rank LIMIT @limit`;
    try {
      return (this.db.prepare(sql).all(params) as Row[]).map((r) => ({
        ...this.toMemory(r),
        // bm25() is lower-is-better and negative; flip it so higher is better.
        score: Math.round(-num(r.rank) * 1e6) / 1e6,
      }));
    } catch (err) {
      throw new LoopSmithError('storage', 'Memory search failed', {
        cause: err,
        details: { ftsQuery },
      });
    }
  }

  private toMemory(row: Row): MemoryRecord {
    return {
      id: str(row.id),
      scope: str(row.scope) as MemoryRecord['scope'],
      sessionId: strOrNull(row.session_id),
      runId: strOrNull(row.run_id),
      agentId: strOrNull(row.agent_id),
      content: str(row.content),
      tags: parse(row.tags, []),
      source: str(row.source),
      createdAt: str(row.created_at),
    };
  }

  // --------------------------------------------------------------- summaries

  saveSummary(input: Omit<SummaryRecord, 'id' | 'createdAt'>): SummaryRecord {
    const record: SummaryRecord = { ...input, id: newId('sum'), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO summaries (id, run_id, through_seq, content, strategy, tokens_before, tokens_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.throughSeq,
        record.content,
        record.strategy,
        record.tokensBefore,
        record.tokensAfter,
        record.createdAt,
      );
    return record;
  }

  getLatestSummary(runId: string): SummaryRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM summaries WHERE run_id = ? ORDER BY through_seq DESC, rowid DESC LIMIT 1',
      )
      .get(runId) as Row | undefined;
    if (!row) return undefined;
    return {
      id: str(row.id),
      runId: str(row.run_id),
      throughSeq: num(row.through_seq),
      content: str(row.content),
      strategy: str(row.strategy),
      tokensBefore: num(row.tokens_before),
      tokensAfter: num(row.tokens_after),
      createdAt: str(row.created_at),
    };
  }

  // ---------------------------------------------------------------- handoffs

  recordHandoff(input: Omit<HandoffRecord, 'id' | 'createdAt'>): HandoffRecord {
    const record: HandoffRecord = { ...input, id: newId('hof'), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO handoffs (id, root_run_id, run_id, kind, from_agent, to_agent, reason, payload, depth, child_run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.rootRunId,
        record.runId,
        record.kind,
        record.fromAgent,
        record.toAgent,
        record.reason,
        json(record.payload),
        record.depth,
        record.childRunId,
        record.createdAt,
      );
    return record;
  }

  listHandoffs(rootRunId: string): HandoffRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM handoffs WHERE root_run_id = ? ORDER BY created_at, rowid')
        .all(rootRunId) as Row[]
    ).map((row) => ({
      id: str(row.id),
      rootRunId: str(row.root_run_id),
      runId: str(row.run_id),
      kind: str(row.kind) as HandoffRecord['kind'],
      fromAgent: str(row.from_agent),
      toAgent: str(row.to_agent),
      reason: str(row.reason),
      payload: parse(row.payload, null),
      depth: num(row.depth),
      childRunId: strOrNull(row.child_run_id),
      createdAt: str(row.created_at),
    }));
  }
}
