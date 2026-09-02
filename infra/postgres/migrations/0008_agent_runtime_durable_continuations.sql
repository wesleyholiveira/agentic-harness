-- Runtime V2 durable OpenCode session continuation.
-- RabbitMQ is at-least-once; PostgreSQL owns event/effect identity and delivery state.

CREATE TABLE IF NOT EXISTS agent_continuations (
    continuation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(run_id) ON DELETE CASCADE,
    schema_version TEXT NOT NULL DEFAULT 'agent-continuation/v1',
    opencode_session_id TEXT NOT NULL,
    opencode_server_url TEXT NOT NULL,
    opencode_directory TEXT,
    wake_events_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'parked',
    generation BIGINT NOT NULL DEFAULT 0,
    current_delivery_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cancelled_at TEXT,
    CHECK (status IN ('parked','wake_pending','delivered','manual_review','cancelled'))
);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_continuations_session
    ON agent_continuations(opencode_session_id, status);

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_continuation_deliveries (
    delivery_id TEXT PRIMARY KEY,
    continuation_id TEXT NOT NULL REFERENCES agent_continuations(continuation_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
    schema_version TEXT NOT NULL DEFAULT 'agent-continuation-delivery/v1',
    generation BIGINT NOT NULL,
    event_type TEXT NOT NULL,
    terminal_occurrence_key TEXT NOT NULL,
    effect_key TEXT NOT NULL UNIQUE,
    opencode_message_id TEXT NOT NULL UNIQUE,
    prompt_text TEXT NOT NULL,
    prompt_sha256 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at TEXT,
    next_attempt_at TEXT,
    dispatch_started_at TEXT,
    accepted_at TEXT,
    observed_at TEXT,
    completed_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(continuation_id, event_type, terminal_occurrence_key),
    CHECK (status IN ('pending','claimed','dispatching','accepted','observed','deferred','ambiguous','dead'))
);

-- statement-breakpoint

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_agent_continuations_current_delivery'
           AND conrelid = 'agent_continuations'::regclass
    ) THEN
        ALTER TABLE agent_continuations
            ADD CONSTRAINT fk_agent_continuations_current_delivery
            FOREIGN KEY (current_delivery_id)
            REFERENCES agent_continuation_deliveries(delivery_id)
            ON DELETE SET NULL
            NOT VALID;
    END IF;
END $$;

-- statement-breakpoint

ALTER TABLE agent_continuations
    VALIDATE CONSTRAINT fk_agent_continuations_current_delivery;

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_continuation_deliveries_pending
    ON agent_continuation_deliveries(status, next_attempt_at, created_at)
    WHERE status IN ('pending','deferred','claimed','dispatching','accepted');

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_continuation_deliveries_session_order
    ON agent_continuation_deliveries(continuation_id, generation);

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_runtime_inbox (
    message_id TEXT PRIMARY KEY,
    message_kind TEXT NOT NULL,
    consumer_name TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'received',
    delivery_count INTEGER NOT NULL DEFAULT 1,
    lease_owner TEXT,
    lease_expires_at TEXT,
    first_received_at TEXT NOT NULL,
    last_received_at TEXT NOT NULL,
    processed_at TEXT,
    last_error TEXT,
    CHECK (status IN ('received','claimed','processed','deferred','dead'))
);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_runtime_inbox_recoverable
    ON agent_runtime_inbox(status, lease_expires_at, last_received_at)
    WHERE status IN ('received','claimed','deferred');
