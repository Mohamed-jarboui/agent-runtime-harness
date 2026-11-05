/**
 * Forward-only schema migrations. Each entry is applied once inside a
 * transaction and recorded in `schema_migrations`. Never edit a released
 * migration; append a new one.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'workflow')),
  parent_run_id TEXT REFERENCES runs(id),
  root_run_id TEXT NOT NULL,
  agent_id TEXT,
  workflow_id TEXT,
  node_id TEXT,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  handoff_count INTEGER NOT NULL DEFAULT 0,
  delegation_depth INTEGER NOT NULL DEFAULT 0,
  recovery_count INTEGER NOT NULL DEFAULT 0,
  input TEXT,
  output TEXT,
  error TEXT,
  usage TEXT NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"reported":false}',
  config TEXT NOT NULL DEFAULT '{}',
  compacted_through_seq INTEGER NOT NULL DEFAULT -1,
  owner_pid INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX idx_runs_root ON runs(root_run_id);
CREATE INDEX idx_runs_parent ON runs(parent_run_id);
CREATE INDEX idx_runs_status ON runs(status);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  model_call_id TEXT NOT NULL,
  message_seq INTEGER NOT NULL,
  agent_id TEXT,
  tool_name TEXT NOT NULL,
  arguments TEXT,
  status TEXT NOT NULL,
  policy_effect TEXT,
  approval_id TEXT,
  child_run_id TEXT,
  result_content TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  result_appended INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tool_calls_run ON tool_calls(run_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  root_run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tool', 'workflow_gate')),
  tool_call_id TEXT,
  tool_name TEXT,
  arguments TEXT,
  agent_id TEXT,
  node_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status);
CREATE INDEX idx_approvals_root ON approvals(root_run_id);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  node_id TEXT,
  status TEXT NOT NULL,
  state TEXT NOT NULL,
  visits TEXT NOT NULL,
  step INTEGER NOT NULL,
  history TEXT NOT NULL,
  pending TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_run_id, seq)
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  root_run_id TEXT NOT NULL,
  agent_id TEXT,
  node_id TEXT,
  timestamp TEXT NOT NULL,
  duration_ms INTEGER,
  data TEXT NOT NULL
);
CREATE INDEX idx_events_root ON events(root_run_id, seq);
CREATE INDEX idx_events_run ON events(run_id, seq);

CREATE TABLE memory_records (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('session', 'global')),
  session_id TEXT,
  run_id TEXT,
  agent_id TEXT,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_memory_session ON memory_records(session_id);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  content, tags, content='memory_records', content_rowid='rowid'
);
CREATE TRIGGER memory_ai AFTER INSERT ON memory_records BEGIN
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
CREATE TRIGGER memory_ad AFTER DELETE ON memory_records BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
END;

CREATE TABLE summaries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  through_seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  strategy TEXT NOT NULL,
  tokens_before INTEGER NOT NULL,
  tokens_after INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  root_run_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('handoff', 'delegation')),
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload TEXT,
  depth INTEGER NOT NULL,
  child_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_handoffs_root ON handoffs(root_run_id);
`,
  },
];
