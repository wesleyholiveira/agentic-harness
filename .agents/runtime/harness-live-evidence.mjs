function eventType(event) {
  return String(event?.event_type ?? event?.eventType ?? event?.type ?? "").trim();
}

function eventTaskId(event) {
  return event?.task_id ?? event?.taskId ?? null;
}

function eventPayload(event) {
  const direct = event?.payload;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  const raw = event?.payload_json ?? event?.payloadJson ?? null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function eventsOf(capsule, type) {
  return (capsule?.evidence?.events ?? []).filter((event) => eventType(event) === type);
}

function eventOrder(event, fallback) {
  const sequence = Number(event?.event_sequence ?? event?.eventSequence);
  if (Number.isFinite(sequence)) return sequence;
  const createdAt = Date.parse(event?.created_at ?? event?.createdAt ?? "");
  return Number.isFinite(createdAt) ? createdAt : fallback;
}

function orderedEvents(capsule) {
  return (capsule?.evidence?.events ?? [])
    .map((event, index) => ({ event, order: eventOrder(event, index), payload: eventPayload(event) }))
    .sort((left, right) => left.order - right.order);
}

function policyOperations(capsule) {
  return [...new Set(eventsOf(capsule, "policy.decision")
    .map((event) => String(eventPayload(event).operation ?? eventPayload(event).action ?? "").trim())
    .filter(Boolean))].sort();
}

function policyDecisions(capsule) {
  return eventsOf(capsule, "policy.decision")
    .map((event) => {
      const payload = eventPayload(event);
      return {
        operation: String(payload.operation ?? payload.action ?? "").trim() || null,
        allowed: typeof payload.allowed === "boolean" ? payload.allowed : null,
        effect: payload.effect ?? null,
        code: payload.code ?? null,
      };
    })
    .filter((item) => item.operation);
}

function hasNonNegativeTiming(payload, name) {
  return Number.isFinite(Number(payload?.[name])) && Number(payload[name]) >= 0;
}

function topologyOf(capsule) {
  const topology = capsule?.refinedBootstrap?.topology;
  return topology && typeof topology === "object" && !Array.isArray(topology) ? topology : null;
}

function integrationDecisionArtifact(capsule) {
  return (capsule?.evidence?.artifacts ?? [])
    .find((artifact) => artifact?.kind === "integration-decision" && artifact?.version === "v2") ?? null;
}

/**
 * Machine-checkable persisted-evidence acceptance for the canonical H-9 harness
 * qualification. It proves durable Runtime evidence plus the attached-TUI
 * projector's own correlated `progress.live_delivery_observed` receipts. Human
 * visual inspection is corroborative per ADR 0087. The outer qualification
 * controller still owns the exactly-once post-wake `agent_summary` procedure.
 */
export function evaluateHarnessLiveEvidence(capsule, options = {}) {
  const violations = [];
  const runId = String(capsule?.runId ?? "").trim();
  if (capsule?.contractVersion !== "agent-runtime-replay-capsule/v1") violations.push("live_replay_capsule_version_invalid");
  if (!runId) violations.push("live_run_id_missing");

  const provisionalStages = (capsule?.plan?.tasks ?? []).map((task) => task?.stage).filter(Boolean);
  if (capsule?.plan?.workflow?.bootstrapTopologyState !== "provisional") violations.push("live_initial_bootstrap_not_provisional");
  if (JSON.stringify(provisionalStages) !== JSON.stringify(["product-discovery", "technical-refinement"])) {
    violations.push(`live_initial_bootstrap_tasks:${provisionalStages.join(",") || "missing"}`);
  }

  const assessment = capsule?.refinedBootstrap?.assessment ?? null;
  if (!assessment || assessment.contractVersion !== "bootstrap-review-assessment/v1") {
    violations.push("live_product_bootstrap_assessment_missing");
  }
  const capabilities = Array.isArray(assessment?.requiredCapabilities) ? assessment.requiredCapabilities : [];
  const uniqueCapabilities = [...new Set(capabilities)];
  if (uniqueCapabilities.length < 3) violations.push(`live_review_capability_count:${uniqueCapabilities.length}`);

  const crossReviewFacts = (assessment?.factRequirements ?? []).filter((item) =>
    item?.resolution === "review"
      && item?.providerCapabilityId
      && item?.consumerCapabilityId
      && item.providerCapabilityId !== item.consumerCapabilityId);
  if (crossReviewFacts.length === 0) violations.push("live_cross_review_fact_missing");
  if (!capsule?.refinedBootstrap?.planFingerprint) violations.push("live_refined_bootstrap_fingerprint_missing");
  if (!capsule?.compiled?.planFingerprint) violations.push("live_compiled_plan_fingerprint_missing");
  if (!capsule?.provenance?.policyFingerprint) violations.push("live_policy_fingerprint_missing");

  const topology = topologyOf(capsule);
  if (!topology) {
    violations.push("live_refined_bootstrap_topology_missing");
  } else {
    const selectedStages = Array.isArray(topology.selectedReviewStages) ? topology.selectedReviewStages : [];
    const factBindings = Array.isArray(topology.bootstrapFactBindings) ? topology.bootstrapFactBindings : [];
    const reviewEdges = Array.isArray(topology.bootstrapReviewDependencies) ? topology.bootstrapReviewDependencies : [];
    if (selectedStages.length < 3) violations.push(`live_selected_review_stage_count:${selectedStages.length}`);
    for (const fact of crossReviewFacts) {
      if (!factBindings.some((binding) =>
        binding?.factId === fact.factId
          && binding?.consumerCapabilityId === fact.consumerCapabilityId
          && binding?.providerCapabilityId === fact.providerCapabilityId
          && binding?.status === "unresolved-review-input")) {
        violations.push(`live_fact_binding_missing:${fact.factId}:${fact.providerCapabilityId}->${fact.consumerCapabilityId}`);
      }
    }
    const involvedStages = new Set(reviewEdges.flatMap((edge) => [edge?.fromStage, edge?.toStage]).filter(Boolean));
    if (reviewEdges.length === 0) violations.push("live_review_dependency_edge_missing");
    if (!selectedStages.some((stage) => !involvedStages.has(stage))) violations.push("live_independent_review_stage_missing");
    if (reviewEdges.some((edge) => !edge?.fromTaskId || !edge?.toTaskId || !edge?.factId)) {
      violations.push("live_review_dependency_edge_unmaterialized");
    }
  }

  const eventRows = orderedEvents(capsule);
  const byType = (type) => eventRows.filter((row) => eventType(row.event) === type);
  const durableRefinement = byType("dag.bootstrap_refined");
  const semanticRefinement = byType("bootstrap.topology.refined");
  if (durableRefinement.length !== 1) violations.push(`live_durable_bootstrap_refinement_count:${durableRefinement.length}`);
  if (semanticRefinement.length !== 1) violations.push(`live_semantic_bootstrap_refinement_count:${semanticRefinement.length}`);
  const addedTaskIds = new Set([...durableRefinement, ...semanticRefinement]
    .flatMap((row) => row.payload?.addedTaskIds ?? []));
  const lastRefinementOrder = [...durableRefinement, ...semanticRefinement]
    .reduce((max, row) => Math.max(max, row.order), Number.NEGATIVE_INFINITY);
  const firstReviewRunning = eventRows.find((row) => eventType(row.event) === "task.running" && addedTaskIds.has(eventTaskId(row.event))) ?? null;
  if (firstReviewRunning && !(lastRefinementOrder < firstReviewRunning.order)) {
    violations.push("live_review_dispatched_before_refinement_committed");
  }

  const operations = policyOperations(capsule);
  for (const required of ["plan", "dispatch", "compile", "promotion"]) {
    if (!operations.includes(required)) violations.push(`live_policy_operation_missing:${required}`);
  }
  if (eventsOf(capsule, "model.route.selected").length === 0) violations.push("live_model_route_event_missing");

  const compiledEvents = eventsOf(capsule, "dag.compiled");
  if (!compiledEvents.some((event) => {
    const payload = eventPayload(event);
    return hasNonNegativeTiming(payload, "compileDurationMs")
      && hasNonNegativeTiming(payload, "materializationDurationMs");
  })) violations.push("live_dag_compile_timing_missing");

  const liveObservations = eventsOf(capsule, "progress.live_delivery_observed");
  if (liveObservations.length === 0) violations.push("live_progress_observation_missing");
  const liveProjectorInstanceIds = new Set();
  const liveProjectorSessionIds = new Set();
  for (const event of liveObservations) {
    const payload = eventPayload(event);
    const instanceId = String(payload.instanceId ?? "").trim();
    const sessionId = String(payload.sessionId ?? "").trim();
    if (!instanceId || !sessionId) {
      violations.push(`live_progress_observation_projector_identity_missing:${String(payload.messageId ?? "missing")}`);
      continue;
    }
    liveProjectorInstanceIds.add(instanceId);
    liveProjectorSessionIds.add(sessionId);
  }
  if (liveProjectorInstanceIds.size > 1) violations.push(`live_progress_projector_instance_changed:${liveProjectorInstanceIds.size}`);
  if (liveProjectorSessionIds.size > 1) violations.push(`live_progress_projector_session_changed:${liveProjectorSessionIds.size}`);
  const expectedProjectorInstanceId = String(options?.expectedProjectorInstanceId ?? "").trim();
  const expectedProjectorSessionId = String(options?.expectedProjectorSessionId ?? "").trim();
  if (expectedProjectorInstanceId && !liveProjectorInstanceIds.has(expectedProjectorInstanceId)) {
    violations.push(`live_progress_projector_instance_mismatch:${expectedProjectorInstanceId}`);
  }
  if (expectedProjectorSessionId && !liveProjectorSessionIds.has(expectedProjectorSessionId)) {
    violations.push(`live_progress_projector_session_mismatch:${expectedProjectorSessionId}`);
  }
  const checkpointEvents = [
    ...eventsOf(capsule, "progress.checkpoint_committed"),
    ...eventsOf(capsule, "progress.session_checkpoint_committed"),
  ];
  const checkpointMessageIds = new Set(checkpointEvents.map((event) => eventPayload(event).messageId).filter(Boolean));
  const checkpointEffectKeysByMessage = new Map();
  for (const event of checkpointEvents) {
    const payload = eventPayload(event);
    const messageId = String(payload.messageId ?? "").trim();
    const effectKey = String(payload.effectKey ?? "").trim();
    if (messageId && effectKey) checkpointEffectKeysByMessage.set(messageId, effectKey);
  }
  const liveMessageIds = new Set(liveObservations.map((event) => eventPayload(event).messageId).filter(Boolean));
  if (checkpointEvents.length === 0 || checkpointMessageIds.size === 0) violations.push("live_progress_checkpoint_missing");
  if (checkpointMessageIds.size > 0 && ![...checkpointMessageIds].some((id) => liveMessageIds.has(id))) {
    violations.push("live_progress_message_correlation_missing");
  }
  for (const event of checkpointEvents) {
    const payload = eventPayload(event);
    if (payload.authoritative !== false || payload.presentationOnly !== true) {
      violations.push(`live_progress_checkpoint_authority_invalid:${payload.messageId ?? "missing"}`);
    }
    if (!String(payload.effectKey ?? "").trim()) violations.push(`live_progress_checkpoint_effect_key_missing:${payload.messageId ?? "missing"}`);
  }
  for (const event of liveObservations) {
    const payload = eventPayload(event);
    const messageId = String(payload.messageId ?? "").trim();
    if (payload.authoritative !== false || payload.presentationOnly !== true) {
      violations.push(`live_progress_observation_authority_invalid:${payload.messageId ?? "missing"}`);
    }
    if (!String(payload.effectKey ?? "").trim()) violations.push(`live_progress_observation_effect_key_missing:${payload.messageId ?? "missing"}`);
    const expectedCheckpointEffectKey = checkpointEffectKeysByMessage.get(messageId) ?? null;
    if (expectedCheckpointEffectKey && String(payload.checkpointEffectKey ?? "").trim() !== expectedCheckpointEffectKey) {
      violations.push(`live_progress_checkpoint_effect_correlation_missing:${messageId || "missing"}`);
    }
  }
  const parkedObservationDenied = eventsOf(capsule, "orchestrator.parked_observation_denied");
  const parkedAutonomousObservationAttempts = parkedObservationDenied.filter((event) => eventPayload(event).invocationOrigin === "autonomous-assistant");
  const parkedUnknownObservationAttempts = parkedObservationDenied.filter((event) => {
    const origin = String(eventPayload(event).invocationOrigin ?? "").trim();
    return !origin || origin === "unknown";
  });
  const parkedHumanObservations = eventsOf(capsule, "orchestrator.parked_human_observation_allowed");
  if (parkedAutonomousObservationAttempts.length > 0) {
    violations.push(`live_main_orchestrator_parked_observation_attempts:${parkedAutonomousObservationAttempts.length}`);
  }
  if (parkedUnknownObservationAttempts.length > 0) {
    violations.push(`live_main_orchestrator_parked_observation_provenance_missing:${parkedUnknownObservationAttempts.length}`);
  }

  const repairStarted = eventsOf(capsule, "repair.started");
  const repairCompleted = eventsOf(capsule, "repair.completed");
  const repairExhausted = eventsOf(capsule, "repair.exhausted");
  const repairFailed = eventsOf(capsule, "repair.failed");
  const trueRetries = eventsOf(capsule, "retry.true_scheduled");
  const retryBackoffs = eventsOf(capsule, "retry.backoff_applied");
  const avoidedFullRetries = eventsOf(capsule, "retry.full_attempt_avoided");
  const executionResults = eventsOf(capsule, "execution.result.received");
  const idempotentRepairEvents = [...repairStarted, ...repairCompleted, ...repairExhausted, ...repairFailed, ...avoidedFullRetries];
  const repairEffectOccurrences = new Map();
  for (const event of idempotentRepairEvents) {
    const payload = eventPayload(event);
    const effectKey = String(payload.effectKey ?? "").trim();
    const taskId = eventTaskId(event) ?? "unknown";
    if (!effectKey) {
      violations.push(`live_repair_effect_key_missing:${eventType(event)}:${taskId}`);
      continue;
    }
    const observed = repairEffectOccurrences.get(effectKey) ?? [];
    observed.push(event);
    repairEffectOccurrences.set(effectKey, observed);
  }
  for (const [effectKey, effectEvents] of repairEffectOccurrences.entries()) {
    if (effectEvents.length > 1) violations.push(`live_duplicate_repair_effect:${effectKey}:${effectEvents.length}`);
  }
  const uniqueRepairEffectCount = (events) => new Set(events.map((event) => String(eventPayload(event).effectKey ?? "")).filter(Boolean)).size;
  for (const event of [...repairStarted, ...repairCompleted, ...repairExhausted, ...repairFailed]) {
    const payload = eventPayload(event);
    const taskId = eventTaskId(event) ?? "unknown";
    if (payload.sameTaskAttempt !== true) violations.push(`live_repair_consumed_task_attempt:${taskId}`);
    const taskAttempt = Number(payload.taskAttempt);
    if (!Number.isInteger(taskAttempt) || taskAttempt < 1) {
      violations.push(`live_repair_task_attempt_missing:${taskId}`);
      continue;
    }
    const matchingExecution = executionResults.find((candidate) => {
      if (eventTaskId(candidate) !== eventTaskId(event)) return false;
      const execution = eventPayload(candidate);
      return Number(execution.attempt) === taskAttempt;
    });
    if (!matchingExecution) {
      violations.push(`live_repair_execution_identity_missing:${taskId}:${taskAttempt}`);
      continue;
    }
    const execution = eventPayload(matchingExecution);
    if (Number(payload.dispatchGeneration) !== Number(execution.dispatchGeneration)
      || Number(payload.fencingToken) !== Number(execution.fencingToken)) {
      violations.push(`live_repair_execution_identity_mismatch:${taskId}:${taskAttempt}`);
    }
  }
  for (const event of avoidedFullRetries) {
    const payload = eventPayload(event);
    if (payload.estimateClass !== "counterfactual") violations.push(`live_avoided_retry_estimate_class_invalid:${eventTaskId(event) ?? "unknown"}`);
    if (!Number.isFinite(Number(payload.estimatedAvoidedMs)) || Number(payload.estimatedAvoidedMs) < 0) {
      violations.push(`live_avoided_retry_estimate_invalid:${eventTaskId(event) ?? "unknown"}`);
    }
  }
  for (const event of trueRetries) {
    const payload = eventPayload(event);
    if (payload.retryDisposition === "true-retry-repair-exhausted" && Number(payload.retryAfterMs ?? 0) > 0) {
      violations.push(`live_repair_exhausted_retry_backoff:${eventTaskId(event) ?? "unknown"}:${payload.retryAfterMs}`);
    }
    if (payload.retryDisposition === "true-retry-repair-exhausted") {
      const retryTaskId = eventTaskId(event);
      const retryAttempt = Number(payload.attempt);
      const provenExhaustion = repairExhausted.some((repairEvent) => {
        const repairPayload = eventPayload(repairEvent);
        return eventTaskId(repairEvent) === retryTaskId
          && Number(repairPayload.taskAttempt) === retryAttempt;
      });
      if (!provenExhaustion) violations.push(`live_true_retry_repair_exhaustion_unproven:${retryTaskId ?? "unknown"}:${retryAttempt}`);
    }
  }
  for (const event of retryBackoffs) {
    const payload = eventPayload(event);
    if (payload.retryDisposition === "true-retry-repair-exhausted") {
      violations.push(`live_contract_repair_backoff_applied:${eventTaskId(event) ?? "unknown"}`);
    }
  }

  const terminal = capsule?.terminal ?? null;
  const productAcceptanceTaskId = terminal?.productAcceptanceTaskId ?? null;
  if (terminal?.status !== "closed") violations.push(`live_terminal_status:${terminal?.status ?? "missing"}`);
  if (!terminal?.finalPlanFingerprint) violations.push("live_terminal_plan_fingerprint_missing");
  if (!terminal?.integrationDecisionSha256) violations.push("live_integration_decision_fingerprint_missing");
  if (!integrationDecisionArtifact(capsule)) violations.push("live_integration_decision_artifact_missing");
  if (!productAcceptanceTaskId) violations.push("live_product_acceptance_task_missing");
  else if (!eventsOf(capsule, "task.integrated").some((event) => eventTaskId(event) === productAcceptanceTaskId)) {
    violations.push("live_product_acceptance_integration_missing");
  }

  const continuationWakes = eventsOf(capsule, "continuation.wake_materialized");
  if (continuationWakes.length !== 1) violations.push(`live_terminal_continuation_wake_count:${continuationWakes.length}`);
  if (terminal?.continuationEvidenceCaptured !== true) violations.push("live_terminal_continuation_evidence_not_captured");
  if (!terminal?.continuationDeliveryId || !terminal?.continuationEffectKey || !Number.isFinite(Number(terminal?.continuationGeneration))) {
    violations.push("live_terminal_continuation_identity_missing");
  } else if (continuationWakes.length === 1) {
    const wake = eventPayload(continuationWakes[0]);
    if (wake.deliveryId !== terminal.continuationDeliveryId || wake.effectKey !== terminal.continuationEffectKey
      || Number(wake.generation) !== Number(terminal.continuationGeneration)) {
      violations.push("live_terminal_continuation_identity_mismatch");
    }
  }

  return {
    contractVersion: "agent-runtime-harness-live-evidence/v1",
    ok: violations.length === 0,
    runId: runId || null,
    violations,
    observed: {
      requiredCapabilities: uniqueCapabilities.sort(),
      crossReviewFacts: crossReviewFacts.map((item) => ({
        factId: item.factId ?? null,
        providerCapabilityId: item.providerCapabilityId,
        consumerCapabilityId: item.consumerCapabilityId,
      })),
      selectedReviewStages: topology?.selectedReviewStages ?? [],
      reviewDependencyEdges: topology?.bootstrapReviewDependencies ?? [],
      policyOperations: operations,
      policyDecisions: policyDecisions(capsule),
      durableBootstrapRefinementEvents: durableRefinement.length,
      semanticBootstrapRefinementEvents: semanticRefinement.length,
      compiledEvents: compiledEvents.length,
      liveProgressObservations: liveObservations.length,
      liveProjectorInstanceIds: [...liveProjectorInstanceIds].sort(),
      liveProjectorSessionIds: [...liveProjectorSessionIds].sort(),
      correlatedLiveProgressMessages: [...checkpointMessageIds].filter((id) => liveMessageIds.has(id)).length,
      parkedObservationAttempts: parkedAutonomousObservationAttempts.length,
      parkedObservationProvenanceMissing: parkedUnknownObservationAttempts.length,
      parkedHumanObservations: parkedHumanObservations.length,
      repairStarted: uniqueRepairEffectCount(repairStarted),
      repairCompleted: uniqueRepairEffectCount(repairCompleted),
      repairExhausted: uniqueRepairEffectCount(repairExhausted),
      repairFailed: uniqueRepairEffectCount(repairFailed),
      duplicateRepairEffects: [...repairEffectOccurrences.values()].filter((events) => events.length > 1).length,
      trueRetries: trueRetries.length,
      retryBackoffs: retryBackoffs.length,
      avoidedFullRetries: uniqueRepairEffectCount(avoidedFullRetries),
      estimatedAvoidedMs: [...new Map(avoidedFullRetries.map((event) => [String(eventPayload(event).effectKey ?? event.event_id ?? ""), event])).values()]
        .reduce((sum, event) => sum + Math.max(0, Number(eventPayload(event).estimatedAvoidedMs ?? 0)), 0),
      terminalContinuationWakes: continuationWakes.length,
      terminalStatus: terminal?.status ?? null,
      productAcceptanceTaskId,
    },
  };
}
