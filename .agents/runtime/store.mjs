import pg from "pg";
import { persistedEventLogLevel, runtimeLog } from "./runtime-log.mjs";
import { assertTerminalRunPatch, isTerminalRunStatus } from "./run-invariants.mjs";
import { newId, nowIso, sha256 } from "./utils.mjs";
import {
  AGENT_CONTINUATION_DELIVERY_SCHEMA_VERSION,
  AGENT_CONTINUATION_SCHEMA_VERSION,
  buildContinuationEffectKey,
  buildContinuationPrompt,
  continuationPromptFingerprint,
  normalizeContinuationWakeEvents,
  runStatusToContinuationEvent,
} from "./continuation.mjs";
import { createDefaultSessionAdapterRegistry } from "./session-adapter.mjs";

const { Pool } = pg;
const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;
const AGENT_RUNTIME_WAKE_CHANNEL = "agent_harness_runtime_wakeup";
const REQUIRED_POSTGRES_TABLES = Object.freeze([
  "agent_artifacts",
  "agent_conflicts",
  "agent_events",
  "agent_integrated_paths",
  "agent_runs",
  "agent_tasks",
  "agent_runtime_outbox",
  "agent_task_checkpoints",
  "agent_execution_results",
  "agent_runtime_workers",
  "agent_workspace_cleanup_jobs",
  "agent_continuations",
  "agent_continuation_deliveries",
  "agent_runtime_inbox",
  "agent_input_artifact_receipts",
]);
const REQUIRED_AGENT_RUN_COLUMNS = Object.freeze([
  "reconcile_generation", "reconcile_requested_at", "reconcile_lease_owner", "reconcile_lease_expires_at",
  "runtime_driver", "context_budget_bytes", "task_timeout_ms", "auto_integrate",
]);
const REQUIRED_AGENT_CONTINUATION_COLUMNS = Object.freeze([
  "session_adapter_id",
  "session_agent_id",
  "session_provider_id",
  "session_model_id",
  "session_model_variant",
  "session_prompt_message_id",
]);
const REQUIRED_AGENT_TASK_COLUMNS = Object.freeze([
  "model_id", "model_variant", "reasoning_effort", "steps_limit", "steps_used",
  "step_limit_reached", "stop_reason", "opencode_session_id", "cached_input_tokens", "cost_usd",
  "dispatch_generation", "execution_descriptor_path", "execution_result_path", "lease_owner",
  "lease_expires_at", "fencing_token", "cleanup_state", "cleanup_attempts", "cleanup_error", "retry_not_before",
  "input_manifest_path", "input_manifest_fingerprint",
]);

const RUN_PATCH_COLUMNS = new Set([
  "status", "executor", "workspace_mode", "max_parallel", "peak_parallel", "started_at", "completed_at",
  "error_code", "error_message", "reasoning_mode", "reasoning_source", "initial_reasoning_level",
  "reasoning_confidence", "graph_version", "reconcile_generation", "reconcile_requested_at",
  "reconcile_lease_owner", "reconcile_lease_expires_at", "runtime_driver", "context_budget_bytes",
  "task_timeout_ms", "auto_integrate",
]);
const TASK_PATCH_COLUMNS = new Set([
  "status", "attempt", "brief_path", "context_path", "handoff_path", "workspace_path", "context_bytes",
  "context_documents", "estimated_tokens", "used_context_documents", "input_tokens", "output_tokens",
  "cached_input_tokens", "cost_usd", "model_id", "model_variant", "reasoning_effort", "steps_limit",
  "steps_used", "step_limit_reached", "stop_reason", "opencode_session_id",
  "started_at", "completed_at", "duration_ms", "error_code", "error_message", "reasoning_level",
  "reasoning_source", "reasoning_reasons_json", "dispatch_generation", "queued_at",
  "execution_descriptor_path", "execution_result_path", "lease_owner", "lease_expires_at", "fencing_token",
  "cleanup_state", "cleanup_attempts", "cleanup_error", "retry_not_before", "dependencies_json",
  "input_manifest_path", "input_manifest_fingerprint",
]);

function numberFields(row) {
  if (!row) return row;
  const numeric = new Set([
    "max_parallel", "peak_parallel", "state_version", "attempt", "max_attempts", "context_bytes",
    "context_documents", "estimated_tokens", "used_context_documents", "input_tokens", "output_tokens",
    "cached_input_tokens", "cost_usd", "steps_limit", "steps_used",
    "duration_ms", "accepted", "count", "sum_ms", "bytes", "documents", "tokens", "retries", "value",
    "dispatch_generation", "fencing_token", "reconcile_generation", "publish_count", "cleanup_attempts",
    "generation", "attempts", "delivery_count",
  ]);
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    numeric.has(key) && value !== null && value !== undefined ? Number(value) : value,
  ]));
}

function rows(result) {
  return result.rows.map(numberFields);
}


function continuationPromptIdentity(registration) {
  const identity = registration?.promptIdentity;
  const agentId = String(identity?.agentId ?? "").trim();
  const providerId = String(identity?.providerId ?? "").trim();
  const modelId = String(identity?.modelId ?? "").trim();
  const variant = String(identity?.variant ?? "").trim() || null;
  const sourceMessageId = String(identity?.sourceMessageId ?? "").trim() || null;
  if (!agentId || !providerId || !modelId) {
    throw new Error("agent_continuation_prompt_identity_required");
  }
  return { agentId, providerId, modelId, variant, sourceMessageId };
}

function assertIdentifier(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid_${label}:${value}`);
  return value;
}

function schemaNotReady(schema, missing) {
  const error = new Error("schema_not_ready");
  error.code = "schema_not_ready";
  error.schema = schema;
  error.missing = missing;
  return error;
}

class PostgresOrchestrationStore {
  constructor(connectionString, options = {}) {
    this.connectionString = connectionString;
    this.readOnly = options.readOnly === true;
    this.schema = assertIdentifier(options.schema ?? process.env.AGENT_POSTGRES_SCHEMA ?? "public", "postgres_schema");
    this.pool = options.pool ?? null;
    this.ownsPool = !options.pool;
    this.sessionAdapters = options.sessionAdapters ?? createDefaultSessionAdapterRegistry({
      environment: options.environment ?? process.env,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
    });
  }

  async open() {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.connectionString,
        max: Number(process.env.AGENT_POSTGRES_POOL_MAX ?? 5),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: Number(process.env.AGENT_POSTGRES_POOL_TIMEOUT_MS ?? 10_000),
        options: `-c search_path=${this.schema},public`,
      });
    }
    try {
      await this.pool.query("SELECT 1");
      await this.assertSchemaReady();
      return this;
    } catch (error) {
      if (this.ownsPool) {
        await this.pool.end().catch(() => {});
        this.pool = null;
      }
      throw error;
    }
  }

  async assertSchemaReady() {
    const result = await this.pool.query(
      `SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'
          AND table_name = ANY($2::text[])`,
      [this.schema, REQUIRED_POSTGRES_TABLES],
    );
    const available = new Set(result.rows.map((row) => row.table_name));
    const missing = REQUIRED_POSTGRES_TABLES.filter((table) => !available.has(table));
    if (missing.length > 0) throw schemaNotReady(this.schema, missing);

    const runColumnResult = await this.pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_runs'`,
      [this.schema],
    );
    const runColumns = new Set(runColumnResult.rows.map((row) => row.column_name));
    const missingRunColumns = REQUIRED_AGENT_RUN_COLUMNS.filter((column) => !runColumns.has(column));
    if (missingRunColumns.length > 0) throw schemaNotReady(this.schema, missingRunColumns.map((column) => `agent_runs.${column}`));

    const columnResult = await this.pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_tasks'`,
      [this.schema],
    );
    const columns = new Set(columnResult.rows.map((row) => row.column_name));
    const missingColumns = REQUIRED_AGENT_TASK_COLUMNS.filter((column) => !columns.has(column));
    if (missingColumns.length > 0) {
      throw schemaNotReady(this.schema, missingColumns.map((column) => `agent_tasks.${column}`));
    }
    const continuationColumnResult = await this.pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_continuations'`,
      [this.schema],
    );
    const continuationColumns = new Set(continuationColumnResult.rows.map((row) => row.column_name));
    const missingContinuationColumns = REQUIRED_AGENT_CONTINUATION_COLUMNS.filter((column) => !continuationColumns.has(column));
    if (missingContinuationColumns.length > 0) {
      throw schemaNotReady(this.schema, missingContinuationColumns.map((column) => `agent_continuations.${column}`));
    }

    const legacyUnique = await this.pool.query(
      `SELECT 1 FROM information_schema.table_constraints
       WHERE table_schema=$1 AND table_name='agent_tasks'
         AND constraint_type='UNIQUE' AND constraint_name='agent_tasks_run_id_agent_id_key'
       LIMIT 1`,
      [this.schema],
    );
    if (legacyUnique.rowCount > 0) throw schemaNotReady(this.schema, ["agent_tasks.legacy_run_agent_unique_constraint"]);
  }

  async close() {
    if (this.pool && this.ownsPool) await this.pool.end();
    this.pool = null;
  }

  requirePool() {
    if (!this.pool) throw new Error("orchestration_store_not_open");
    return this.pool;
  }

  async registerContinuation(runId, registration, client = null) {
    if (!registration) return null;
    const executor = client ?? this.requirePool();
    const continuationId = `agent-continuation-${sha256(Buffer.from(`${runId}|${registration.adapterId ?? "opencode"}|${registration.sessionId}`)).slice(0, 32)}`;
    const createdAt = nowIso();
    const wakeEvents = normalizeContinuationWakeEvents(registration.wakeOn);
    const promptIdentity = continuationPromptIdentity(registration);
    const result = await executor.query(
      `INSERT INTO agent_continuations(
         continuation_id,run_id,schema_version,session_adapter_id,opencode_session_id,opencode_server_url,
         opencode_directory,wake_events_json,session_agent_id,session_provider_id,session_model_id,
         session_model_variant,session_prompt_message_id,status,generation,created_at,updated_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'parked',0,$14,$14)
       ON CONFLICT(run_id) DO UPDATE SET
         session_adapter_id=EXCLUDED.session_adapter_id,
         opencode_session_id=EXCLUDED.opencode_session_id,
         opencode_server_url=EXCLUDED.opencode_server_url,
         opencode_directory=EXCLUDED.opencode_directory,
         wake_events_json=EXCLUDED.wake_events_json,
         session_agent_id=EXCLUDED.session_agent_id,
         session_provider_id=EXCLUDED.session_provider_id,
         session_model_id=EXCLUDED.session_model_id,
         session_model_variant=EXCLUDED.session_model_variant,
         session_prompt_message_id=EXCLUDED.session_prompt_message_id,
         updated_at=EXCLUDED.updated_at
       WHERE agent_continuations.generation=0
         AND agent_continuations.status='parked'
         AND agent_continuations.session_adapter_id=EXCLUDED.session_adapter_id
         AND agent_continuations.opencode_session_id=EXCLUDED.opencode_session_id
         AND agent_continuations.opencode_server_url=EXCLUDED.opencode_server_url
         AND COALESCE(agent_continuations.opencode_directory,'')=COALESCE(EXCLUDED.opencode_directory,'')
         AND agent_continuations.wake_events_json=EXCLUDED.wake_events_json
         AND agent_continuations.session_agent_id=EXCLUDED.session_agent_id
         AND agent_continuations.session_provider_id=EXCLUDED.session_provider_id
         AND agent_continuations.session_model_id=EXCLUDED.session_model_id
         AND COALESCE(agent_continuations.session_model_variant,'')=COALESCE(EXCLUDED.session_model_variant,'')
         AND COALESCE(agent_continuations.session_prompt_message_id,'')=COALESCE(EXCLUDED.session_prompt_message_id,'')
       RETURNING *`,
      [
        continuationId,
        runId,
        AGENT_CONTINUATION_SCHEMA_VERSION,
        registration.adapterId ?? "opencode",
        registration.sessionId,
        registration.serverUrl,
        registration.directory ?? null,
        JSON.stringify(wakeEvents),
        promptIdentity.agentId,
        promptIdentity.providerId,
        promptIdentity.modelId,
        promptIdentity.variant,
        promptIdentity.sourceMessageId,
        createdAt,
      ],
    );
    if (result.rowCount !== 1) throw new Error(`agent_continuation_rebind_not_allowed:${runId}`);
    if (!client) {
      await this.event(runId, null, "continuation.parked", {
        continuationId: result.rows[0].continuation_id,
        adapterId: registration.adapterId ?? "opencode",
        sessionId: registration.sessionId,
        opencodeSessionId: registration.sessionId,
        wakeOn: wakeEvents,
      });
      const run = await this.getRun(runId);
      if (runStatusToContinuationEvent(run?.status)) await this.materializeContinuationWake(runId, { status: run.status });
    }
    return numberFields(result.rows[0]);
  }

  async getContinuation(runId) {
    const result = await this.requirePool().query(
      "SELECT * FROM agent_continuations WHERE run_id=$1 LIMIT 1",
      [runId],
    );
    return numberFields(result.rows[0] ?? null);
  }

  async findActiveRunByContinuationTarget({ adapterId = "opencode", sessionId, serverUrl }) {
    if (!sessionId || !serverUrl) return null;
    const result = await this.requirePool().query(
      `SELECT r.*,c.continuation_id,c.status AS continuation_status,c.session_adapter_id,c.opencode_session_id,c.opencode_server_url
         FROM agent_runs r
         JOIN agent_continuations c ON c.run_id=r.run_id
        WHERE c.session_adapter_id=$1
          AND c.opencode_session_id=$2
          AND c.opencode_server_url=$3
          AND c.status <> 'cancelled'
          AND r.status IN ('routed','running')
        ORDER BY r.created_at DESC,r.run_id DESC
        LIMIT 1`,
      [adapterId, sessionId, serverUrl],
    );
    return numberFields(result.rows[0] ?? null);
  }

  async findActiveRunByContinuationSession(sessionId) {
    if (!sessionId) return null;
    const result = await this.requirePool().query(
      `SELECT r.*,c.continuation_id,c.status AS continuation_status,c.session_adapter_id,c.opencode_session_id,c.opencode_server_url
         FROM agent_runs r
         JOIN agent_continuations c ON c.run_id=r.run_id
        WHERE c.opencode_session_id=$1
          AND c.status <> 'cancelled'
          AND r.status IN ('routed','running')
        ORDER BY r.created_at DESC,r.run_id DESC
        LIMIT 2`,
      [sessionId],
    );
    if (result.rows.length > 1) throw new Error(`agent_continuation_session_active_run_ambiguous:${sessionId}`);
    return numberFields(result.rows[0] ?? null);
  }

  async withContinuationSessionLock({ adapterId = "opencode", sessionId, serverUrl }, callback) {
    if (!sessionId || !serverUrl) return await callback();
    const client = await this.requirePool().connect();
    const lockKey = `agent-runtime-continuation-session:${adapterId}|${serverUrl}|${sessionId}`;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lockKey]);
      return await callback();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]).catch(() => {});
      client.release();
    }
  }

  async cancelContinuation(runId, { reason = "operator_cancelled" } = {}) {
    const client = await this.requirePool().connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query("SELECT * FROM agent_continuations WHERE run_id=$1 FOR UPDATE", [runId]);
      if (selected.rowCount !== 1) {
        await client.query("COMMIT");
        return { runId, cancelled: false, reason: "continuation_not_bound" };
      }
      const row = selected.rows[0];
      if (row.status === "cancelled") {
        await client.query("COMMIT");
        return { runId, continuationId: row.continuation_id, cancelled: false, reason: "already_cancelled" };
      }
      const at = nowIso();
      await client.query(
        `UPDATE agent_continuations
            SET status='cancelled',cancelled_at=COALESCE(cancelled_at,$2),updated_at=$2
          WHERE continuation_id=$1`,
        [row.continuation_id, at],
      );
      const deliveries = await client.query(
        `UPDATE agent_continuation_deliveries
            SET status='dead',completed_at=COALESCE(completed_at,$2),updated_at=$2,last_error=COALESCE(last_error,$3)
          WHERE continuation_id=$1
            AND status IN ('pending','claimed','deferred')
            AND accepted_at IS NULL AND observed_at IS NULL`,
        [row.continuation_id, at, `continuation_cancelled:${reason}`],
      );
      await client.query(
        `INSERT INTO agent_events(event_id,run_id,task_id,event_type,payload_json,created_at)
         VALUES($1,$2,NULL,'continuation.cancelled',$3,$4)`,
        [newId("event"), runId, JSON.stringify({ continuationId: row.continuation_id, reason, deadDeliveries: deliveries.rowCount }), at],
      );
      await client.query("COMMIT");
      return { runId, continuationId: row.continuation_id, cancelled: true, deadDeliveries: deliveries.rowCount };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAgentInputArtifactReceipt({ runId, taskId, attempt, manifestFingerprint, artifactRef, contentSha256, bytes, estimatedTokens }) {
    const receiptId = `agent-input-artifact-${sha256(Buffer.from(`${runId}|${taskId}|${attempt}|${manifestFingerprint}|${artifactRef}`)).slice(0, 32)}`;
    const createdAt = nowIso();
    const result = await this.requirePool().query(
      `INSERT INTO agent_input_artifact_receipts(
         receipt_id,run_id,task_id,attempt,manifest_fingerprint,artifact_ref,content_sha256,bytes,estimated_tokens,created_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(run_id,task_id,attempt,manifest_fingerprint,artifact_ref) DO UPDATE SET
         content_sha256=EXCLUDED.content_sha256,bytes=EXCLUDED.bytes,estimated_tokens=EXCLUDED.estimated_tokens
       RETURNING *`,
      [receiptId, runId, taskId, Number(attempt), manifestFingerprint, artifactRef, contentSha256, Number(bytes), Number(estimatedTokens), createdAt],
    );
    return numberFields(result.rows[0] ?? null);
  }

  async listAgentInputArtifactReceipts(runId, taskId = null) {
    if (taskId) return rows(await this.requirePool().query(
      "SELECT * FROM agent_input_artifact_receipts WHERE run_id=$1 AND task_id=$2 ORDER BY created_at,artifact_ref",
      [runId, taskId],
    ));
    return rows(await this.requirePool().query(
      "SELECT * FROM agent_input_artifact_receipts WHERE run_id=$1 ORDER BY task_id,created_at,artifact_ref",
      [runId],
    ));
  }

  async listContinuationDeliveries(runId) {
    return rows(await this.requirePool().query(
      "SELECT * FROM agent_continuation_deliveries WHERE run_id=$1 ORDER BY generation,created_at",
      [runId],
    ));
  }

  async continuationState(runId) {
    const continuation = await this.getContinuation(runId);
    if (!continuation) return null;
    const deliveries = await this.listContinuationDeliveries(runId);
    return {
      continuationId: continuation.continuation_id,
      runId: continuation.run_id,
      schemaVersion: continuation.schema_version,
      adapterId: continuation.session_adapter_id ?? "opencode",
      sessionId: continuation.opencode_session_id,
      serverUrl: continuation.opencode_server_url,
      opencodeSessionId: continuation.opencode_session_id,
      directory: continuation.opencode_directory,
      promptIdentity: {
        agentId: continuation.session_agent_id,
        providerId: continuation.session_provider_id,
        modelId: continuation.session_model_id,
        variant: continuation.session_model_variant ?? null,
        sourceMessageId: continuation.session_prompt_message_id ?? null,
      },
      wakeOn: JSON.parse(continuation.wake_events_json ?? "[]"),
      status: continuation.status,
      generation: Number(continuation.generation ?? 0),
      currentDeliveryId: continuation.current_delivery_id,
      createdAt: continuation.created_at,
      updatedAt: continuation.updated_at,
      deliveries: deliveries.map((delivery) => ({
        deliveryId: delivery.delivery_id,
        generation: Number(delivery.generation),
        event: delivery.event_type,
        effectKey: delivery.effect_key,
        sessionMessageId: delivery.opencode_message_id,
        opencodeMessageId: delivery.opencode_message_id,
        status: delivery.status,
        attempts: Number(delivery.attempts ?? 0),
        acceptedAt: delivery.accepted_at,
        observedAt: delivery.observed_at,
        lastError: delivery.last_error,
      })),
    };
  }

  async materializeContinuationWake(runId, { status = null } = {}) {
    const client = await this.requirePool().connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT r.status AS run_status,r.completed_at,r.state_version,c.status AS continuation_status,c.*
           FROM agent_runs r
           JOIN agent_continuations c ON c.run_id=r.run_id
          WHERE r.run_id=$1
          FOR UPDATE OF r,c`,
        [runId],
      );
      if (selected.rowCount !== 1) {
        await client.query("ROLLBACK");
        return null;
      }
      const row = selected.rows[0];
      if (row.continuation_status === "cancelled") {
        await client.query("ROLLBACK");
        return null;
      }
      const runStatus = row.run_status;
      if (status !== null && status !== undefined && status !== runStatus) {
        await client.query("ROLLBACK");
        return null;
      }
      const eventType = runStatusToContinuationEvent(runStatus);
      if (!eventType) {
        await client.query("ROLLBACK");
        return null;
      }
      const wakeEvents = normalizeContinuationWakeEvents(JSON.parse(row.wake_events_json ?? "[]"));
      if (!wakeEvents.includes(eventType)) {
        await client.query("ROLLBACK");
        return null;
      }
      if (!row.completed_at) throw new Error(`agent_continuation_terminal_completed_at_missing:${runId}`);
      const terminalOccurrenceKey = `completed-at:${row.completed_at}`;
      const effectKey = buildContinuationEffectKey({
        continuationId: row.continuation_id,
        runId,
        terminalOccurrenceKey,
        eventType,
      });
      const existing = await client.query(
        "SELECT * FROM agent_continuation_deliveries WHERE effect_key=$1 LIMIT 1",
        [effectKey],
      );
      if (existing.rowCount === 1) {
        await client.query("COMMIT");
        return { delivery: numberFields(existing.rows[0]), created: false };
      }
      const generation = Number(row.generation ?? 0) + 1;
      const createdAt = nowIso();
      const deliveryId = `continuation-delivery-${sha256(Buffer.from(effectKey)).slice(0, 32)}`;
      const sessionMessageId = this.sessionAdapters.buildMessageId(row.session_adapter_id ?? "opencode", {
        effectKey,
        createdAt,
      });
      const prompt = buildContinuationPrompt({ runId, eventType, effectKey, generation });
      const promptSha256 = continuationPromptFingerprint(prompt);
      const inserted = await client.query(
        `INSERT INTO agent_continuation_deliveries(
           delivery_id,continuation_id,run_id,schema_version,generation,event_type,
           terminal_occurrence_key,effect_key,opencode_message_id,prompt_text,prompt_sha256,
           status,created_at,updated_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$12)
         ON CONFLICT(effect_key) DO NOTHING
         RETURNING *`,
        [
          deliveryId,
          row.continuation_id,
          runId,
          AGENT_CONTINUATION_DELIVERY_SCHEMA_VERSION,
          generation,
          eventType,
          terminalOccurrenceKey,
          effectKey,
          sessionMessageId,
          prompt,
          promptSha256,
          createdAt,
        ],
      );
      if (inserted.rowCount !== 1) {
        const raced = await client.query("SELECT * FROM agent_continuation_deliveries WHERE effect_key=$1", [effectKey]);
        await client.query("COMMIT");
        return { delivery: numberFields(raced.rows[0]), created: false };
      }
      await client.query(
        `UPDATE agent_continuations
            SET status='wake_pending',generation=$2,current_delivery_id=$3,updated_at=$4
          WHERE continuation_id=$1`,
        [row.continuation_id, generation, deliveryId, createdAt],
      );
      await this.enqueueRuntimeOutbox({
        runId,
        kind: "agent.continuation.wake.v1",
        dispatchGeneration: generation,
        payload: {
          continuationId: row.continuation_id,
          deliveryId,
          effectKey,
        },
      }, client);
      await client.query(
        `INSERT INTO agent_events(event_id,run_id,task_id,event_type,payload_json,created_at)
         VALUES($1,$2,NULL,'continuation.wake_materialized',$3,$4)`,
        [newId("event"), runId, JSON.stringify({ continuationId: row.continuation_id, deliveryId, effectKey, eventType, generation }), createdAt],
      );
      await client.query("COMMIT");
      runtimeLog("info", "continuation.wake_materialized", {
        runId,
        taskId: null,
        continuationId: row.continuation_id,
        deliveryId,
        effectKey,
        eventType,
        generation,
      });
      return { delivery: numberFields(inserted.rows[0]), created: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async repairTerminalContinuationWakes(limit = 200) {
    const result = await this.requirePool().query(
      `SELECT r.run_id,r.status
         FROM agent_runs r
         JOIN agent_continuations c ON c.run_id=r.run_id
        WHERE r.status IN ('closed','failed','blocked','cancelled')
          AND c.status <> 'cancelled'
        ORDER BY r.completed_at NULLS LAST,r.run_id
        LIMIT $1`,
      [Math.max(1, Math.min(1000, Number(limit) || 200))],
    );
    const repaired = [];
    for (const row of result.rows) {
      const outcome = await this.materializeContinuationWake(row.run_id, { status: row.status });
      if (outcome?.created) repaired.push(outcome.delivery.delivery_id);
    }
    return repaired;
  }

  async createRun(plan, options = {}) {
    const client = await this.requirePool().connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO agent_runs(
        run_id, request, status, plan_json, executor, workspace_mode, max_parallel, created_at, graph_version,
        runtime_driver, context_budget_bytes, task_timeout_ms, auto_integrate
      ) VALUES($1, $2, 'routed', $3, $4, $5, $6, $7, $8, 'event-driven-v1', $9, $10, $11)`, [
        plan.runId,
        plan.request,
        JSON.stringify(plan),
        options.executor ?? options.executorCommand ?? null,
        options.workspaceMode ?? null,
        options.maxParallel ?? 1,
        plan.createdAt,
        options.graphVersion ?? null,
        options.contextBudgetBytes ?? 120_000,
        options.taskTimeoutMs ?? 3_600_000,
        options.integrate !== false,
      ]);
      for (const task of plan.tasks) {
        await client.query(`INSERT INTO agent_tasks(task_id, run_id, agent_id, role, status, max_attempts, dependencies_json, owned_paths_json, reasoning_level, reasoning_source)
          VALUES($1, $2, $3, $4, 'routed', $5, $6, $7, $8, $9)`, [
          task.taskId,
          plan.runId,
          task.agentId,
          task.role,
          options.maxAttempts ?? 3,
          JSON.stringify(task.dependencies),
          JSON.stringify(task.ownedPaths),
          task.reasoningLevel ?? null,
          plan.reasoning?.source ?? null,
        ]);
      }
      if (plan.reasoning) {
        await client.query(`UPDATE agent_runs SET reasoning_mode=$1, reasoning_source=$2, initial_reasoning_level=$3,
          reasoning_confidence=$4, state_version=state_version+1 WHERE run_id=$5`, [
          plan.reasoning.mode,
          plan.reasoning.source,
          plan.reasoning.initialLevel,
          plan.reasoning.confidence,
          plan.runId,
        ]);
      }
      if (options.continuation) {
        const continuation = await this.registerContinuation(plan.runId, options.continuation, client);
        await client.query(`INSERT INTO agent_events(event_id,run_id,task_id,event_type,payload_json,created_at)
          VALUES($1,$2,NULL,'continuation.parked',$3,$4)`, [
          newId("event"),
          plan.runId,
          JSON.stringify({
            continuationId: continuation.continuation_id,
            opencodeSessionId: continuation.opencode_session_id,
            wakeOn: JSON.parse(continuation.wake_events_json),
          }),
          nowIso(),
        ]);
      }
      if (options.invocationProvenance?.provenanceSource === "opencode-plugin-sidechannel") {
        await client.query(`INSERT INTO agent_events(event_id,run_id,task_id,event_type,payload_json,created_at)
          VALUES($1,$2,NULL,'orchestrator.agent_start_provenance_accepted',$3,$4)`, [
          newId("event"),
          plan.runId,
          JSON.stringify({
            origin: options.invocationProvenance?.origin ?? "unknown",
            sessionId: options.invocationProvenance?.sessionId ?? null,
            callId: options.invocationProvenance?.callId ?? null,
            userMessageId: options.invocationProvenance?.userMessageId ?? null,
            provenanceSource: options.invocationProvenance?.provenanceSource ?? "missing",
            historySource: options.invocationProvenance?.historySource ?? null,
            historyErrorCode: options.invocationProvenance?.historyErrorCode ?? null,
            authoritative: true,
            deduplicated: false,
          }),
          nowIso(),
        ]);
      }
      await client.query(`INSERT INTO agent_events(event_id, run_id, task_id, event_type, payload_json, created_at)
        VALUES($1, $2, NULL, 'run.routed', $3, $4)`, [
        newId("event"),
        plan.runId,
        JSON.stringify({
          taskCount: plan.tasks.length,
          maxParallel: options.maxParallel ?? 1,
          reasoning: plan.reasoning ?? null,
          bootstrapReviewTopology: plan.workflow?.bootstrapReviewTopology ?? null,
          bootstrapReviewDependencies: plan.workflow?.bootstrapReviewDependencies ?? [],
        }),
        nowIso(),
      ]);
      await client.query(
        `UPDATE agent_runs SET reconcile_generation=1, reconcile_requested_at=$2, runtime_driver='event-driven-v1' WHERE run_id=$1`,
        [plan.runId, nowIso()],
      );
      await this.enqueueRuntimeOutbox({
        runId: plan.runId,
        kind: "agent.run.reconcile.v1",
        dispatchGeneration: 1,
        payload: { reason: "run_created" },
      }, client);
      await client.query("SELECT pg_notify($1,$2)", [AGENT_RUNTIME_WAKE_CHANNEL, plan.runId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async replacePlan(runId, plan, options = {}) {
    const values = [JSON.stringify(plan), runId];
    let where = "run_id=$2";
    if (options.expectedVersion !== undefined) {
      values.push(options.expectedVersion);
      where += " AND state_version=$3";
    }
    const result = await this.requirePool().query(
      `UPDATE agent_runs SET plan_json=$1, state_version=state_version+1 WHERE ${where} RETURNING *`,
      values,
    );
    if (result.rowCount !== 1) {
      const current = await this.getRun(runId);
      const error = new Error(`agent_run_plan_version_conflict:${runId}:${options.expectedVersion ?? "unknown"}:${current?.state_version ?? "missing"}`);
      error.code = "agent_run_plan_version_conflict";
      throw error;
    }
    await this.event(runId, null, "dag.plan.replaced", { phase: plan.phase, taskCount: plan.tasks.length });
    return numberFields(result.rows[0]);
  }

  async addTasks(runId, tasks, options = {}) {
    if (!Array.isArray(tasks) || tasks.length === 0) return [];
    const client = await this.requirePool().connect();
    const inserted = [];
    try {
      await client.query("BEGIN");
      for (const task of tasks) {
        const result = await client.query(
          `INSERT INTO agent_tasks(task_id, run_id, agent_id, role, status, max_attempts, dependencies_json, owned_paths_json, reasoning_level, reasoning_source)
           VALUES($1, $2, $3, $4, 'routed', $5, $6, $7, $8, $9)
           ON CONFLICT(task_id) DO NOTHING RETURNING *`,
          [
            task.taskId, runId, task.agentId, task.role, options.maxAttempts ?? 3,
            JSON.stringify(task.dependencies ?? []), JSON.stringify(task.ownedPaths ?? []),
            task.reasoningLevel ?? null, options.reasoningSource ?? null,
          ],
        );
        if (result.rowCount === 1) inserted.push(numberFields(result.rows[0]));
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (inserted.length > 0) {
      await this.event(runId, null, "dag.tasks.materialized", { taskIds: inserted.map((task) => task.task_id) });
    }
    return inserted;
  }

  async applyBootstrapPlanRefinement(runId, plan, options = {}) {
    const client = await this.requirePool().connect();
    const addedTaskIds = [];
    const removedTaskIds = [];
    const eventId = newId("event");
    const at = nowIso();
    try {
      await client.query("BEGIN");
      const lockedRun = await client.query("SELECT * FROM agent_runs WHERE run_id=$1 FOR UPDATE", [runId]);
      const current = lockedRun.rows[0];
      if (!current) throw new Error(`run_not_found:${runId}`);
      if (options.expectedVersion !== undefined && Number(current.state_version) !== Number(options.expectedVersion)) {
        const error = new Error(`agent_run_plan_version_conflict:${runId}:${options.expectedVersion}:${current.state_version}`);
        error.code = "agent_run_plan_version_conflict";
        throw error;
      }
      if (isTerminalRunStatus(current.status)) throw new Error(`bootstrap_refinement_run_terminal:${runId}:${current.status}`);

      for (const taskId of options.removedTaskIds ?? []) {
        const lockedTask = await client.query("SELECT * FROM agent_tasks WHERE task_id=$1 AND run_id=$2 FOR UPDATE", [taskId, runId]);
        const task = lockedTask.rows[0];
        if (!task) throw new Error(`bootstrap_refinement_task_missing:${taskId}`);
        const artifactCount = await client.query("SELECT COUNT(*)::int AS count FROM agent_artifacts WHERE run_id=$1 AND task_id=$2", [runId, taskId]);
        const resultCount = await client.query("SELECT COUNT(*)::int AS count FROM agent_execution_results WHERE run_id=$1 AND task_id=$2", [runId, taskId]);
        if (!['routed', 'retrying'].includes(task.status) || Number(task.attempt ?? 0) !== 0 || task.workspace_path
          || Number(artifactCount.rows[0]?.count ?? 0) > 0 || Number(resultCount.rows[0]?.count ?? 0) > 0) {
          throw new Error(`bootstrap_refinement_task_removal_unsafe:${taskId}:${task.status}`);
        }
        const deleted = await client.query("DELETE FROM agent_tasks WHERE task_id=$1 AND run_id=$2 RETURNING task_id", [taskId, runId]);
        if (deleted.rowCount !== 1) throw new Error(`bootstrap_refinement_task_removal_failed:${taskId}`);
        removedTaskIds.push(taskId);
      }

      for (const update of options.dependencyUpdates ?? []) {
        const lockedTask = await client.query("SELECT * FROM agent_tasks WHERE task_id=$1 AND run_id=$2 FOR UPDATE", [update.taskId, runId]);
        const task = lockedTask.rows[0];
        if (!task) throw new Error(`bootstrap_refinement_task_missing:${update.taskId}`);
        if (!["routed", "retrying"].includes(task.status)) {
          throw new Error(`bootstrap_refinement_task_already_started:${update.taskId}:${task.status}`);
        }
        await client.query(
          "UPDATE agent_tasks SET dependencies_json=$2, state_version=state_version+1 WHERE task_id=$1",
          [update.taskId, JSON.stringify(update.dependencies ?? [])],
        );
      }

      for (const task of options.addedTasks ?? []) {
        const result = await client.query(
          `INSERT INTO agent_tasks(task_id, run_id, agent_id, role, status, max_attempts, dependencies_json, owned_paths_json, reasoning_level, reasoning_source)
           VALUES($1, $2, $3, $4, 'routed', $5, $6, $7, $8, $9)
           ON CONFLICT(task_id) DO NOTHING RETURNING task_id`,
          [
            task.taskId, runId, task.agentId, task.role, options.maxAttempts ?? 3,
            JSON.stringify(task.dependencies ?? []), JSON.stringify(task.ownedPaths ?? []),
            task.reasoningLevel ?? null, options.reasoningSource ?? plan.reasoning?.source ?? null,
          ],
        );
        if (result.rowCount === 1) addedTaskIds.push(result.rows[0].task_id);
      }

      const updated = await client.query(
        "UPDATE agent_runs SET plan_json=$2, state_version=state_version+1 WHERE run_id=$1 RETURNING *",
        [runId, JSON.stringify(plan)],
      );
      const payload = {
        topologyRevision: plan.workflow?.bootstrapTopologyRevision ?? null,
        authority: plan.workflow?.bootstrapTopologyAuthority ?? null,
        addedTaskIds,
        removedTaskIds,
        dependencyUpdates: options.dependencyUpdates ?? [],
      };
      await client.query(
        `INSERT INTO agent_events(event_id, run_id, task_id, event_type, payload_json, created_at)
         VALUES($1,$2,NULL,'dag.bootstrap_refined',$3,$4)`,
        [eventId, runId, JSON.stringify(payload), at],
      );
      await this.enqueueRuntimeOutbox({
        runId,
        kind: "agent.run.reconcile.v1",
        dispatchGeneration: Number(current.reconcile_generation ?? 0) + 1,
        payload: { reason: "bootstrap_topology_refined" },
      }, client);
      await client.query("SELECT pg_notify($1,$2)", [AGENT_RUNTIME_WAKE_CHANNEL, runId]);
      await client.query("COMMIT");
      runtimeLog("info", "dag.bootstrap_refined", { runId, ...payload });
      return numberFields(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async event(runId, taskId, type, payload = {}) {
    await this.requirePool().query(`INSERT INTO agent_events(event_id, run_id, task_id, event_type, payload_json, created_at)
      VALUES($1, $2, $3, $4, $5, $6)`, [newId("event"), runId, taskId ?? null, type, JSON.stringify(payload), nowIso()]);
    runtimeLog(persistedEventLogLevel(type), type, { runId, taskId: taskId ?? null, ...payload });
  }

  async eventOnce(runId, taskId, type, payload = {}, effectKey = payload?.effectKey ?? null) {
    if (!effectKey) return await this.event(runId, taskId, type, payload);
    const eventId = `event-effect-${sha256(Buffer.from(String(effectKey))).slice(0, 40)}`;
    const result = await this.requirePool().query(`INSERT INTO agent_events(event_id, run_id, task_id, event_type, payload_json, created_at)
      VALUES($1, $2, $3, $4, $5, $6) ON CONFLICT(event_id) DO NOTHING`,
      [eventId, runId, taskId ?? null, type, JSON.stringify({ ...payload, effectKey }), nowIso()]);
    if (result.rowCount === 1) runtimeLog(persistedEventLogLevel(type), type, { runId, taskId: taskId ?? null, ...payload, effectKey });
    return { inserted: result.rowCount === 1, eventId };
  }

  async updateRun(runId, patch, options = {}) {
    const entries = Object.entries(patch).filter(([key]) => RUN_PATCH_COLUMNS.has(key));
    if (entries.length === 0) return await this.getRun(runId);
    const currentBefore = await this.getRun(runId);
    if (!currentBefore) return null;
    assertTerminalRunPatch(currentBefore, patch);
    const values = entries.map(([, value]) => value ?? null);
    const assignments = entries.map(([key], index) => `${key}=$${index + 1}`);
    const guards = [];
    if (Object.prototype.hasOwnProperty.call(patch, "status")) {
      values.push(patch.status ?? null);
      guards.push(`(status NOT IN ('closed','failed','blocked','cancelled') OR status IS NOT DISTINCT FROM $${values.length})`);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "completed_at")) {
      values.push(patch.completed_at ?? null);
      guards.push(`(status NOT IN ('closed','failed','blocked','cancelled') OR completed_at IS NOT DISTINCT FROM $${values.length})`);
    }
    values.push(runId);
    let where = `run_id=$${values.length}`;
    if (guards.length > 0) where += ` AND ${guards.join(" AND ")}`;
    if (options.expectedVersion !== undefined) {
      values.push(options.expectedVersion);
      where += ` AND state_version=$${values.length}`;
    }
    const result = await this.requirePool().query(`UPDATE agent_runs SET ${assignments.join(", ")}, state_version=state_version+1
      WHERE ${where} RETURNING *`, values);
    if (result.rowCount !== 1) {
      const current = await this.getRun(runId);
      if (options.expectedVersion !== undefined && current?.state_version !== options.expectedVersion) {
        const error = new Error(`agent_run_version_conflict:${runId}:${options.expectedVersion}:${current?.state_version ?? "missing"}`);
        error.code = "agent_run_version_conflict";
        error.currentVersion = current?.state_version ?? null;
        throw error;
      }
      if (current && isTerminalRunStatus(current.status)) assertTerminalRunPatch(current, patch);
    }
    return numberFields(result.rows[0] ?? null);
  }

  async updateTask(taskId, patch, options = {}) {
    const entries = Object.entries(patch).filter(([key]) => TASK_PATCH_COLUMNS.has(key));
    if (entries.length === 0) return await this.getTask(taskId);
    const values = entries.map(([, value]) => value ?? null);
    const assignments = entries.map(([key], index) => `${key}=$${index + 1}`);
    values.push(taskId);
    let where = `task_id=$${values.length}`;
    if (options.expectedVersion !== undefined) {
      values.push(options.expectedVersion);
      where += ` AND state_version=$${values.length}`;
    }
    const result = await this.requirePool().query(`UPDATE agent_tasks SET ${assignments.join(", ")}, state_version=state_version+1
      WHERE ${where} RETURNING *`, values);
    if (options.expectedVersion !== undefined && result.rowCount !== 1) {
      const current = await this.getTask(taskId);
      const error = new Error(`agent_task_version_conflict:${taskId}:${options.expectedVersion}:${current?.state_version ?? "missing"}`);
      error.code = "agent_task_version_conflict";
      error.currentVersion = current?.state_version ?? null;
      throw error;
    }
    return numberFields(result.rows[0] ?? null);
  }

  async addArtifact({ runId, taskId = null, kind, version, path, sha256 = null, accepted = false }) {
    const artifactId = newId("artifact");
    await this.requirePool().query(`INSERT INTO agent_artifacts(artifact_id, run_id, task_id, kind, version, path, sha256, accepted, created_at)
      VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [artifactId, runId, taskId, kind, version, path, sha256, accepted ? 1 : 0, nowIso()]);
    return artifactId;
  }

  async acceptArtifact(artifactId) {
    await this.requirePool().query("UPDATE agent_artifacts SET accepted=1 WHERE artifact_id=$1", [artifactId]);
  }

  async addConflict({ runId, taskId = null, path, type, details = {} }) {
    const conflictId = newId("conflict");
    await this.requirePool().query(`INSERT INTO agent_conflicts(conflict_id, run_id, task_id, path, conflict_type, details_json, created_at)
      VALUES($1, $2, $3, $4, $5, $6, $7)`, [conflictId, runId, taskId, path, type, JSON.stringify(details), nowIso()]);
    await this.event(runId, taskId, "integration.conflict", { conflictId, path, type });
    return conflictId;
  }

  async integratedPath(runId, path) {
    const result = await this.requirePool().query("SELECT * FROM agent_integrated_paths WHERE run_id=$1 AND path=$2", [runId, path]);
    return numberFields(result.rows[0] ?? null);
  }

  async markIntegratedPath(runId, taskId, path, fingerprint = null) {
    await this.requirePool().query(`INSERT INTO agent_integrated_paths(run_id, path, task_id, fingerprint, integrated_at)
      VALUES($1, $2, $3, $4, $5) ON CONFLICT(run_id, path) DO UPDATE SET
      task_id=excluded.task_id, fingerprint=excluded.fingerprint, integrated_at=excluded.integrated_at`, [runId, path, taskId, fingerprint, nowIso()]);
  }

  async getRun(runId) {
    const result = await this.requirePool().query("SELECT * FROM agent_runs WHERE run_id=$1", [runId]);
    return numberFields(result.rows[0] ?? null);
  }

  async getTask(taskId) {
    const result = await this.requirePool().query("SELECT * FROM agent_tasks WHERE task_id=$1", [taskId]);
    return numberFields(result.rows[0] ?? null);
  }

  async listTasks(runId) {
    return rows(await this.requirePool().query("SELECT * FROM agent_tasks WHERE run_id=$1 ORDER BY task_id", [runId]));
  }

  async listRuns(limit = 100) {
    return rows(await this.requirePool().query("SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT $1", [limit]));
  }

  async listEvents(runId) {
    return rows(await this.requirePool().query("SELECT * FROM agent_events WHERE run_id=$1 ORDER BY created_at, event_id", [runId]));
  }

  async hasProgressNotificationReceipt(sourceEventId) {
    const { progressReceiptEventId } = await import("./progress.mjs");
    const result = await this.requirePool().query("SELECT 1 FROM agent_events WHERE event_id=$1 LIMIT 1", [progressReceiptEventId(sourceEventId)]);
    return result.rowCount === 1;
  }

  async recordProgressNotificationReceipt(sourceEvent, metadata = {}) {
    const { progressReceiptEventId } = await import("./progress.mjs");
    const eventId = progressReceiptEventId(sourceEvent.event_id);
    const payload = {
      sourceEventId: sourceEvent.event_id,
      sourceEventType: sourceEvent.event_type,
      reporterMode: metadata.reporterMode ?? "deterministic",
      reporterModel: metadata.reporterModel ?? null,
      persistentSessionMessage: metadata.persistentSessionMessage === true,
      toastDelivered: metadata.toastDelivered === true,
      messageId: metadata.messageId ?? null,
      coalescedToSourceEventId: metadata.coalescedToSourceEventId ?? null,
      coalescedEventCount: Number(metadata.coalescedEventCount ?? 1),
      checkpointFingerprint: metadata.checkpointFingerprint ?? null,
      equivalentCheckpoint: metadata.equivalentCheckpoint === true,
    };
    const result = await this.requirePool().query(
      `INSERT INTO agent_events(event_id,run_id,task_id,event_type,payload_json,created_at)
       VALUES($1,$2,$3,'progress.notification.sent',$4,$5)
       ON CONFLICT(event_id) DO NOTHING`,
      [eventId, sourceEvent.run_id, sourceEvent.task_id ?? null, JSON.stringify(payload), nowIso()],
    );
    return result.rowCount === 1;
  }

  async latestEvent(runId) {
    const result = await this.requirePool().query(
      "SELECT * FROM agent_events WHERE run_id=$1 ORDER BY created_at DESC, event_id DESC LIMIT 1",
      [runId],
    );
    return numberFields(result.rows[0] ?? null);
  }

  async touchTask(taskId) {
    const result = await this.requirePool().query(
      "UPDATE agent_tasks SET state_version=state_version+1 WHERE task_id=$1 RETURNING state_version",
      [taskId],
    );
    return Number(result.rows[0]?.state_version ?? 0);
  }

  async listArtifacts(runId) {
    return rows(await this.requirePool().query("SELECT * FROM agent_artifacts WHERE run_id=$1 ORDER BY created_at", [runId]));
  }

  async listConflicts(runId) {
    return rows(await this.requirePool().query("SELECT * FROM agent_conflicts WHERE run_id=$1 ORDER BY created_at", [runId]));
  }

  async listRunnableRuns(limit = 100) {
    return rows(await this.requirePool().query(
      `SELECT * FROM agent_runs WHERE status IN ('routed','running') ORDER BY created_at LIMIT $1`,
      [limit],
    ));
  }

  async claimRunReconcile(runId, ownerId, leaseMs = 120_000) {
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const result = await this.requirePool().query(
      `UPDATE agent_runs
       SET reconcile_lease_owner=$2, reconcile_lease_expires_at=$3
       WHERE run_id=$1
         AND status IN ('routed','running')
         AND (reconcile_lease_owner IS NULL OR reconcile_lease_expires_at IS NULL OR reconcile_lease_expires_at < $4 OR reconcile_lease_owner=$2)
       RETURNING *`,
      [runId, ownerId, expiresAt, nowIso()],
    );
    return numberFields(result.rows[0] ?? null);
  }

  async releaseRunReconcile(runId, ownerId) {
    await this.requirePool().query(
      `UPDATE agent_runs SET reconcile_lease_owner=NULL, reconcile_lease_expires_at=NULL
       WHERE run_id=$1 AND reconcile_lease_owner=$2`,
      [runId, ownerId],
    );
  }

  async requestReconcile(runId, reason = "state_changed") {
    const client = await this.requirePool().connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE agent_runs
           SET reconcile_generation=reconcile_generation+1, reconcile_requested_at=$2, state_version=state_version+1
         WHERE run_id=$1
         RETURNING reconcile_generation`,
        [runId, nowIso()],
      );
      if (updated.rowCount !== 1) throw new Error(`run_not_found:${runId}`);
      const generation = Number(updated.rows[0].reconcile_generation);
      await this.enqueueRuntimeOutbox({
        runId,
        kind: "agent.run.reconcile.v1",
        dispatchGeneration: generation,
        payload: { reason },
      }, client);
      await client.query("SELECT pg_notify($1,$2)", [AGENT_RUNTIME_WAKE_CHANNEL, runId]);
      await client.query("COMMIT");
      return generation;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async notifyRuntimeWakeup(runId, client = null) {
    const executor = client ?? this.requirePool();
    await executor.query("SELECT pg_notify($1,$2)", [AGENT_RUNTIME_WAKE_CHANNEL, runId]);
  }

  async expireTaskLeaseForQualification({
    runId, taskId, attempt, dispatchGeneration, fencingToken, expiredAt = new Date(Date.now() - 5_000).toISOString(),
  } = {}) {
    if (!runId || !taskId) throw new Error("qualification_lease_expiry_identity_required");
    const client = await this.requirePool().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE agent_tasks
            SET lease_expires_at=$6,state_version=state_version+1
          WHERE task_id=$1 AND run_id=$2 AND status='running'
            AND attempt=$3 AND dispatch_generation=$4 AND fencing_token=$5
          RETURNING task_id,run_id,attempt,dispatch_generation,fencing_token,lease_expires_at`,
        [taskId, runId, Number(attempt), Number(dispatchGeneration), Number(fencingToken), expiredAt],
      );
      if (result.rowCount !== 1) {
        await client.query("ROLLBACK");
        return null;
      }
      await this.notifyRuntimeWakeup(runId, client);
      await client.query("COMMIT");
      return numberFields(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async enqueueRuntimeOutbox({ runId, taskId = null, kind, dispatchGeneration = 0, payload = {} }, client = null) {
    const executor = client ?? this.requirePool();
    const outboxId = newId("agent-outbox");
    const envelope = {
      schemaVersion: "agent-runtime-envelope/v1",
      messageId: outboxId,
      kind,
      runId,
      ...(taskId ? { taskId } : {}),
      dispatchGeneration: Number(dispatchGeneration),
      ...payload,
    };
    await executor.query(
      `INSERT INTO agent_runtime_outbox(
        outbox_id, run_id, task_id, message_kind, dispatch_generation, payload_json, created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING`,
      [outboxId, runId, taskId, kind, dispatchGeneration, JSON.stringify(envelope), nowIso()],
    );
    return envelope;
  }

  async dispatchPreparedTask(taskId, { attempt, descriptorPath, reason = "dependencies_satisfied" } = {}) {
    const client = await this.requirePool().connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT * FROM agent_tasks WHERE task_id=$1 FOR UPDATE", [taskId]);
      const task = locked.rows[0];
      if (!task) throw new Error(`task_not_found:${taskId}`);
      if (!['routed','retrying'].includes(task.status)) {
        await client.query("ROLLBACK");
        return { dispatched: false, task: numberFields(task), reason: `status:${task.status}` };
      }
      const generation = Number(task.dispatch_generation ?? 0) + 1;
      const fence = Number(task.fencing_token ?? 0) + 1;
      const queuedAt = nowIso();
      const updated = await client.query(
        `UPDATE agent_tasks SET status='queued', attempt=$2, dispatch_generation=$3, fencing_token=$4,
          execution_descriptor_path=$5, execution_result_path=NULL, queued_at=$6, completed_at=NULL, retry_not_before=NULL,
          lease_owner=NULL, lease_expires_at=NULL, error_code=NULL, error_message=NULL, state_version=state_version+1
         WHERE task_id=$1 RETURNING *`,
        [taskId, attempt, generation, fence, descriptorPath, queuedAt],
      );
      await this.enqueueRuntimeOutbox({
        runId: task.run_id, taskId, kind: "agent.task.execute.v1", dispatchGeneration: generation,
        payload: { attempt, fencingToken: fence, reason },
      }, client);
      await client.query(
        `INSERT INTO agent_events(event_id, run_id, task_id, event_type, payload_json, created_at)
         VALUES($1,$2,$3,'task.queued',$4,$5)`,
        [newId("event"), task.run_id, taskId, JSON.stringify({ attempt, dispatchGeneration: generation, fencingToken: fence, reason }), queuedAt],
      );
      await client.query("COMMIT");
      return { dispatched: true, task: numberFields(updated.rows[0]), dispatchGeneration: generation, fencingToken: fence };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async writeCheckpoint({ runId, taskId, type, attempt = 0, dispatchGeneration = 0, fencingToken = 0, fingerprint = null, reusable = false, payload = {} }) {
    const checkpointId = newId("checkpoint");
    await this.requirePool().query(
      `INSERT INTO agent_task_checkpoints(
        checkpoint_id, run_id, task_id, checkpoint_type, attempt, dispatch_generation, fencing_token, fingerprint, reusable, payload_json, created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(task_id, checkpoint_type, attempt, dispatch_generation, fencing_token) DO UPDATE SET
        fingerprint=excluded.fingerprint, reusable=excluded.reusable, payload_json=excluded.payload_json,
        created_at=excluded.created_at, invalidated_at=NULL
      RETURNING checkpoint_id`,
      [checkpointId, runId, taskId, type, attempt, dispatchGeneration, fencingToken, fingerprint, reusable, JSON.stringify(payload), nowIso()],
    );
    return checkpointId;
  }

  async latestCheckpoint(taskId, type) {
    const result = await this.requirePool().query(
      `SELECT * FROM agent_task_checkpoints
       WHERE task_id=$1 AND checkpoint_type=$2 AND invalidated_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [taskId, type],
    );
    return numberFields(result.rows[0] ?? null);
  }

  async listCheckpoints(runId, taskId = null) {
    const result = taskId
      ? await this.requirePool().query("SELECT * FROM agent_task_checkpoints WHERE run_id=$1 AND task_id=$2 ORDER BY created_at", [runId, taskId])
      : await this.requirePool().query("SELECT * FROM agent_task_checkpoints WHERE run_id=$1 ORDER BY created_at", [runId]);
    return rows(result);
  }

  async listPendingExecutionResults(runId) {
    return rows(await this.requirePool().query(
      `SELECT * FROM agent_execution_results WHERE run_id=$1 AND consumed_at IS NULL ORDER BY created_at`,
      [runId],
    ));
  }

  async consumeExecutionResult(resultId) {
    const result = await this.requirePool().query(
      "UPDATE agent_execution_results SET consumed_at=$2 WHERE result_id=$1 AND consumed_at IS NULL RETURNING *",
      [resultId, nowIso()],
    );
    return numberFields(result.rows[0] ?? null);
  }

  async runtimeWorkerHealth(maxAgeMs = 45_000) {
    const result = await this.requirePool().query(
      `SELECT worker_id,worker_kind,hostname,pid,concurrency,started_at,heartbeat_at,metadata_json
       FROM agent_runtime_workers
       WHERE worker_kind='rust-executor' AND stopped_at IS NULL
       ORDER BY heartbeat_at DESC LIMIT 1`,
    );
    const row = numberFields(result.rows[0] ?? null);
    if (!row) return { available: false, healthy: false, reason: "worker_not_registered", maxAgeMs };
    const ageMs = Math.max(0, Date.now() - Date.parse(row.heartbeat_at));
    return { ...row, available: true, healthy: Number.isFinite(ageMs) && ageMs <= maxAgeMs, ageMs, maxAgeMs };
  }

  async requestWorkspaceCleanup(taskId, { reason = "task_terminal" } = {}) {
    const client = await this.requirePool().connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT run_id,attempt,dispatch_generation,fencing_token,workspace_path FROM agent_tasks WHERE task_id=$1 FOR UPDATE`,
        [taskId],
      );
      if (selected.rowCount === 0 || !selected.rows[0].workspace_path) {
        await client.query("ROLLBACK");
        return false;
      }
      const row = selected.rows[0];
      const cleanupId = newId("cleanup");
      await client.query(
        `INSERT INTO agent_workspace_cleanup_jobs(
           cleanup_id,run_id,task_id,attempt,dispatch_generation,fencing_token,workspace_path,status,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8)
         ON CONFLICT(task_id,dispatch_generation,fencing_token) DO UPDATE SET
           status=CASE WHEN agent_workspace_cleanup_jobs.status='done' THEN 'done' ELSE 'queued' END,
           workspace_path=EXCLUDED.workspace_path,
           next_attempt_at=NULL`,
        [cleanupId, row.run_id, taskId, Number(row.attempt ?? 0), Number(row.dispatch_generation ?? 0), Number(row.fencing_token ?? 0), row.workspace_path, nowIso()],
      );
      await client.query(
        `UPDATE agent_tasks SET cleanup_state='queued', cleanup_error=NULL, state_version=state_version+1
         WHERE task_id=$1 AND dispatch_generation=$2 AND fencing_token=$3`,
        [taskId, row.dispatch_generation, row.fencing_token],
      );
      await this.enqueueRuntimeOutbox({
        runId: row.run_id, taskId, kind: "agent.workspace.cleanup.v1", dispatchGeneration: Number(row.dispatch_generation ?? 0),
        payload: { fencingToken: Number(row.fencing_token ?? 0), reason },
      }, client);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async withRunReconcileLock(runId, callback) {
    const client = await this.requirePool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent-runtime-reconcile:${runId}`]);
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async aggregate() {
    const pool = this.requirePool();
    const [runsByStatus, tasksByAgentStatus, durationByAgent, contextByAgent, retriesByAgent, findings, conflicts,
      peakParallel, reasoningLevels, reasoningPromotionRows, graphEvents, modelUsage] = await Promise.all([
      pool.query("SELECT status, COUNT(*) count FROM agent_runs GROUP BY status"),
      pool.query(`SELECT task.agent_id, task.status, COUNT(*) count
        FROM agent_tasks task JOIN agent_runs run ON run.run_id=task.run_id
        GROUP BY task.agent_id, task.status`),
      pool.query("SELECT agent_id, COUNT(duration_ms) count, COALESCE(SUM(duration_ms),0) sum_ms FROM agent_tasks GROUP BY agent_id"),
      pool.query("SELECT agent_id, COALESCE(SUM(context_bytes),0) bytes, COALESCE(SUM(context_documents),0) documents, COALESCE(SUM(estimated_tokens),0) tokens FROM agent_tasks GROUP BY agent_id"),
      pool.query("SELECT agent_id, COALESCE(SUM(CASE WHEN attempt > 1 THEN attempt - 1 ELSE 0 END),0) retries FROM agent_tasks GROUP BY agent_id"),
      pool.query("SELECT COUNT(*) count FROM agent_events WHERE event_type='handoff.finding'"),
      pool.query("SELECT conflict_type, COUNT(*) count FROM agent_conflicts GROUP BY conflict_type"),
      pool.query("SELECT COALESCE(MAX(peak_parallel),0) value FROM agent_runs"),
      pool.query("SELECT COALESCE(reasoning_level, 'unknown') reasoning_level, COUNT(*) count FROM agent_tasks GROUP BY COALESCE(reasoning_level, 'unknown')"),
      pool.query("SELECT payload_json FROM agent_events WHERE event_type='reasoning.promoted'"),
      pool.query(`SELECT event_type, COUNT(*) count FROM agent_events WHERE event_type IN (
        'dag.compiled','completion.rejected','completion.proven'
      ) GROUP BY event_type`),
      pool.query(`SELECT COALESCE(model_id, 'unknown') model_id, COUNT(*) tasks,
        COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens,
        COALESCE(SUM(cached_input_tokens),0) cached_input_tokens, COALESCE(SUM(cost_usd),0) cost_usd,
        COALESCE(SUM(CASE WHEN status IN ('integrated','verified') THEN 1 ELSE 0 END),0) accepted_tasks,
        COALESCE(SUM(CASE WHEN step_limit_reached THEN 1 ELSE 0 END),0) step_limit_reached
        FROM agent_tasks GROUP BY COALESCE(model_id, 'unknown')`),
    ]);
    const reasoningGroups = new Map();
    for (const row of reasoningPromotionRows.rows) {
      try {
        const payload = JSON.parse(row.payload_json);
        const key = `${payload.from ?? "unknown"}|${payload.to ?? "unknown"}`;
        reasoningGroups.set(key, (reasoningGroups.get(key) ?? 0) + 1);
      } catch {}
    }
    return {
      runsByStatus: rows(runsByStatus),
      tasksByAgentStatus: rows(tasksByAgentStatus),
      durationByAgent: rows(durationByAgent),
      contextByAgent: rows(contextByAgent),
      retriesByAgent: rows(retriesByAgent),
      findings: numberFields(findings.rows[0] ?? { count: 0 }),
      conflicts: rows(conflicts),
      peakParallel: numberFields(peakParallel.rows[0] ?? { value: 0 }),
      reasoningLevels: rows(reasoningLevels),
      reasoningPromotions: [...reasoningGroups.entries()].map(([key, count]) => {
        const [from, to] = key.split("|");
        return { from, to, count };
      }),
      graphEvents: rows(graphEvents),
      modelUsage: rows(modelUsage),
    };
  }
}

export class OrchestrationStore {
  constructor(location, options = {}) {
    if (!POSTGRES_URL.test(location ?? "")) throw new Error("agent_postgres_url_required");
    this.location = location;
    this.options = options;
    this.delegate = new PostgresOrchestrationStore(location, options);
    this.backend = "postgres";
  }

  async open() { await this.delegate.open(); return this; }
  async close() { await this.delegate.close(); }
  async createRun(...args) { return await this.delegate.createRun(...args); }
  async event(...args) { return await this.delegate.event(...args); }
  async replacePlan(...args) { return await this.delegate.replacePlan(...args); }
  async addTasks(...args) { return await this.delegate.addTasks(...args); }
  async applyBootstrapPlanRefinement(...args) { return await this.delegate.applyBootstrapPlanRefinement(...args); }
  async updateRun(...args) { return await this.delegate.updateRun(...args); }
  async updateTask(...args) { return await this.delegate.updateTask(...args); }
  async addArtifact(...args) { return await this.delegate.addArtifact(...args); }
  async acceptArtifact(...args) { return await this.delegate.acceptArtifact(...args); }
  async addConflict(...args) { return await this.delegate.addConflict(...args); }
  async integratedPath(...args) { return await this.delegate.integratedPath(...args); }
  async markIntegratedPath(...args) { return await this.delegate.markIntegratedPath(...args); }
  async getRun(...args) { return await this.delegate.getRun(...args); }
  async getTask(...args) { return await this.delegate.getTask(...args); }
  async listTasks(...args) { return await this.delegate.listTasks(...args); }
  async listRuns(...args) { return await this.delegate.listRuns(...args); }
  async listEvents(...args) { return await this.delegate.listEvents(...args); }
  async latestEvent(...args) { return await this.delegate.latestEvent(...args); }
  async touchTask(...args) { return await this.delegate.touchTask(...args); }
  async listArtifacts(...args) { return await this.delegate.listArtifacts(...args); }
  async listConflicts(...args) { return await this.delegate.listConflicts(...args); }
  async listRunnableRuns(...args) { return await this.delegate.listRunnableRuns(...args); }
  async claimRunReconcile(...args) { return await this.delegate.claimRunReconcile(...args); }
  async releaseRunReconcile(...args) { return await this.delegate.releaseRunReconcile(...args); }
  async requestReconcile(...args) { return await this.delegate.requestReconcile(...args); }
  async notifyRuntimeWakeup(...args) { return await this.delegate.notifyRuntimeWakeup(...args); }
  async expireTaskLeaseForQualification(...args) { return await this.delegate.expireTaskLeaseForQualification(...args); }
  async enqueueRuntimeOutbox(...args) { return await this.delegate.enqueueRuntimeOutbox(...args); }
  async dispatchPreparedTask(...args) { return await this.delegate.dispatchPreparedTask(...args); }
  async writeCheckpoint(...args) { return await this.delegate.writeCheckpoint(...args); }
  async latestCheckpoint(...args) { return await this.delegate.latestCheckpoint(...args); }
  async listCheckpoints(...args) { return await this.delegate.listCheckpoints(...args); }
  async listPendingExecutionResults(...args) { return await this.delegate.listPendingExecutionResults(...args); }
  async consumeExecutionResult(...args) { return await this.delegate.consumeExecutionResult(...args); }
  async runtimeWorkerHealth(...args) { return await this.delegate.runtimeWorkerHealth(...args); }
  async requestWorkspaceCleanup(...args) { return await this.delegate.requestWorkspaceCleanup(...args); }
  async registerContinuation(...args) { return await this.delegate.registerContinuation(...args); }
  async getContinuation(...args) { return await this.delegate.getContinuation(...args); }
  async findActiveRunByContinuationTarget(...args) { return await this.delegate.findActiveRunByContinuationTarget(...args); }
  async findActiveRunByContinuationSession(...args) { return await this.delegate.findActiveRunByContinuationSession(...args); }
  async withContinuationSessionLock(...args) { return await this.delegate.withContinuationSessionLock(...args); }
  async cancelContinuation(...args) { return await this.delegate.cancelContinuation(...args); }
  async recordAgentInputArtifactReceipt(...args) { return await this.delegate.recordAgentInputArtifactReceipt(...args); }
  async listAgentInputArtifactReceipts(...args) { return await this.delegate.listAgentInputArtifactReceipts(...args); }
  async listContinuationDeliveries(...args) { return await this.delegate.listContinuationDeliveries(...args); }
  async continuationState(...args) { return await this.delegate.continuationState(...args); }
  async materializeContinuationWake(...args) { return await this.delegate.materializeContinuationWake(...args); }
  async repairTerminalContinuationWakes(...args) { return await this.delegate.repairTerminalContinuationWakes(...args); }
  async withRunReconcileLock(...args) { return await this.delegate.withRunReconcileLock(...args); }
  async aggregate(...args) { return await this.delegate.aggregate(...args); }
}
