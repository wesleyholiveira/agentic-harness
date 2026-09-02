-- R17.4.4: bind terminal continuation wakes to the parked OpenCode prompt identity.
-- Existing rows remain nullable for backward compatibility; fresh v2 continuations
-- are required by Runtime source to persist agent/provider/model before dispatch.

ALTER TABLE agent_continuations
    ADD COLUMN IF NOT EXISTS session_agent_id TEXT,
    ADD COLUMN IF NOT EXISTS session_provider_id TEXT,
    ADD COLUMN IF NOT EXISTS session_model_id TEXT,
    ADD COLUMN IF NOT EXISTS session_model_variant TEXT,
    ADD COLUMN IF NOT EXISTS session_prompt_message_id TEXT;

-- statement-breakpoint

ALTER TABLE agent_continuations
    ALTER COLUMN schema_version SET DEFAULT 'agent-continuation/v2';

-- statement-breakpoint

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'agent_continuations_prompt_identity_complete'
           AND conrelid = 'agent_continuations'::regclass
    ) THEN
        ALTER TABLE agent_continuations
            ADD CONSTRAINT agent_continuations_prompt_identity_complete
            CHECK (
                (session_agent_id IS NULL AND session_provider_id IS NULL AND session_model_id IS NULL)
                OR
                (session_agent_id IS NOT NULL AND session_provider_id IS NOT NULL AND session_model_id IS NOT NULL)
            ) NOT VALID;
    END IF;
END $$;

-- statement-breakpoint

ALTER TABLE agent_continuations
    VALIDATE CONSTRAINT agent_continuations_prompt_identity_complete;
