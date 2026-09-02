import { assertTerminalRunPatch, isActiveRunStatus } from "./run-invariants.mjs";
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

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export class InMemoryTestOrchestrationStore {
  constructor({ sessionAdapters = null } = {}) {
    this.runs = new Map();
    this.tasks = new Map();
    this.events = [];
    this.eventSequence = 0;
    this.continuations = new Map();
    this.continuationDeliveries = new Map();
    this.sessionAdapters = sessionAdapters ?? createDefaultSessionAdapterRegistry({ environment: {}, fetchImpl: null });
  }

  async open() { return this; }
  close() {}

  createRun(plan, options = {}) {
    const run = {
      run_id: plan.runId,
      request: plan.request,
      status: "routed",
      plan_json: JSON.stringify(plan),
      executor: options.executor ?? options.executorCommand ?? null,
      workspace_mode: options.workspaceMode ?? null,
      max_parallel: options.maxParallel ?? 1,
      peak_parallel: 0,
      created_at: plan.createdAt,
      engine: options.engine ?? "dynamic-dag-v2",
      graph_version: options.graphVersion ?? null,
      state_version: 0,
      reasoning_mode: plan.reasoning?.mode ?? null,
      reasoning_source: plan.reasoning?.source ?? null,
      initial_reasoning_level: plan.reasoning?.initialLevel ?? null,
      reasoning_confidence: plan.reasoning?.confidence ?? null,
    };
    this.runs.set(plan.runId, run);
    for (const task of plan.tasks) this.#insertTask(plan.runId, task, options);
    if (options.continuation) this.registerContinuation(plan.runId, options.continuation);
    this.event(plan.runId, null, "run.routed", {
      taskCount: plan.tasks.length,
      maxParallel: options.maxParallel ?? 1,
      reasoning: plan.reasoning ?? null,
      bootstrapReviewTopology: plan.workflow?.bootstrapReviewTopology ?? null,
      bootstrapReviewDependencies: plan.workflow?.bootstrapReviewDependencies ?? [],
    });
  }


  registerContinuation(runId, registration) {
    if (!registration) return null;
    const existing = this.continuations.get(runId);
    const normalizedWakeEvents = normalizeContinuationWakeEvents(registration.wakeOn);
    const promptIdentity = {
      agentId: String(registration?.promptIdentity?.agentId ?? "").trim(),
      providerId: String(registration?.promptIdentity?.providerId ?? "").trim(),
      modelId: String(registration?.promptIdentity?.modelId ?? "").trim(),
      variant: String(registration?.promptIdentity?.variant ?? "").trim() || null,
      sourceMessageId: String(registration?.promptIdentity?.sourceMessageId ?? "").trim() || null,
    };
    if (!promptIdentity.agentId || !promptIdentity.providerId || !promptIdentity.modelId) {
      throw new Error("agent_continuation_prompt_identity_required");
    }
    const sameRegistration = existing
      && (existing.session_adapter_id ?? "opencode") === (registration.adapterId ?? "opencode")
      && existing.opencode_session_id === registration.sessionId
      && existing.opencode_server_url === registration.serverUrl
      && (existing.opencode_directory ?? null) === (registration.directory ?? null)
      && existing.wake_events_json === JSON.stringify(normalizedWakeEvents)
      && existing.session_agent_id === promptIdentity.agentId
      && existing.session_provider_id === promptIdentity.providerId
      && existing.session_model_id === promptIdentity.modelId
      && (existing.session_model_variant ?? null) === promptIdentity.variant
      && (existing.session_prompt_message_id ?? null) === promptIdentity.sourceMessageId;
    if (existing && (existing.generation !== 0 || existing.status !== "parked" || !sameRegistration)) {
      throw new Error(`agent_continuation_rebind_not_allowed:${runId}`);
    }
    const createdAt = nowIso();
    const row = {
      continuation_id: `agent-continuation-${sha256(Buffer.from(`${runId}|${registration.adapterId ?? "opencode"}|${registration.sessionId}`)).slice(0, 32)}`,
      run_id: runId,
      schema_version: AGENT_CONTINUATION_SCHEMA_VERSION,
      session_adapter_id: registration.adapterId ?? "opencode",
      opencode_session_id: registration.sessionId,
      opencode_server_url: registration.serverUrl,
      opencode_directory: registration.directory ?? null,
      wake_events_json: JSON.stringify(normalizedWakeEvents),
      session_agent_id: promptIdentity.agentId,
      session_provider_id: promptIdentity.providerId,
      session_model_id: promptIdentity.modelId,
      session_model_variant: promptIdentity.variant,
      session_prompt_message_id: promptIdentity.sourceMessageId,
      status: "parked",
      generation: 0,
      current_delivery_id: null,
      created_at: existing?.created_at ?? createdAt,
      updated_at: createdAt,
    };
    this.continuations.set(runId, row);
    this.event(runId, null, "continuation.parked", {
      continuationId: row.continuation_id,
      adapterId: row.session_adapter_id ?? "opencode",
      sessionId: row.opencode_session_id,
      opencodeSessionId: row.opencode_session_id,
      wakeOn: JSON.parse(row.wake_events_json),
    });
    const run = this.runs.get(runId);
    if (runStatusToContinuationEvent(run?.status)) this.materializeContinuationWake(runId, { status: run.status });
    return clone(row);
  }

  getContinuation(runId) { return clone(this.continuations.get(runId) ?? null); }

  findActiveRunByContinuationTarget({ adapterId = "opencode", sessionId, serverUrl }) {
    const matches = [...this.runs.values()]
      .filter((run) => isActiveRunStatus(run.status))
      .map((run) => ({ run, continuation: this.continuations.get(run.run_id) }))
      .filter(({ continuation }) => continuation
        && continuation.status !== "cancelled"
        && (continuation.session_adapter_id ?? "opencode") === adapterId
        && continuation.opencode_session_id === sessionId
        && continuation.opencode_server_url === serverUrl)
      .sort((left, right) => String(right.run.created_at).localeCompare(String(left.run.created_at)));
    if (matches.length === 0) return null;
    return clone({ ...matches[0].run, continuation_id: matches[0].continuation.continuation_id, continuation_status: matches[0].continuation.status });
  }

  async withContinuationSessionLock(_target, callback) { return await callback(); }

  cancelContinuation(runId, { reason = "operator_cancelled" } = {}) {
    const continuation = this.continuations.get(runId);
    if (!continuation) return { runId, cancelled: false, reason: "continuation_not_bound" };
    if (continuation.status === "cancelled") {
      return { runId, continuationId: continuation.continuation_id, cancelled: false, reason: "already_cancelled" };
    }
    const at = nowIso();
    continuation.status = "cancelled";
    continuation.cancelled_at = continuation.cancelled_at ?? at;
    continuation.updated_at = at;
    let deadDeliveries = 0;
    for (const delivery of this.continuationDeliveries.values()) {
      if (delivery.continuation_id !== continuation.continuation_id) continue;
      if (!["pending", "claimed", "deferred"].includes(delivery.status)) continue;
      if (delivery.accepted_at || delivery.observed_at) continue;
      delivery.status = "dead";
      delivery.completed_at = delivery.completed_at ?? at;
      delivery.updated_at = at;
      delivery.last_error = delivery.last_error ?? `continuation_cancelled:${reason}`;
      deadDeliveries += 1;
    }
    this.event(runId, null, "continuation.cancelled", { continuationId: continuation.continuation_id, reason, deadDeliveries });
    return { runId, continuationId: continuation.continuation_id, cancelled: true, deadDeliveries };
  }

  listContinuationDeliveries(runId) {
    return [...this.continuationDeliveries.values()]
      .filter((delivery) => delivery.run_id === runId)
      .sort((left, right) => left.generation - right.generation)
      .map(clone);
  }

  continuationState(runId) {
    const continuation = this.continuations.get(runId);
    if (!continuation) return null;
    return {
      continuationId: continuation.continuation_id,
      runId,
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
      wakeOn: JSON.parse(continuation.wake_events_json),
      status: continuation.status,
      generation: continuation.generation,
      currentDeliveryId: continuation.current_delivery_id,
      deliveries: this.listContinuationDeliveries(runId).map((delivery) => ({
        deliveryId: delivery.delivery_id,
        generation: delivery.generation,
        event: delivery.event_type,
        effectKey: delivery.effect_key,
        sessionMessageId: delivery.opencode_message_id,
        opencodeMessageId: delivery.opencode_message_id,
        status: delivery.status,
        attempts: delivery.attempts,
      })),
    };
  }

  materializeContinuationWake(runId, { status = null } = {}) {
    const continuation = this.continuations.get(runId);
    const run = this.runs.get(runId);
    if (!continuation || !run || continuation.status === "cancelled") return null;
    const runStatus = run.status;
    if (status !== null && status !== undefined && status !== runStatus) return null;
    const eventType = runStatusToContinuationEvent(runStatus);
    if (!eventType || !JSON.parse(continuation.wake_events_json).includes(eventType)) return null;
    if (!run.completed_at) throw new Error(`agent_continuation_terminal_completed_at_missing:${runId}`);
    const terminalOccurrenceKey = `completed-at:${run.completed_at}`;
    const effectKey = buildContinuationEffectKey({
      continuationId: continuation.continuation_id,
      runId,
      terminalOccurrenceKey,
      eventType,
    });
    const existing = [...this.continuationDeliveries.values()].find((delivery) => delivery.effect_key === effectKey);
    if (existing) return { delivery: clone(existing), created: false };
    const generation = continuation.generation + 1;
    const createdAt = nowIso();
    const prompt = buildContinuationPrompt({ runId, eventType, effectKey, generation });
    const delivery = {
      delivery_id: `continuation-delivery-${sha256(Buffer.from(effectKey)).slice(0, 32)}`,
      continuation_id: continuation.continuation_id,
      run_id: runId,
      schema_version: AGENT_CONTINUATION_DELIVERY_SCHEMA_VERSION,
      generation,
      event_type: eventType,
      terminal_occurrence_key: terminalOccurrenceKey,
      effect_key: effectKey,
      opencode_message_id: this.sessionAdapters.buildMessageId(continuation.session_adapter_id ?? "opencode", {
        effectKey,
        createdAt,
      }),
      prompt_text: prompt,
      prompt_sha256: continuationPromptFingerprint(prompt),
      status: "pending",
      attempts: 0,
      created_at: createdAt,
      updated_at: createdAt,
    };
    this.continuationDeliveries.set(delivery.delivery_id, delivery);
    Object.assign(continuation, {
      status: "wake_pending",
      generation,
      current_delivery_id: delivery.delivery_id,
      updated_at: createdAt,
    });
    this.event(runId, null, "continuation.wake_materialized", {
      continuationId: continuation.continuation_id,
      deliveryId: delivery.delivery_id,
      effectKey,
      eventType,
      generation,
    });
    return { delivery: clone(delivery), created: true };
  }

  repairTerminalContinuationWakes(limit = 200) {
    const repaired = [];
    for (const run of [...this.runs.values()].slice(0, Math.max(1, Number(limit) || 200))) {
      if (!runStatusToContinuationEvent(run.status)) continue;
      const outcome = this.materializeContinuationWake(run.run_id, { status: run.status });
      if (outcome?.created) repaired.push(outcome.delivery.delivery_id);
    }
    return repaired;
  }

  #insertTask(runId, task, options = {}) {
    if (this.tasks.has(task.taskId)) return null;
    const row = {
      task_id: task.taskId,
      run_id: runId,
      agent_id: task.agentId,
      role: task.role,
      status: "routed",
      attempt: 0,
      max_attempts: options.maxAttempts ?? 3,
      dependencies_json: JSON.stringify(task.dependencies ?? []),
      owned_paths_json: JSON.stringify(task.ownedPaths ?? []),
      reasoning_level: task.reasoningLevel ?? null,
      reasoning_source: options.reasoningSource ?? null,
      state_version: 0,
      activity_version: 0,
    };
    this.tasks.set(task.taskId, row);
    return clone(row);
  }

  addTasks(runId, tasks, options = {}) {
    const inserted = [];
    for (const task of tasks ?? []) {
      const row = this.#insertTask(runId, task, options);
      if (row) inserted.push(row);
    }
    if (inserted.length > 0) this.event(runId, null, "dag.tasks.materialized", { taskIds: inserted.map((task) => task.task_id) });
    return inserted;
  }

  replacePlan(runId, plan, options = {}) {
    const current = this.runs.get(runId);
    if (!current) throw new Error(`run_not_found:${runId}`);
    if (options.expectedVersion !== undefined && current.state_version !== options.expectedVersion) {
      const error = new Error(`agent_run_plan_version_conflict:${runId}:${options.expectedVersion}:${current.state_version}`);
      error.code = "agent_run_plan_version_conflict";
      throw error;
    }
    current.plan_json = JSON.stringify(plan);
    current.state_version += 1;
    this.event(runId, null, "dag.plan.replaced", { phase: plan.phase, taskCount: plan.tasks.length });
    return clone(current);
  }

  applyBootstrapPlanRefinement(runId, plan, options = {}) {
    const runSnapshot = clone(this.runs.get(runId));
    const taskSnapshot = new Map([...this.tasks.entries()].map(([key, value]) => [key, clone(value)]));
    const eventLength = this.events.length;
    const eventSequence = this.eventSequence;
    try {
      const current = this.runs.get(runId);
      if (!current) throw new Error(`run_not_found:${runId}`);
      if (options.expectedVersion !== undefined && current.state_version !== options.expectedVersion) {
        const error = new Error(`agent_run_plan_version_conflict:${runId}:${options.expectedVersion}:${current.state_version}`);
        error.code = "agent_run_plan_version_conflict";
        throw error;
      }
      for (const taskId of options.removedTaskIds ?? []) {
        const task = this.tasks.get(taskId);
        if (!task || task.run_id !== runId) throw new Error(`bootstrap_refinement_task_missing:${taskId}`);
        const hasArtifact = this.artifacts ? [...this.artifacts.values()].some((artifact) => artifact.run_id === runId && artifact.task_id === taskId) : false;
        const hasResult = this.executionResults ? [...this.executionResults.values()].some((result) => result.run_id === runId && result.task_id === taskId) : false;
        if (!["routed", "retrying"].includes(task.status) || Number(task.attempt ?? 0) !== 0 || task.workspace_path || hasArtifact || hasResult) {
          throw new Error(`bootstrap_refinement_task_removal_unsafe:${taskId}:${task.status}`);
        }
        this.tasks.delete(taskId);
      }
      for (const update of options.dependencyUpdates ?? []) {
        const task = this.tasks.get(update.taskId);
        if (!task || task.run_id !== runId) throw new Error(`bootstrap_refinement_task_missing:${update.taskId}`);
        if (!["routed", "retrying"].includes(task.status)) {
          throw new Error(`bootstrap_refinement_task_already_started:${update.taskId}:${task.status}`);
        }
        task.dependencies_json = JSON.stringify(update.dependencies ?? []);
        task.state_version += 1;
      }
      for (const task of options.addedTasks ?? []) this.#insertTask(runId, task, options);
      current.plan_json = JSON.stringify(plan);
      current.state_version += 1;
      this.event(runId, null, "dag.bootstrap_refined", {
        topologyRevision: plan.workflow?.bootstrapTopologyRevision ?? null,
        authority: plan.workflow?.bootstrapTopologyAuthority ?? null,
        addedTaskIds: (options.addedTasks ?? []).map((task) => task.taskId),
        removedTaskIds: clone(options.removedTaskIds ?? []),
        dependencyUpdates: clone(options.dependencyUpdates ?? []),
      });
      return clone(current);
    } catch (error) {
      if (runSnapshot) this.runs.set(runId, runSnapshot);
      else this.runs.delete(runId);
      this.tasks = taskSnapshot;
      this.events.length = eventLength;
      this.eventSequence = eventSequence;
      throw error;
    }
  }

  getRun(runId) { return clone(this.runs.get(runId) ?? null); }
  getTask(taskId) { return clone(this.tasks.get(taskId) ?? null); }
  listTasks(runId) { return [...this.tasks.values()].filter((task) => task.run_id === runId).map(clone); }
  listRuns(limit = 100) {
    return [...this.runs.values()]
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .slice(0, limit)
      .map(clone);
  }
  listRunnableRuns(limit = 100) { return this.listRuns(limit).filter((run) => isActiveRunStatus(run.status)); }
  notifyRuntimeWakeup() { return undefined; }

  updateRun(runId, patch, options = {}) {
    const current = this.runs.get(runId);
    if (!current) return null;
    if (options.expectedVersion !== undefined && current.state_version !== options.expectedVersion) {
      const error = new Error(`agent_run_version_conflict:${runId}:${options.expectedVersion}:${current.state_version}`);
      error.code = "agent_run_version_conflict";
      throw error;
    }
    assertTerminalRunPatch(current, patch);
    Object.assign(current, patch);
    current.state_version += 1;
    return clone(current);
  }

  updateTask(taskId, patch, options = {}) {
    const current = this.tasks.get(taskId);
    if (!current) return null;
    if (options.expectedVersion !== undefined && current.state_version !== options.expectedVersion) {
      const error = new Error(`agent_task_version_conflict:${taskId}:${options.expectedVersion}:${current.state_version}`);
      error.code = "agent_task_version_conflict";
      throw error;
    }
    Object.assign(current, patch);
    current.state_version += 1;
    return clone(current);
  }

  touchTask(taskId) {
    const current = this.tasks.get(taskId);
    if (!current) return null;
    current.activity_version = (current.activity_version ?? 0) + 1;
    current.state_version += 1;
    return clone(current);
  }

  event(runId, taskId, eventType, payload = {}) {
    const row = {
      event_id: newId("event"),
      event_sequence: ++this.eventSequence,
      run_id: runId,
      task_id: taskId ?? null,
      event_type: eventType,
      payload_json: JSON.stringify(payload),
      created_at: nowIso(),
    };
    this.events.push(row);
    return clone(row);
  }

  eventOnce(runId, taskId, eventType, payload = {}, effectKey = payload?.effectKey ?? null) {
    if (!effectKey) return this.event(runId, taskId, eventType, payload);
    const eventId = `event-effect-${sha256(Buffer.from(String(effectKey))).slice(0, 40)}`;
    const existing = this.events.find((event) => event.event_id === eventId);
    if (existing) return { inserted: false, eventId, row: clone(existing) };
    const row = {
      event_id: eventId,
      event_sequence: ++this.eventSequence,
      run_id: runId,
      task_id: taskId ?? null,
      event_type: eventType,
      payload_json: JSON.stringify({ ...payload, effectKey }),
      created_at: nowIso(),
    };
    this.events.push(row);
    return { inserted: true, eventId, row: clone(row) };
  }

  listEvents(runId) {
    return clone(this.events.filter((event) => event.run_id === runId));
  }

  async hasProgressNotificationReceipt(sourceEventId) {
    const { progressReceiptEventId } = await import("./progress.mjs");
    const receiptId = progressReceiptEventId(sourceEventId);
    return this.events.some((event) => event.event_id === receiptId);
  }

  async recordProgressNotificationReceipt(sourceEvent, metadata = {}) {
    const { progressReceiptEventId } = await import("./progress.mjs");
    const eventId = progressReceiptEventId(sourceEvent.event_id);
    if (this.events.some((event) => event.event_id === eventId)) return false;
    this.events.push({
      event_id: eventId,
      event_sequence: ++this.eventSequence,
      run_id: sourceEvent.run_id,
      task_id: sourceEvent.task_id ?? null,
      event_type: "progress.notification.sent",
      payload_json: JSON.stringify({
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
      }),
      created_at: nowIso(),
    });
    return true;
  }

  latestEvent(runId) {
    const rows = this.events.filter((event) => event.run_id === runId);
    return clone(rows.at(-1) ?? null);
  }
}
