-- Runtime V2 session-adapter identity.
-- OpenCode remains the first transport implementation, but continuation authority
-- must persist the adapter id so the semantic/control plane is not coupled to it.

ALTER TABLE agent_continuations
    ADD COLUMN IF NOT EXISTS session_adapter_id TEXT NOT NULL DEFAULT 'opencode';

-- statement-breakpoint

DROP INDEX IF EXISTS idx_agent_continuations_session;

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_agent_continuations_session_adapter
    ON agent_continuations(session_adapter_id, opencode_server_url, opencode_session_id, status);
