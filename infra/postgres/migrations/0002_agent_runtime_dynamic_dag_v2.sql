-- Agent runtime V2 dynamic DAG and execution telemetry.
-- Forward-only: allow multiple bounded work items owned by the same agent in one
-- run, and persist authoritative OpenCode execution/cost telemetry per task.

-- The original V1 schema assumed one task per agent per run. The Technical Lead
-- compiled DAG can intentionally materialize multiple independent work items for
-- the same specialist, so that uniqueness contract is no longer valid.
ALTER TABLE agent_tasks
    DROP CONSTRAINT IF EXISTS agent_tasks_run_id_agent_id_key;

-- statement-breakpoint

ALTER TABLE agent_tasks
    ADD COLUMN IF NOT EXISTS model_id TEXT,
    ADD COLUMN IF NOT EXISTS model_variant TEXT,
    ADD COLUMN IF NOT EXISTS reasoning_effort TEXT,
    ADD COLUMN IF NOT EXISTS steps_limit INTEGER,
    ADD COLUMN IF NOT EXISTS steps_used INTEGER,
    ADD COLUMN IF NOT EXISTS step_limit_reached BOOLEAN,
    ADD COLUMN IF NOT EXISTS stop_reason TEXT,
    ADD COLUMN IF NOT EXISTS opencode_session_id TEXT,
    ADD COLUMN IF NOT EXISTS cached_input_tokens INTEGER,
    ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION;

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_tasks_run_agent
    ON agent_tasks(run_id, agent_id);
