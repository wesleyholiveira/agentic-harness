CREATE TABLE IF NOT EXISTS context_project_memory_decisions (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  rationale TEXT NOT NULL,
  files JSONB NOT NULL,
  symbols JSONB NOT NULL,
  commit_sha TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  search_tokens TEXT[] NOT NULL DEFAULT '{}',
  PRIMARY KEY(project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_context_project_memory_decisions_tokens
  ON context_project_memory_decisions USING GIN(search_tokens);
CREATE INDEX IF NOT EXISTS idx_context_project_memory_decisions_created
  ON context_project_memory_decisions(project_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS context_project_memory_task_history (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_desc TEXT NOT NULL,
  context_pack_hash TEXT NOT NULL,
  outcome TEXT NOT NULL,
  files_touched JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  search_tokens TEXT[] NOT NULL DEFAULT '{}',
  PRIMARY KEY(project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_context_project_memory_tasks_tokens
  ON context_project_memory_task_history USING GIN(search_tokens);
CREATE INDEX IF NOT EXISTS idx_context_project_memory_tasks_created
  ON context_project_memory_task_history(project_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS context_project_memory_migrations (
  project_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  decision_count BIGINT NOT NULL,
  task_count BIGINT NOT NULL,
  source_revision TEXT NOT NULL,
  dataset_digest TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, schema_version)
);
