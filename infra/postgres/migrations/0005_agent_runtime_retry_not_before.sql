-- Agent Runtime V2 durable retry backoff for pre-dispatch preparation failures.
-- Prevent notification-driven reconciles from consuming every attempt while a
-- retryable Context Engine dependency remains unavailable.

ALTER TABLE agent_tasks
    ADD COLUMN IF NOT EXISTS retry_not_before TEXT;

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_tasks_retry_not_before
    ON agent_tasks(run_id, status, retry_not_before)
    WHERE status = 'retrying';
