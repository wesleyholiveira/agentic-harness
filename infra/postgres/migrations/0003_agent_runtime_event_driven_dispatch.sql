-- Agent Runtime V2 event-driven dispatch authority.
-- PostgreSQL remains authoritative; RabbitMQ carries ID-only wakeups/commands.

ALTER TABLE agent_runs
    ADD COLUMN IF NOT EXISTS reconcile_generation BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reconcile_requested_at TEXT,
    ADD COLUMN IF NOT EXISTS reconcile_lease_owner TEXT,
    ADD COLUMN IF NOT EXISTS reconcile_lease_expires_at TEXT,
    ADD COLUMN IF NOT EXISTS runtime_driver TEXT NOT NULL DEFAULT 'event-driven-v1',
    ADD COLUMN IF NOT EXISTS context_budget_bytes INTEGER NOT NULL DEFAULT 120000,
    ADD COLUMN IF NOT EXISTS task_timeout_ms INTEGER NOT NULL DEFAULT 3600000,
    ADD COLUMN IF NOT EXISTS auto_integrate BOOLEAN NOT NULL DEFAULT TRUE;

-- statement-breakpoint

ALTER TABLE agent_tasks
    ADD COLUMN IF NOT EXISTS dispatch_generation BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS queued_at TEXT,
    ADD COLUMN IF NOT EXISTS execution_descriptor_path TEXT,
    ADD COLUMN IF NOT EXISTS execution_result_path TEXT,
    ADD COLUMN IF NOT EXISTS lease_owner TEXT,
    ADD COLUMN IF NOT EXISTS lease_expires_at TEXT,
    ADD COLUMN IF NOT EXISTS fencing_token BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cleanup_state TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS cleanup_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cleanup_error TEXT;

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_runtime_outbox (
    outbox_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
    task_id TEXT REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
    message_kind TEXT NOT NULL,
    dispatch_generation BIGINT NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    published_at TEXT,
    publish_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    terminal_at TEXT,
    terminal_reason TEXT,
    UNIQUE(message_kind, run_id, task_id, dispatch_generation)
);

-- statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runtime_outbox_identity
    ON agent_runtime_outbox(message_kind, run_id, COALESCE(task_id, ''), dispatch_generation);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_runtime_outbox_pending
    ON agent_runtime_outbox(created_at, outbox_id)
    WHERE published_at IS NULL AND terminal_at IS NULL;

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_tasks_dispatch_ready
    ON agent_tasks(run_id, status, dispatch_generation);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_tasks_execution_lease
    ON agent_tasks(lease_expires_at)
    WHERE lease_owner IS NOT NULL;
