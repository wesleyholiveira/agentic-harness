-- Context Engine ProjectMemory revision ledger.
-- Forward-only follow-up to 0050: installations may already have applied 0050,
-- so revision state is introduced in a new migration rather than by rewriting
-- historical migration authority.

CREATE TABLE IF NOT EXISTS context_project_memory_revision (
  project_id TEXT PRIMARY KEY,
  decision_count BIGINT NOT NULL DEFAULT 0 CHECK (decision_count >= 0),
  decision_latest BIGINT NOT NULL DEFAULT 0 CHECK (decision_latest >= 0),
  task_count BIGINT NOT NULL DEFAULT 0 CHECK (task_count >= 0),
  task_latest BIGINT NOT NULL DEFAULT 0 CHECK (task_latest >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- statement-breakpoint

WITH project_ids AS (
  SELECT project_id FROM context_project_memory_decisions
  UNION
  SELECT project_id FROM context_project_memory_task_history
),
revision_state AS (
  SELECT
    p.project_id,
    (SELECT COUNT(*) FROM context_project_memory_decisions d WHERE d.project_id = p.project_id) AS decision_count,
    (SELECT COALESCE(MAX(created_at), 0) FROM context_project_memory_decisions d WHERE d.project_id = p.project_id) AS decision_latest,
    (SELECT COUNT(*) FROM context_project_memory_task_history t WHERE t.project_id = p.project_id) AS task_count,
    (SELECT COALESCE(MAX(created_at), 0) FROM context_project_memory_task_history t WHERE t.project_id = p.project_id) AS task_latest
  FROM project_ids p
)
INSERT INTO context_project_memory_revision(
  project_id, decision_count, decision_latest, task_count, task_latest, updated_at
)
SELECT project_id, decision_count, decision_latest, task_count, task_latest, now()
FROM revision_state
ON CONFLICT(project_id) DO UPDATE SET
  decision_count = EXCLUDED.decision_count,
  decision_latest = EXCLUDED.decision_latest,
  task_count = EXCLUDED.task_count,
  task_latest = EXCLUDED.task_latest,
  updated_at = now();
