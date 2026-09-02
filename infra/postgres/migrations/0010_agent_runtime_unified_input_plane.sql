-- R16 Unified Agent Input Plane
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS input_manifest_path TEXT;
-- statement-breakpoint
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS input_manifest_fingerprint TEXT;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_input_artifact_receipts (
  receipt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  manifest_fingerprint TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, task_id, attempt, manifest_fingerprint, artifact_ref)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_input_artifact_receipts_task_attempt
  ON agent_input_artifact_receipts(run_id, task_id, attempt);
