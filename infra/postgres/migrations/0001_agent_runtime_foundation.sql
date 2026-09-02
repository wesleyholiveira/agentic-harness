CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  executor TEXT,
  workspace_mode TEXT,
  max_parallel INTEGER NOT NULL DEFAULT 1,
  peak_parallel INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT,
  reasoning_mode TEXT,
  reasoning_source TEXT,
  initial_reasoning_level TEXT,
  reasoning_confidence REAL,
  engine TEXT NOT NULL DEFAULT 'legacy',
  graph_version TEXT,
  state_version INTEGER NOT NULL DEFAULT 0
);

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_tasks (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  dependencies_json TEXT NOT NULL,
  owned_paths_json TEXT NOT NULL,
  brief_path TEXT,
  context_path TEXT,
  handoff_path TEXT,
  workspace_path TEXT,
  context_bytes INTEGER NOT NULL DEFAULT 0,
  context_documents INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  used_context_documents INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  reasoning_level TEXT,
  reasoning_source TEXT,
  reasoning_reasons_json TEXT,
  state_version INTEGER NOT NULL DEFAULT 0,
  UNIQUE(run_id, agent_id)
);

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  task_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  task_id TEXT,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT,
  accepted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_conflicts (
  conflict_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  task_id TEXT,
  path TEXT NOT NULL,
  conflict_type TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_integrated_paths (
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  task_id TEXT NOT NULL,
  fingerprint TEXT,
  integrated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, path)
);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_tasks_run_status ON agent_tasks(run_id, status);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_events_run_created ON agent_events(run_id, created_at);
