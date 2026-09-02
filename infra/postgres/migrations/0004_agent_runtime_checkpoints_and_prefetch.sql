-- Agent Runtime V2 durable safe-boundary checkpoints and execution results.

CREATE TABLE IF NOT EXISTS agent_task_checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
    checkpoint_type TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    dispatch_generation BIGINT NOT NULL DEFAULT 0,
    fencing_token BIGINT NOT NULL DEFAULT 0,
    fingerprint TEXT,
    reusable BOOLEAN NOT NULL DEFAULT FALSE,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    invalidated_at TEXT,
    UNIQUE(task_id, checkpoint_type, attempt, dispatch_generation, fencing_token)
);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_task_checkpoints_lookup
    ON agent_task_checkpoints(task_id, checkpoint_type, created_at DESC)
    WHERE invalidated_at IS NULL;

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_execution_results (
    result_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    dispatch_generation BIGINT NOT NULL,
    fencing_token BIGINT NOT NULL,
    result_path TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    consumed_at TEXT,
    UNIQUE(task_id, attempt, dispatch_generation, fencing_token)
);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_execution_results_pending
    ON agent_execution_results(run_id, created_at)
    WHERE consumed_at IS NULL;


-- statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_runtime_workers (
    worker_id TEXT PRIMARY KEY,
    worker_kind TEXT NOT NULL,
    hostname TEXT NOT NULL,
    pid INTEGER NOT NULL,
    concurrency INTEGER NOT NULL DEFAULT 1,
    started_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    stopped_at TEXT
);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_runtime_workers_heartbeat
    ON agent_runtime_workers(worker_kind, heartbeat_at DESC)
    WHERE stopped_at IS NULL;

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_workspace_cleanup_jobs (
    cleanup_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    dispatch_generation BIGINT NOT NULL,
    fencing_token BIGINT NOT NULL,
    workspace_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(task_id, dispatch_generation, fencing_token)
);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_workspace_cleanup_jobs_pending
    ON agent_workspace_cleanup_jobs(status, next_attempt_at, created_at)
    WHERE status IN ('queued', 'deferred');
