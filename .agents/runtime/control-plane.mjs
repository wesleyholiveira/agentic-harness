import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createAgentRuntimeEngine } from "./engine.mjs";
import { buildDoctorReport } from "./doctor.mjs";
import { resolveDatabaseAppUrl } from "./database-config.mjs";
import { loadAgentCatalog } from "./agent-catalog.mjs";
import { loadSchemas } from "./schema-validator.mjs";
import { saveExecutionPlan } from "./planner.mjs";
import { AgentRuntimeEventDriver } from "./runtime-driver.mjs";
import { OrchestrationStore } from "./store.mjs";
import { buildSummary } from "./summary.mjs";
import { buildEfficiencyReport } from "./efficiency.mjs";
import { AgentProgressProjector, buildProgressSnapshot } from "./progress.mjs";
import { findDurableProgressCheckpoint } from "./progress-evidence.mjs";
import { RuntimePresentationPlane } from "./presentation-plane.mjs";
import { normalizeContinuationRegistration, runStatusToContinuationEvent, verifyContinuationTarget } from "./continuation.mjs";
import { asBoolean, asInteger, loadEnvFile, sleep } from "./utils.mjs";
import { assertPolicyAllowed, loadRuntimePolicyDocument, recordPolicyDecision, RuntimePolicyEngine } from "./policy-engine.mjs";
import { parkedObservationDisposition } from "./parked-orchestrator-guard.mjs";
import { assertAgentStartWorkerReadiness } from "./execution-plane-readiness.mjs";
import { assertQualificationMetaRunAdmission } from "./qualification-meta-run-guard.mjs";
import { contentIdentity, findManifestArtifact, loadAndVerifyAgentInputManifest, resolveManifestEntryPath, tokenEstimateFromBytes } from "./agent-input-manifest.mjs";

const TERMINAL_RUNS = new Set(["closed", "failed", "blocked", "cancelled"]);
const RETRYABLE_TASKS = new Set(["failed", "blocked", "cancelled"]);

function defaultExecutorCommand(harnessRoot) {
  const executor = join(harnessRoot, "scripts", "internal", "opencode-task-executor.mjs");
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(executor)} --agent-input-manifest {agentInputManifest} --workspace {workspace} --handoff {handoff} --model {model} --variant {variant} --reasoning-effort {reasoningEffort} --steps-limit {stepsLimit} --agent-id {agentId}`;
}

function executionOptions(input = {}, contextProvider = null, signal = undefined) {
  return {
    executorCommand: input.executorCommand ?? defaultExecutorCommand(input.harnessRoot ?? process.env.AGENT_HARNESS_ROOT ?? process.cwd()),
    harnessRoot: input.harnessRoot ?? process.env.AGENT_HARNESS_ROOT ?? process.cwd(),
    workspaceMode: input.workspaceMode ?? process.env.AGENT_HARNESS_AGENT_WORKSPACE_MODE ?? "auto",
    maxParallel: asInteger(input.maxParallel ?? process.env.AGENT_HARNESS_AGENT_MAX_PARALLEL, 3, { min: 1, max: 16 }),
    maxAttempts: asInteger(input.maxAttempts ?? process.env.AGENT_HARNESS_AGENT_MAX_ATTEMPTS, 3, { min: 1, max: 9 }),
    contextBudgetBytes: asInteger(input.contextBudgetBytes ?? process.env.AGENT_HARNESS_AGENT_CONTEXT_BUDGET_BYTES, 120_000, { min: 10_000, max: 2_000_000 }),
    taskTimeoutMs: asInteger(input.taskTimeoutMs ?? process.env.AGENT_HARNESS_AGENT_TASK_TIMEOUT_MS, 3_600_000, { min: 1_000, max: 86_400_000 }),
    prefetchParallel: asInteger(input.prefetchParallel ?? process.env.AGENT_HARNESS_AGENT_PREFETCH_PARALLEL, 2, { min: 1, max: 4 }),
    dockerHealthTimeoutMs: asInteger(input.dockerHealthTimeoutMs ?? process.env.AGENT_HARNESS_AGENT_DOCKER_HEALTH_TIMEOUT_MS, 600_000, { min: 1_000, max: 3_600_000 }),
    retryDelaysMs: [1_000, 3_000, 10_000],
    integrate: asBoolean(input.integrate ?? process.env.AGENT_HARNESS_AGENT_AUTO_INTEGRATE, true),
    policyEngine: input.policyEngine ?? null,
    contextProvider,
    ...(signal ? { signal } : {}),
  };
}

function publicRun(run) {
  if (!run) return null;
  return {
    runId: run.run_id,
    status: run.status,
    engine: run.engine,
    graphVersion: run.graph_version,
    runtimeDriver: run.runtime_driver,
    createdAt: run.created_at,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    errorCode: run.error_code,
    errorMessage: run.error_message,
    stateVersion: run.state_version,
    reconcileGeneration: run.reconcile_generation,
    maxParallel: run.max_parallel,
    peakParallel: run.peak_parallel,
  };
}

function publicTask(task) {
  return {
    taskId: task.task_id,
    agentId: task.agent_id,
    role: task.role,
    status: task.status,
    attempt: task.attempt,
    maxAttempts: task.max_attempts,
    dispatchGeneration: task.dispatch_generation,
    fencingToken: task.fencing_token,
    leaseOwner: task.lease_owner,
    leaseExpiresAt: task.lease_expires_at,
    cleanupState: task.cleanup_state,
    cleanupAttempts: task.cleanup_attempts,
    cleanupError: task.cleanup_error,
    modelId: task.model_id,
    modelVariant: task.model_variant,
    reasoningEffort: task.reasoning_effort,
    stepsLimit: task.steps_limit,
    stepsUsed: task.steps_used,
    stepLimitReached: task.step_limit_reached,
    stopReason: task.stop_reason,
    opencodeSessionId: task.opencode_session_id,
    startedAt: task.started_at,
    completedAt: task.completed_at,
    stateVersion: task.state_version,
    inputTokens: task.input_tokens,
    cachedInputTokens: task.cached_input_tokens,
    outputTokens: task.output_tokens,
    costUsd: task.cost_usd,
    errorCode: task.error_code,
    errorMessage: task.error_message,
  };
}

function publicActivity(event) {
  if (!event) return null;
  let details = null;
  try {
    const payload = JSON.parse(event.payload_json ?? "{}");
    details = Object.fromEntries(Object.entries(payload).filter(([key]) => [
      "elapsedMs", "modelId", "variant", "reasoningEffort", "stepsLimit", "attempt",
      "stdoutBytes", "stderrBytes", "lastOutputAt", "opencodeSpawned", "sessionId",
      "status", "signal", "timedOut", "aborted", "pid", "source", "phase",
      "dispatchGeneration", "fencingToken", "leaseOwner", "cleanupState",
      "orchestrationRole", "interactiveMode", "sessionRole",
    ].includes(key)));
  } catch {}
  return {
    eventId: event.event_id,
    taskId: event.task_id,
    type: event.event_type,
    createdAt: event.created_at,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}

function continuationDiagnostic(continuation, runStatus) {
  if (!continuation) return null;
  const terminalEvent = runStatusToContinuationEvent(runStatus);
  const deliveries = Array.isArray(continuation.deliveries) ? continuation.deliveries : [];
  const current = continuation.currentDeliveryId
    ? deliveries.find((delivery) => delivery.deliveryId === continuation.currentDeliveryId) ?? null
    : deliveries.at(-1) ?? null;
  return {
    ...continuation,
    diagnostic: {
      runStatus,
      wakeEligible: Boolean(terminalEvent),
      expectedTerminalEvent: terminalEvent,
      phase: terminalEvent
        ? current?.status === "observed"
          ? "wake-observed"
          : current
            ? "wake-delivery-active"
            : "wake-materialization-pending"
        : "waiting-for-run-terminal",
      currentDeliveryStatus: current?.status ?? null,
      automaticPollingRequired: false,
    },
  };
}

export class AgentRuntimeControlPlane {
  constructor({ repositoryRoot, harnessRoot = null, contextProvider = null, databaseUrl = null, databaseSchema = null, databaseNetworkMode = null } = {}) {
    if (!repositoryRoot) throw new Error("repository_root_required");
    this.repositoryRoot = repositoryRoot;
    this.harnessRoot = harnessRoot ?? process.env.AGENT_HARNESS_ROOT ?? repositoryRoot;
    this.contextProvider = contextProvider;
    this.explicitDatabaseUrl = databaseUrl;
    this.explicitDatabaseSchema = databaseSchema;
    this.databaseNetworkMode = databaseNetworkMode;
    this.databaseSchema = databaseSchema ?? "public";
    this.initialized = false;
    this.driver = null;
  }

  async initialize() {
    if (this.initialized) return;
    await loadEnvFile(join(this.repositoryRoot, ".env"));
    this.databaseSchema = this.explicitDatabaseSchema ?? process.env.AGENT_POSTGRES_SCHEMA ?? process.env.DATABASE_SCHEMA ?? "public";
    this.databaseUrl = this.explicitDatabaseUrl ?? resolveDatabaseAppUrl(process.env, { networkMode: this.databaseNetworkMode });
    if (!this.databaseUrl) throw new Error("database_url_missing");
    this.registry = await loadAgentCatalog(this.harnessRoot);
    this.schemas = await loadSchemas(this.harnessRoot);
    this.policyEngine = new RuntimePolicyEngine({ document: await loadRuntimePolicyDocument(this.harnessRoot) });
    this.driver = new AgentRuntimeEventDriver({
      repositoryRoot: this.repositoryRoot,
      databaseUrl: this.databaseUrl,
      databaseSchema: this.databaseSchema,
      registry: this.registry,
      schemas: this.schemas,
      contextProvider: this.contextProvider,
      presentationPlane: new RuntimePresentationPlane({ projectors: [new AgentProgressProjector({ environment: process.env })] }),
      optionsFactory: (persisted = {}, provider = this.contextProvider) => executionOptions({
        workspaceMode: persisted.workspaceMode,
        maxParallel: persisted.maxParallel,
        maxAttempts: persisted.maxAttempts,
        contextBudgetBytes: persisted.contextBudgetBytes,
        taskTimeoutMs: persisted.taskTimeoutMs,
        integrate: persisted.integrate,
        policyEngine: this.policyEngine,
        harnessRoot: this.harnessRoot,
      }, provider),
      reconcileParallel: asInteger(process.env.AGENT_HARNESS_AGENT_RECONCILE_PARALLEL, 2, { min: 1, max: 8 }),
      repairIntervalMs: asInteger(process.env.AGENT_HARNESS_AGENT_REPAIR_INTERVAL_MS, 30_000, { min: 5_000, max: 300_000 }),
    });
    this.initialized = true;
    await this.driver.start();
  }

  async withStore(callback, options = {}) {
    await this.initialize();
    const store = await new OrchestrationStore(this.databaseUrl, {
      schema: this.databaseSchema,
      readOnly: options.readOnly === true,
    }).open();
    try { return await callback(store); }
    finally { await store.close(); }
  }

  async recordProgressObservation(observation = {}) {
    await this.initialize();
    const eventType = String(observation?.event ?? "").trim();
    if (eventType !== "progress.live_delivery_observed") {
      return { persisted: false, correlated: false, reason: "presentation_observation_event_not_durable" };
    }
    const observedRunId = String(observation?.runId ?? "").trim();
    const messageId = String(observation?.messageId ?? "").trim();
    const instanceId = String(observation?.instanceId ?? "").trim();
    const sessionId = String(observation?.sessionId ?? "").trim();
    if (!observedRunId || !messageId || !instanceId || !sessionId) {
      return { persisted: false, correlated: false, reason: "presentation_observation_identity_missing" };
    }
    return await this.withStore(async (store) => {
      let runId = observedRunId;
      let run = await store.getRun(runId);
      // R11 emitted `CLIP_RUNTIME_PROGRESS_RUN_ID=<run>.` in the system marker.
      // The TUI parser historically accepted the narrative period as part of the
      // id. Canonicalize only as a recovery path when the exact id does not exist
      // and the punctuation-stripped id resolves to a real Runtime run.
      if (!run) {
        const recoveredRunId = observedRunId.replace(/[.;,!?]+$/, "");
        if (recoveredRunId && recoveredRunId !== observedRunId) {
          const recoveredRun = await store.getRun(recoveredRunId);
          if (recoveredRun) {
            runId = recoveredRunId;
            run = recoveredRun;
          }
        }
      }
      if (!run) return { persisted: false, correlated: false, reason: "presentation_observation_run_not_found" };
      const events = await store.listEvents(runId);
      // R13: H-9 presentation evidence is anchored to the durable checkpoint
      // itself. `progress.notification.sent` is only a delivery/coalescing
      // receipt and can legitimately predate or differ from the final persisted
      // checkpoint metadata, so it is not correlation authority.
      const correlatedCheckpoint = findDurableProgressCheckpoint(events, messageId);
      if (!correlatedCheckpoint) {
        return { persisted: false, correlated: false, reason: "presentation_observation_checkpoint_not_persisted" };
      }
      const effectKey = `runtime-progress-live-observation/v1:${runId}:${instanceId}:${sessionId}:${messageId}`;
      const payload = {
        pluginId: String(observation.pluginId ?? ""),
        instanceId,
        sessionId,
        messageId,
        checkpointSourceEventId: correlatedCheckpoint.payload.sourceEventId ?? null,
        checkpointEffectKey: correlatedCheckpoint.effectKey,
        pollMs: Number.isFinite(Number(observation.pollMs)) ? Number(observation.pollMs) : null,
        checkpointCreatedAt: Number.isFinite(Number(observation.checkpointCreatedAt)) ? Number(observation.checkpointCreatedAt) : null,
        projectionLatencyMs: Number.isFinite(Number(observation.projectionLatencyMs)) ? Number(observation.projectionLatencyMs) : null,
        observedAt: Number.isFinite(Number(observation.observedAt)) ? Number(observation.observedAt) : null,
        receivedAt: Number.isFinite(Number(observation.receivedAt)) ? Number(observation.receivedAt) : null,
        source: "opencode-tui-plugin",
        authoritative: false,
        presentationOnly: true,
        effectKey,
      };
      const result = typeof store.eventOnce === "function"
        ? await store.eventOnce(runId, null, eventType, payload, effectKey)
        : (await store.event(runId, null, eventType, payload), { inserted: true, eventId: null });
      return { persisted: true, correlated: true, runId, inserted: result?.inserted !== false, eventId: result?.eventId ?? null, effectKey };
    });
  }

  engine() { return createAgentRuntimeEngine({ policyEngine: this.policyEngine }); }

  async assertExecutionPlaneReadyForStart(store) {
    const required = asBoolean(process.env.AGENT_HARNESS_RUNTIME_WORKER_REQUIRED, true);
    const maxAgeMs = asInteger(
      process.env.AGENT_HARNESS_RUNTIME_WORKER_HEARTBEAT_TIMEOUT_MS,
      45_000,
      { min: 1_000, max: 300_000 },
    );
    const worker = required ? await store.runtimeWorkerHealth(maxAgeMs) : null;
    return assertAgentStartWorkerReadiness(worker, { required, maxAgeMs });
  }

  async start({ request, agents = [], maxParallel, maxAttempts, contextBudgetBytes, integrate, continuation = null } = {}, invocation = {}) {
    if (!request?.trim()) throw new Error("agent_request_required");
    // R15.6.2: the outer qualification controller is not a Runtime workload.
    // Reject stale/operator prompts that try to model SOURCE/H-8/H-9/report as
    // Dynamic DAG work before Runtime initialization, continuation preflight,
    // store locking or engine.plan.
    assertQualificationMetaRunAdmission(request);
    await this.initialize();
    const explicitAgents = Array.isArray(agents) ? [...new Set(agents.filter(Boolean))] : [];
    const normalizedContinuation = normalizeContinuationRegistration(continuation);
    const continuationPreflight = normalizedContinuation
      ? await verifyContinuationTarget(normalizedContinuation, process.env)
      : null;
    const continuationBinding = normalizedContinuation
      ? { ...normalizedContinuation, promptIdentity: continuationPreflight?.promptIdentity ?? null }
      : null;
    const options = executionOptions({ maxParallel, maxAttempts, contextBudgetBytes, integrate, policyEngine: this.policyEngine, harnessRoot: this.harnessRoot }, this.contextProvider);
    const engine = this.engine();

    const planned = await this.withStore(async (store) => {
      const createOrReuse = async () => {
        if (normalizedContinuation) {
          const active = await store.findActiveRunByContinuationTarget(continuationBinding);
          if (active) {
            let phase = null;
            try { phase = JSON.parse(active.plan_json ?? "{}").phase ?? null; } catch {}
            if (invocation?.provenanceSource === "opencode-plugin-sidechannel") {
              await store.event(active.run_id, null, "orchestrator.agent_start_provenance_accepted", {
                origin: invocation?.origin ?? "unknown",
                sessionId: invocation?.sessionId ?? null,
                callId: invocation?.callId ?? null,
                userMessageId: invocation?.userMessageId ?? null,
                provenanceSource: invocation?.provenanceSource ?? "missing",
                historySource: invocation?.historySource ?? null,
                historyErrorCode: invocation?.historyErrorCode ?? null,
                authoritative: true,
                deduplicated: true,
              });
            }
            return {
              deduplicated: true,
              runId: active.run_id,
              phase,
              requestMatched: String(active.request ?? "").trim() === String(request).trim(),
            };
          }
        }
        // R15.2: do not materialize a new authoritative run when the required
        // Rust execution plane is already stale. Durable outbox semantics can
        // recover a worker that dies after dispatch, but accepting a brand-new
        // run with no fresh worker leaves the first task queued with no relay or
        // consumer and makes a parked session look alive forever. This bounded
        // PostgreSQL heartbeat check is deliberately narrower than full doctor.
        const executionPlanePreflight = await this.assertExecutionPlaneReadyForStart(store);
        const value = await engine.plan({
          repositoryRoot: this.repositoryRoot,
          registry: this.registry,
          request,
          schemas: this.schemas,
          explicitAgents,
          store,
          options: {
            maxParallel: options.maxParallel,
            maxAttempts: options.maxAttempts,
            workspaceMode: options.workspaceMode,
            contextBudgetBytes: options.contextBudgetBytes,
            taskTimeoutMs: options.taskTimeoutMs,
            integrate: options.integrate,
            executorCommand: options.executorCommand,
            continuation: continuationBinding,
            invocationProvenance: invocation,
          },
        });
        return { deduplicated: false, executionPlanePreflight, ...value };
      };
      return continuationBinding
        ? await store.withContinuationSessionLock(continuationBinding, createOrReuse)
        : await createOrReuse();
    });

    if (planned.deduplicated) {
      const existing = await this.status(planned.runId);
      return {
        runId: planned.runId,
        status: existing.run.status,
        phase: planned.phase ?? null,
        stateVersion: existing.run.stateVersion,
        planPath: null,
        reasoning: null,
        continuation: existing.continuation,
        continuationPreflight,
        deduplicated: true,
        newRunCreated: false,
        startDisposition: "existing-active-run",
        deduplicationReason: "active_continuation_session_exclusive",
        requestMatched: planned.requestMatched,
        next: existing.continuation ? "session-resume-event" : "agent_status",
      };
    }

    const { plan, reasoningAssessment } = planned;
    const planPath = await saveExecutionPlan(this.repositoryRoot, plan);
    this.driver.wake(plan.runId);
    const initial = await this.status(plan.runId);
    return {
      runId: plan.runId,
      status: initial.run.status,
      phase: plan.phase,
      stateVersion: initial.run.stateVersion,
      planPath,
      reasoning: reasoningAssessment,
      continuation: initial.continuation,
      continuationPreflight,
      executionPlanePreflight: planned.executionPlanePreflight ?? null,
      deduplicated: false,
      newRunCreated: true,
      startDisposition: "created",
      next: TERMINAL_RUNS.has(initial.run.status)
        ? "agent_summary"
        : initial.continuation
          ? "session-resume-event"
          : "agent_wait",
    };
  }

  async status(runId = null) {
    return await this.withStore(async (store) => {
      if (!runId) {
        const runs = (await store.listRuns(50)).map(publicRun);
        const executionPlane = await store.runtimeWorkerHealth(
          asInteger(process.env.AGENT_HARNESS_RUNTIME_WORKER_HEARTBEAT_TIMEOUT_MS, 45_000, { min: 1_000, max: 300_000 }),
        );
        return {
          runs,
          activeRunIds: runs.filter((run) => !TERMINAL_RUNS.has(run.status)).map((run) => run.runId),
          runtimeDriver: this.driver?.snapshot?.() ?? { started: false },
          executionPlane,
        };
      }
      const run = await store.getRun(runId);
      if (!run) throw new Error(`run_not_found:${runId}`);
      const taskRows = await store.listTasks(runId);
      const latestEvent = await store.latestEvent(runId);
      const activityVersion = taskRows.reduce((sum, task) => sum + Number(task.state_version ?? 0), 0);
      const terminal = TERMINAL_RUNS.has(run.status);
      const executionPlane = await store.runtimeWorkerHealth(
        asInteger(process.env.AGENT_HARNESS_RUNTIME_WORKER_HEARTBEAT_TIMEOUT_MS, 45_000, { min: 1_000, max: 300_000 }),
      );
      const continuation = continuationDiagnostic(await store.continuationState(runId), run.status);
      return {
        run: publicRun(run),
        tasks: taskRows.map(publicTask),
        active: !terminal && this.driver?.isStarted() === true,
        needsResume: !terminal && this.driver?.isStarted() !== true,
        runtimeDriver: this.driver?.snapshot?.() ?? { started: false },
        executionPlane,
        continuation,
        activityVersion,
        lastActivity: publicActivity(latestEvent),
        checkpoints: (await store.listCheckpoints(runId)).map((checkpoint) => ({
          checkpointId: checkpoint.checkpoint_id,
          taskId: checkpoint.task_id,
          type: checkpoint.checkpoint_type,
          attempt: checkpoint.attempt,
          dispatchGeneration: checkpoint.dispatch_generation,
          fencingToken: checkpoint.fencing_token,
          reusable: Boolean(checkpoint.reusable),
          createdAt: checkpoint.created_at,
        })),
        conflicts: await store.listConflicts(runId),
        artifacts: (await store.listArtifacts(runId)).map((artifact) => ({
          artifactId: artifact.artifact_id,
          taskId: artifact.task_id,
          kind: artifact.kind,
          version: artifact.version,
          path: artifact.path,
          accepted: Boolean(artifact.accepted),
        })),
      };
    }, { readOnly: true });
  }

  async assertObservationAllowed(toolName, runId = null, invocation = {}) {
    const invocationOrigin = String(invocation?.origin ?? "unknown").trim() || "unknown";
    const inspect = async (targetRunId) => {
      const status = await this.status(targetRunId);
      const disposition = parkedObservationDisposition({ toolName, status, invocationOrigin });
      if (disposition.action === "allow") return null;
      if (disposition.action === "allow-human") {
        await this.withStore(async (store) => {
          const run = await store.getRun(targetRunId);
          if (run) await store.event(targetRunId, null, "orchestrator.parked_human_observation_allowed", {
            toolName, runStatus: run.status, invocationOrigin,
            invocationSessionId: invocation?.sessionId ?? null, invocationCallId: invocation?.callId ?? null,
            invocationUserMessageId: invocation?.userMessageId ?? null, provenanceSource: invocation?.provenanceSource ?? "missing",
            authoritative: false, humanInitiated: true,
          });
        }).catch(() => {});
        return null;
      }
      await this.withStore(async (store) => {
        const run = await store.getRun(targetRunId);
        if (run) await store.event(targetRunId, null, "orchestrator.parked_observation_denied", {
          toolName, runStatus: run.status, invocationOrigin,
          invocationSessionId: invocation?.sessionId ?? null, invocationCallId: invocation?.callId ?? null,
          invocationUserMessageId: invocation?.userMessageId ?? null, provenanceSource: invocation?.provenanceSource ?? "missing",
          authoritative: true, humanInitiated: false,
        });
      }).catch(() => {});
      return disposition.violation;
    };

    if (runId) {
      const violation = await inspect(runId);
      if (violation) throw new Error(violation);
      return { allowed: true, runId };
    }

    const overview = await this.status(null);
    for (const activeRunId of overview.activeRunIds ?? []) {
      const violation = await inspect(activeRunId);
      if (violation) throw new Error(violation);
    }
    return { allowed: true, runId: null };
  }

  async wait(runId, { afterVersion = null, timeoutMs = 15_000 } = {}) {
    const boundedTimeout = asInteger(timeoutMs, 15_000, { min: 250, max: 30_000 });
    const started = Date.now();
    let latest = await this.status(runId);
    const initialVersion = afterVersion ?? latest.run.stateVersion;
    const initialActivityVersion = latest.activityVersion ?? 0;
    while (!TERMINAL_RUNS.has(latest.run.status) && Date.now() - started < boundedTimeout) {
      const runChanged = latest.run.stateVersion !== initialVersion;
      const activityChanged = (latest.activityVersion ?? 0) !== initialActivityVersion;
      if (runChanged || activityChanged) break;
      await sleep(500);
      latest = await this.status(runId);
    }
    const runChanged = latest.run.stateVersion !== initialVersion;
    const activityChanged = (latest.activityVersion ?? 0) !== initialActivityVersion;
    const changed = runChanged || activityChanged;
    return {
      ...latest,
      changed,
      runChanged,
      activityChanged,
      timedOut: !TERMINAL_RUNS.has(latest.run.status) && !changed,
      next: TERMINAL_RUNS.has(latest.run.status)
        ? "agent_summary"
        : latest.continuation
          ? "session-resume-event"
          : "agent_wait",
    };
  }

  async bindContinuation(runId, continuation) {
    await this.initialize();
    const normalized = normalizeContinuationRegistration(continuation);
    if (!normalized) throw new Error("agent_continuation_required");
    const continuationPreflight = await verifyContinuationTarget(normalized, process.env);
    const continuationBinding = { ...normalized, promptIdentity: continuationPreflight?.promptIdentity ?? null };
    return await this.withStore(async (store) => await store.withContinuationSessionLock(continuationBinding, async () => {
      const run = await store.getRun(runId);
      if (!run) throw new Error(`run_not_found:${runId}`);
      if (TERMINAL_RUNS.has(run.status)) throw new Error(`agent_continuation_bind_terminal_run_forbidden:${runId}:${run.status}`);
      const active = await store.findActiveRunByContinuationTarget(continuationBinding);
      if (active && active.run_id !== runId) {
        throw new Error(`agent_continuation_session_active_run_conflict:${active.run_id}`);
      }
      await store.registerContinuation(runId, continuationBinding);
      const state = await store.continuationState(runId);
      return {
        runId,
        status: run.status,
        continuation: continuationDiagnostic(state, run.status),
        continuationPreflight,
        next: "session-resume-event",
      };
    }));
  }

  async getDag(runId) {
    return await this.withStore(async (store) => {
      const run = await store.getRun(runId);
      if (!run) throw new Error(`run_not_found:${runId}`);
      const plan = JSON.parse(run.plan_json);
      return { runId, phase: plan.phase, graphVersion: run.graph_version, tasks: plan.tasks, workflow: plan.workflow, sharedPathOwner: plan.sharedPathOwner };
    }, { readOnly: true });
  }

  async resume(runId) {
    await this.initialize();
    const status = await this.status(runId);
    if (TERMINAL_RUNS.has(status.run.status)) return { runId, status: status.run.status, launched: false };
    await this.withStore(async (store) => await store.requestReconcile(runId, "manual_resume"));
    this.driver.wake(runId);
    return { runId, status: "running", launched: true, alreadyActive: true, next: "agent_status" };
  }

  async retry(runId, taskId) {
    await this.initialize();
    await this.withStore(async (store) => {
      const run = await store.getRun(runId);
      if (!run) throw new Error(`run_not_found:${runId}`);
      if (TERMINAL_RUNS.has(run.status)) {
        throw new Error(`agent_retry_terminal_run_forbidden:${runId}:${run.status}:start_new_run`);
      }
      const task = await store.getTask(taskId);
      if (!task || task.run_id !== runId) throw new Error(`task_not_found:${taskId}`);
      if (!RETRYABLE_TASKS.has(task.status)) throw new Error(`task_not_retryable_from_status:${task.status}`);
      const retryDecision = this.policyEngine.evaluateRetry({
        failure: { code: `manual_retry:${task.error_code ?? task.status}`, retryable: true },
        attempt: Number(task.attempt),
        maxAttempts: Number(task.max_attempts),
      });
      await recordPolicyDecision(store, { runId, taskId, operation: "retry", decision: retryDecision });
      assertPolicyAllowed(retryDecision, "runtime_policy_manual_retry_denied");
      await store.updateTask(taskId, { status: "routed", error_code: null, error_message: null, completed_at: null, retry_not_before: null });
      await store.updateRun(runId, { status: "routed", completed_at: null, error_code: null, error_message: null });
      await store.event(runId, taskId, "task.manual_retry", { priorAttempt: task.attempt, source: "context-engine-mcp" });
      await store.requestReconcile(runId, "manual_retry");
    });
    this.driver.wake(runId);
    const continuation = (await this.status(runId)).continuation;
    return { runId, taskId, status: "running", launched: true, alreadyActive: true, continuation, next: continuation ? "session-resume-event" : "agent_wait" };
  }

  async cancel(runId) {
    await this.initialize();
    const engine = this.engine();
    const result = await this.withStore(async (store) => {
      const value = await engine.cancel({ store, runId });
      await store.requestReconcile(runId, "run_cancelled").catch(() => {});
      return value;
    });
    this.driver.wake(runId);
    return result;
  }

  async summary(runId = null) { return await this.withStore(async (store) => await buildSummary(store, runId), { readOnly: true }); }

  async efficiency(runId) {
    return await this.withStore(async (store) => await buildEfficiencyReport(store, runId), { readOnly: true });
  }

  async getAgentInputArtifact({ runId, taskId, attempt, manifestFingerprint, artifactRef, callerAgentId = null }) {
    return await this.withStore(async (store) => {
      const task = await store.getTask(taskId);
      if (!task || task.run_id !== runId) throw new Error(`agent_input_artifact_task_not_found:${runId}:${taskId}`);
      if (callerAgentId && callerAgentId !== task.agent_id) throw new Error(`agent_input_artifact_caller_not_authorized:${callerAgentId}:${task.agent_id}`);
      if (Number(task.attempt) !== Number(attempt)) throw new Error(`agent_input_artifact_attempt_stale:${attempt}:${task.attempt}`);
      if (!task.input_manifest_path || !task.input_manifest_fingerprint) throw new Error("agent_input_artifact_manifest_missing");
      if (task.input_manifest_fingerprint !== manifestFingerprint) throw new Error("agent_input_artifact_manifest_fingerprint_stale");
      const manifest = await loadAndVerifyAgentInputManifest(task.input_manifest_path, this.schemas.agentInputManifest);
      if (manifest.manifestFingerprint !== manifestFingerprint || Number(manifest.attempt) !== Number(attempt)) throw new Error("agent_input_artifact_manifest_identity_mismatch");
      const entry = findManifestArtifact(manifest, artifactRef);
      if (!entry) throw new Error(`agent_input_artifact_ref_not_authorized:${artifactRef}`);
      const path = resolveManifestEntryPath(task.input_manifest_path, entry);
      if (!path) throw new Error(`agent_input_artifact_path_missing:${artifactRef}`);
      const bytes = await readFile(path);
      const maxBytes = Number(entry.lazyPolicy?.maxBytes ?? 1_000_000);
      if (bytes.byteLength > maxBytes) throw new Error(`agent_input_artifact_size_exceeded:${bytes.byteLength}:${maxBytes}`);
      const mediaType = entry.mediaType ?? "application/json";
      const allowed = entry.lazyPolicy?.allowedMediaTypes ?? [mediaType];
      if (!allowed.includes(mediaType)) throw new Error(`agent_input_artifact_media_type_not_allowed:${mediaType}`);
      const actualHash = contentIdentity(bytes);
      if (actualHash !== entry.contentHash) throw new Error(`agent_input_artifact_hash_mismatch:${entry.contentHash}:${actualHash}`);
      const estimatedTokens = tokenEstimateFromBytes(bytes.byteLength);
      const receipt = await store.recordAgentInputArtifactReceipt({
        runId, taskId, attempt: Number(attempt), manifestFingerprint, artifactRef,
        contentSha256: actualHash, bytes: bytes.byteLength, estimatedTokens,
      });
      await store.event(runId, taskId, "agent_input.artifact_delivered", {
        attempt: Number(attempt), manifestFingerprint, artifactRef, contentHash: actualHash,
        bytes: bytes.byteLength, estimatedTokens, callerAgentId, receiptId: receipt?.receipt_id ?? null,
      });
      return {
        contractVersion: "agent-input-artifact-delivery/v1", runId, taskId, attempt: Number(attempt),
        manifestFingerprint, artifactRef, contentHash: actualHash, mediaType, bytes: bytes.byteLength, estimatedTokens,
        receiptId: receipt?.receipt_id ?? null, content: bytes.toString("utf8"),
      };
    });
  }

  async progress(runId = null, { includeEfficiency = true } = {}) {
    return await this.withStore(async (store) => {
      const snapshot = await buildProgressSnapshot(store, runId, { includeEfficiency });
      if (!snapshot) return { contractVersion: "agent-runtime-progress/v1", run: null, message: "No Runtime V2 runs found" };
      return snapshot;
    }, { readOnly: true });
  }

  async progressForSession(sessionId, { includeEfficiency = false } = {}) {
    return await this.withStore(async (store) => {
      const active = await store.findActiveRunByContinuationSession(sessionId);
      if (!active) return null;
      return await buildProgressSnapshot(store, active.run_id, { includeEfficiency });
    }, { readOnly: true });
  }

  async doctor() {
    await loadEnvFile(join(this.repositoryRoot, ".env"));
    const databaseUrl = this.explicitDatabaseUrl ?? resolveDatabaseAppUrl(process.env, { networkMode: this.databaseNetworkMode });
    const databaseSchema = this.explicitDatabaseSchema ?? process.env.AGENT_POSTGRES_SCHEMA ?? process.env.DATABASE_SCHEMA ?? "public";
    return await buildDoctorReport({ repositoryRoot: this.repositoryRoot, harnessRoot: this.harnessRoot, databaseUrl, databaseSchema });
  }
}

export { executionOptions as buildAgentRuntimeExecutionOptions };
