import { summarizeRuntimePerformance } from "./performance.mjs";

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percent(numerator, denominator) {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

function parsePayload(event) {
  try {
    const parsed = JSON.parse(event?.payload_json ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function semanticMetrics(value) {
  const semantic = value && typeof value === "object" ? value : null;
  return {
    enabled: semantic?.enabled === true,
    status: semantic?.status ?? null,
    candidateHit: semantic?.candidate_hit === true,
    componentsReused: Array.isArray(semantic?.components_reused) ? semantic.components_reused.length : 0,
    retrievalCallsAvoided: number(semantic?.retrieval_calls_avoided),
    tokensAvoidedEstimate: number(semantic?.tokens_avoided_estimate),
  };
}

function contextMeasurement(event, task, runBudgetBytes) {
  const payload = parsePayload(event);
  const context = payload.contextEngineMetrics && typeof payload.contextEngineMetrics === "object"
    ? payload.contextEngineMetrics
    : null;
  const runtimeBudgetBytes = number(payload.runtimeBudgetBytes) || number(runBudgetBytes);
  const runtimeBudgetTokensEstimate = number(payload.runtimeBudgetTokensEstimate) || Math.ceil(runtimeBudgetBytes / 4);
  const packetEstimatedTokens = number(payload.packetEstimatedTokens) || number(task?.estimated_tokens);
  const semantic = semanticMetrics(context?.semanticCache);
  const attempt = Object.prototype.hasOwnProperty.call(payload, "attempt")
    ? number(payload.attempt)
    : (number(task?.attempt) || 1);
  return {
    attempt,
    runtimeBudgetBytes,
    runtimeBudgetTokensEstimate,
    packetEstimatedTokens,
    budgetHeadroomTokensEstimate: Math.max(0, runtimeBudgetTokensEstimate - packetEstimatedTokens),
    budgetOverflowTokensEstimate: Math.max(0, packetEstimatedTokens - runtimeBudgetTokensEstimate),
    contextEngine: context ? {
      budgetTokens: number(context.budgetTokens),
      rawTokens: number(context.rawTokens),
      deliveredTokens: number(context.deliveredTokens),
      observedDeliveryTokensSaved: number(context.tokensSaved),
      savingsPercent: number(context.savingsPercent),
      exactPackCacheHit: context.cacheHit === true,
      exactPackCacheTier: context.cacheTier ?? null,
      componentCacheHits: number(context.componentCache?.hits),
      componentCacheMisses: number(context.componentCache?.misses),
      semantic,
    } : null,
  };
}

function dedupeContextReadyEvents(events, taskById) {
  // A reconcile/replay can prepare the same semantic task attempt more than
  // once before execution is fenced. Only the latest context.ready for that
  // task attempt can represent the context ultimately delivered to the model.
  // Counting every durable row would inflate observed token savings. True
  // retries remain independent because `attempt` is part of the identity.
  const byAttempt = new Map();
  let duplicateCount = 0;
  for (const event of events) {
    const payload = parsePayload(event);
    const task = taskById.get(event.task_id);
    const attempt = Object.prototype.hasOwnProperty.call(payload, "attempt")
      ? (number(payload.attempt) || 1)
      : (number(task?.attempt) || 1);
    const key = `${event.task_id}:${attempt}`;
    if (byAttempt.has(key)) duplicateCount += 1;
    byAttempt.set(key, event);
  }
  return { events: [...byAttempt.values()], duplicateCount };
}

function sumContextMeasurements(measurements) {
  const requestedBudgetTokensEstimate = measurements.reduce((sum, item) => sum + item.runtimeBudgetTokensEstimate, 0);
  const packetEstimatedTokens = measurements.reduce((sum, item) => sum + item.packetEstimatedTokens, 0);
  const rawTokens = measurements.reduce((sum, item) => sum + number(item.contextEngine?.rawTokens), 0);
  const deliveredTokens = measurements.reduce((sum, item) => sum + number(item.contextEngine?.deliveredTokens), 0);
  const tokensSaved = measurements.reduce((sum, item) => sum + number(item.contextEngine?.observedDeliveryTokensSaved), 0);
  return {
    preparationCount: measurements.length,
    retryPreparationCount: measurements.filter((item) => item.attempt > 1).length,
    measuredCount: measurements.filter((item) => item.contextEngine !== null).length,
    requestedBudgetTokensEstimate,
    packetEstimatedTokens,
    budgetHeadroomTokensEstimate: Math.max(0, requestedBudgetTokensEstimate - packetEstimatedTokens),
    budgetOverflowTokensEstimate: Math.max(0, packetEstimatedTokens - requestedBudgetTokensEstimate),
    budgetUtilizationPercent: percent(packetEstimatedTokens, requestedBudgetTokensEstimate),
    rawTokens,
    deliveredTokens,
    observedDeliveryTokensSaved: tokensSaved,
    deliverySavingsPercent: percent(tokensSaved, rawTokens),
    exactPackHits: measurements.filter((item) => item.contextEngine?.exactPackCacheHit === true).length,
    exactPackL1Hits: measurements.filter((item) => item.contextEngine?.exactPackCacheTier === "l1").length,
    exactPackL2Hits: measurements.filter((item) => item.contextEngine?.exactPackCacheTier === "l2").length,
    componentCacheHits: measurements.reduce((sum, item) => sum + number(item.contextEngine?.componentCacheHits), 0),
    componentCacheMisses: measurements.reduce((sum, item) => sum + number(item.contextEngine?.componentCacheMisses), 0),
    semanticTokensAvoidedEstimate: measurements.reduce((sum, item) => sum + number(item.contextEngine?.semantic?.tokensAvoidedEstimate), 0),
    semanticRetrievalCallsAvoided: measurements.reduce((sum, item) => sum + number(item.contextEngine?.semantic?.retrievalCallsAvoided), 0),
    semanticComponentsReused: measurements.reduce((sum, item) => sum + number(item.contextEngine?.semantic?.componentsReused), 0),
  };
}


function agentInputManifestMeasurements(events) {
  const byAttempt = new Map();
  for (const event of events.filter((item) => item.event_type === "agent_input.manifest_ready" && item.task_id)) {
    const payload = parsePayload(event);
    const attempt = Math.max(1, number(payload.attempt));
    const accounting = payload.accounting && typeof payload.accounting === "object" ? payload.accounting : null;
    if (!accounting?.global) continue;
    byAttempt.set(`${event.task_id}:${attempt}`, {
      taskId: event.task_id,
      attempt,
      manifestFingerprint: payload.manifestFingerprint ?? null,
      accounting,
      inventory: Array.isArray(payload.inventory) ? payload.inventory : [],
    });
  }
  return [...byAttempt.values()];
}

export function summarizeRuntimeOwnedInput(manifests, receipts) {
  const categoryNames = ["task_contract", "schemas", "execution_contract", "retrieved_context", "upstream_evidence", "governance", "references", "tool_output"];
  const categories = {};
  for (const name of categoryNames) categories[name] = {
    rawTokens: 0, deliveredTokens: 0, savedTokens: 0, wireTokens: 0, duplicateTokens: 0,
    projectedTokens: 0, lazyAvailableTokens: 0, lazyDeliveryTokens: 0, entries: 0,
  };

  const allEntries = [];
  const artifactIndex = new Map();
  for (const manifest of manifests) {
    for (const entry of manifest.inventory ?? []) {
      const normalized = {
        taskId: manifest.taskId, attempt: manifest.attempt,
        category: entry.category, authorityClass: entry.authorityClass, deliveryMode: entry.deliveryMode,
        contentHash: entry.contentHash, estimatedTokens: number(entry.estimatedTokens), rawTokens: number(entry.rawTokens ?? entry.estimatedTokens),
        artifactRef: entry.artifactRef ?? null,
      };
      allEntries.push(normalized);
      if (normalized.artifactRef) artifactIndex.set(`${manifest.taskId}:${manifest.attempt}:${normalized.artifactRef}`, normalized);
      const category = categories[normalized.category] ?? categories.tool_output;
      const delivered = normalized.deliveryMode === "lazy" ? 0 : normalized.estimatedTokens;
      category.rawTokens += Math.max(normalized.rawTokens, normalized.estimatedTokens);
      category.deliveredTokens += delivered;
      category.savedTokens += Math.max(0, Math.max(normalized.rawTokens, normalized.estimatedTokens) - delivered);
      category.wireTokens += delivered;
      category.projectedTokens += normalized.authorityClass === "deterministic-projection" ? delivered : 0;
      category.lazyAvailableTokens += normalized.deliveryMode === "lazy" ? Math.max(normalized.rawTokens, normalized.estimatedTokens) : 0;
      category.entries += 1;
    }
  }

  // Compatibility for historical R16 events emitted before inventory was added.
  if (allEntries.length === 0) {
    for (const manifest of manifests) {
      for (const name of categoryNames) {
        const source = manifest.accounting?.categories?.[name] ?? {};
        for (const key of Object.keys(categories[name])) categories[name][key] += number(source[key]);
      }
    }
  }

  const rawByHash = new Map();
  const initialDeliveredByHash = new Map();
  let initialWireTokens = 0;
  for (const entry of allEntries) {
    const raw = Math.max(entry.rawTokens, entry.estimatedTokens);
    if (entry.contentHash) rawByHash.set(entry.contentHash, Math.max(rawByHash.get(entry.contentHash) ?? 0, raw));
    if (entry.deliveryMode !== "lazy") {
      initialWireTokens += entry.estimatedTokens;
      if (entry.contentHash) initialDeliveredByHash.set(entry.contentHash, Math.max(initialDeliveredByHash.get(entry.contentHash) ?? 0, entry.estimatedTokens));
    }
  }

  const receiptDeliveries = [];
  for (const receipt of receipts) {
    const tokens = number(receipt.estimated_tokens);
    const indexed = artifactIndex.get(`${receipt.task_id}:${Number(receipt.attempt)}:${receipt.artifact_ref}`) ?? null;
    const hash = receipt.content_sha256 ?? indexed?.contentHash ?? null;
    receiptDeliveries.push({ hash, tokens, category: indexed?.category ?? "references" });
    categories.tool_output.lazyDeliveryTokens += tokens;
  }
  const lazyWireTokens = receiptDeliveries.reduce((sum, item) => sum + item.tokens, 0);
  const lazyUniqueByHash = new Map();
  for (const item of receiptDeliveries) {
    if (!item.hash) continue;
    lazyUniqueByHash.set(item.hash, Math.max(lazyUniqueByHash.get(item.hash) ?? 0, item.tokens));
  }

  const runtimeOwnedRawTokens = rawByHash.size > 0
    ? [...rawByHash.values()].reduce((a, b) => a + b, 0)
    : manifests.reduce((sum, manifest) => sum + number(manifest.accounting?.global?.runtimeOwnedRawTokens), 0);
  const initialUniqueContentTokens = initialDeliveredByHash.size > 0
    ? [...initialDeliveredByHash.values()].reduce((a, b) => a + b, 0)
    : manifests.reduce((sum, manifest) => sum + number(manifest.accounting?.global?.uniqueContentTokens), 0);
  const initialWire = allEntries.length > 0
    ? initialWireTokens
    : manifests.reduce((sum, manifest) => sum + number(manifest.accounting?.global?.wireTokens), 0);
  const effectiveByHash = new Map(initialDeliveredByHash);
  for (const [hash, tokens] of lazyUniqueByHash) effectiveByHash.set(hash, Math.max(effectiveByHash.get(hash) ?? 0, tokens));
  const effectiveUnique = effectiveByHash.size > 0 ? [...effectiveByHash.values()].reduce((a, b) => a + b, 0) : initialUniqueContentTokens + [...lazyUniqueByHash.values()].reduce((a, b) => a + b, 0);
  const effectiveWire = initialWire + lazyWireTokens;
  const initialSaved = Math.max(0, runtimeOwnedRawTokens - initialUniqueContentTokens);
  const effectiveSaved = Math.max(0, runtimeOwnedRawTokens - effectiveUnique);

  return {
    manifestCount: manifests.length,
    semanticAttemptCount: manifests.length,
    initialDelivery: {
      categories,
      global: {
        runtimeOwnedRawTokens,
        runtimeOwnedDeliveredTokens: initialUniqueContentTokens,
        runtimeOwnedTokensSaved: initialSaved,
        runtimeOwnedSavingsPercent: percent(initialSaved, runtimeOwnedRawTokens),
        wireTokens: initialWire,
        uniqueContentTokens: initialUniqueContentTokens,
        duplicateTokens: Math.max(0, initialWire - initialUniqueContentTokens),
        duplicatePercent: percent(Math.max(0, initialWire - initialUniqueContentTokens), initialWire),
      },
    },
    lazyExpansion: {
      deliveryCount: receipts.length,
      uniqueArtifactDeliveries: lazyUniqueByHash.size,
      wireTokens: lazyWireTokens,
      uniqueDeliveredTokens: [...lazyUniqueByHash.values()].reduce((a, b) => a + b, 0),
      duplicateDeliveryTokens: Math.max(0, lazyWireTokens - [...lazyUniqueByHash.values()].reduce((a, b) => a + b, 0)),
      note: "Lazy expansion is observed separately from initial manifest delivery and is not added to provider usage.",
    },
    effectiveDelivery: {
      runtimeOwnedRawTokens,
      runtimeOwnedDeliveredTokens: effectiveUnique,
      runtimeOwnedTokensSaved: effectiveSaved,
      runtimeOwnedSavingsPercent: percent(effectiveSaved, runtimeOwnedRawTokens),
      wireTokens: effectiveWire,
      uniqueContentTokens: effectiveUnique,
      duplicateTokens: Math.max(0, effectiveWire - effectiveUnique),
      duplicatePercent: percent(Math.max(0, effectiveWire - effectiveUnique), effectiveWire),
      providerUsageAdditive: false,
    },
  };
}

function modelUsageEvents(events) {
  return events.filter((event) => event.event_type === "model.usage.observed").map((event) => ({
    taskId: event.task_id,
    ...parsePayload(event),
  }));
}

const MODEL_USAGE_TERMINAL_TASK_STATUSES = new Set(["integrated", "verified", "failed", "blocked", "cancelled"]);

function taskRowHasUsage(task) {
  return [
    task?.input_tokens,
    task?.cached_input_tokens,
    task?.output_tokens,
    task?.cost_usd,
    task?.steps_used,
  ].some((value) => number(value) > 0);
}

function taskRowFallbackMeasurement(task) {
  return {
    taskId: task.task_id,
    attempt: number(task.attempt) || 1,
    inputTokens: task.input_tokens,
    cachedInputTokens: task.cached_input_tokens,
    outputTokens: task.output_tokens,
    costUsd: task.cost_usd,
    stepsLimit: task.steps_limit,
    stepsUsed: task.steps_used,
    auxiliaryInvocationCount: 0,
    provenance: "task-row-fallback",
  };
}

function summarizeModelUsage(tasks, usageEvents, deterministicReuseEvents = []) {
  const observed = usageEvents.map((usage) => ({ ...usage, provenance: "attempt-event" }));
  const observedKeys = new Set(observed.map((item) => `${item.taskId}:${number(item.attempt) || 1}`));
  const deterministicKeys = new Set(deterministicReuseEvents.map((event) => {
    const value = parsePayload(event);
    return `${event.task_id}:${number(value.attempt) || 1}`;
  }));
  const fallback = [];
  let missingPriorRetryAttempts = 0;
  let missingTerminalAttempts = 0;
  let pendingCurrentAttempts = 0;

  for (const task of tasks) {
    const currentAttempt = Math.max(0, number(task.attempt));
    const terminal = MODEL_USAGE_TERMINAL_TASK_STATUSES.has(task.status);
    if (!terminal) {
      if (currentAttempt > 0 && !observedKeys.has(`${task.task_id}:${currentAttempt}`)) pendingCurrentAttempts += 1;
      continue;
    }

    for (let attempt = 1; attempt < currentAttempt; attempt += 1) {
      if (!observedKeys.has(`${task.task_id}:${attempt}`) && !deterministicKeys.has(`${task.task_id}:${attempt}`)) missingPriorRetryAttempts += 1;
    }

    if (currentAttempt <= 0 || observedKeys.has(`${task.task_id}:${currentAttempt}`) || deterministicKeys.has(`${task.task_id}:${currentAttempt}`)) continue;
    if (taskRowHasUsage(task)) fallback.push(taskRowFallbackMeasurement(task));
    else missingTerminalAttempts += 1;
  }

  const source = [...observed, ...fallback];
  let provenance = "pending-observation";
  if (observed.length > 0 && fallback.length === 0 && missingPriorRetryAttempts === 0 && missingTerminalAttempts === 0) provenance = "observed";
  else if (observed.length > 0) provenance = "mixed";
  else if (fallback.length > 0) provenance = "estimated";
  else if (missingPriorRetryAttempts > 0 || missingTerminalAttempts > 0) provenance = "incomplete";

  const totals = {
    source: provenance,
    quality: provenance,
    attemptMeasurements: source.length,
    observedAttemptMeasurements: observed.length,
    fallbackAttemptMeasurements: fallback.length,
    pendingCurrentAttempts,
    missingPriorRetryAttempts,
    missingTerminalAttempts,
    inputTokens: source.reduce((sum, item) => sum + number(item.inputTokens), 0),
    cachedInputTokens: source.reduce((sum, item) => sum + number(item.cachedInputTokens), 0),
    outputTokens: source.reduce((sum, item) => sum + number(item.outputTokens), 0),
    costUsd: source.reduce((sum, item) => sum + number(item.costUsd), 0),
    stepBudget: source.reduce((sum, item) => sum + number(item.stepsLimit), 0),
    stepsUsed: source.reduce((sum, item) => sum + number(item.stepsUsed), 0),
    auxiliaryInvocationCount: source.reduce((sum, item) => sum + number(item.auxiliaryInvocationCount), 0),
    retry: {
      attemptMeasurements: source.filter((item) => number(item.attempt) > 1).length,
      observedAttemptMeasurements: observed.filter((item) => number(item.attempt) > 1).length,
      fallbackAttemptMeasurements: fallback.filter((item) => number(item.attempt) > 1).length,
      inputTokens: source.filter((item) => number(item.attempt) > 1).reduce((sum, item) => sum + number(item.inputTokens), 0),
      cachedInputTokens: source.filter((item) => number(item.attempt) > 1).reduce((sum, item) => sum + number(item.cachedInputTokens), 0),
      outputTokens: source.filter((item) => number(item.attempt) > 1).reduce((sum, item) => sum + number(item.outputTokens), 0),
      costUsd: source.filter((item) => number(item.attempt) > 1).reduce((sum, item) => sum + number(item.costUsd), 0),
    },
  };
  return { ...totals, stepBudgetUtilizationPercent: percent(totals.stepsUsed, totals.stepBudget) };
}

export async function buildEfficiencyReport(store, runId) {
  if (!runId) throw new Error("efficiency_run_id_required");
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run_not_found:${runId}`);
  const [tasks, events, inputArtifactReceipts] = await Promise.all([
    store.listTasks(runId),
    store.listEvents(runId),
    typeof store.listAgentInputArtifactReceipts === "function" ? store.listAgentInputArtifactReceipts(runId) : Promise.resolve([]),
  ]);
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const rawContextEvents = events.filter((event) => event.event_type === "context.ready" && event.task_id);
  const contextReady = dedupeContextReadyEvents(rawContextEvents, taskById);
  const contextEvents = contextReady.events;
  const prefetchEvents = events.filter((event) => event.event_type === "task.prefetch.ready" && event.task_id);
  const allMeasurements = contextEvents.map((event) => contextMeasurement(event, taskById.get(event.task_id), run.context_budget_bytes));
  const prefetchMeasurements = prefetchEvents.map((event) => contextMeasurement(event, taskById.get(event.task_id), run.context_budget_bytes));
  const contextTotals = sumContextMeasurements(allMeasurements);
  const prefetchTotals = sumContextMeasurements(prefetchMeasurements);
  const usageEvents = modelUsageEvents(events);
  const deterministicReuseEvents = events.filter((event) => event.event_type === "execution.deterministic_reuse.observed" && event.task_id);
  const model = summarizeModelUsage(tasks, usageEvents, deterministicReuseEvents);
  const runtimeOwnedInput = summarizeRuntimeOwnedInput(agentInputManifestMeasurements(events), inputArtifactReceipts);
  const performance = summarizeRuntimePerformance({ run, tasks, events });
  const taskDurationMs = tasks.reduce((sum, task) => sum + number(task.duration_ms), 0);
  const wallMs = run.started_at && run.completed_at
    ? Math.max(0, Date.parse(run.completed_at) - Date.parse(run.started_at))
    : 0;

  const measurementsByTask = new Map();
  for (const event of contextEvents) {
    const list = measurementsByTask.get(event.task_id) ?? [];
    list.push(contextMeasurement(event, taskById.get(event.task_id), run.context_budget_bytes));
    measurementsByTask.set(event.task_id, list);
  }
  const usageByTask = new Map();
  for (const usage of usageEvents) {
    const list = usageByTask.get(usage.taskId) ?? [];
    list.push(usage);
    usageByTask.set(usage.taskId, list);
  }
  const taskReports = tasks.map((task) => {
    const context = measurementsByTask.get(task.task_id) ?? [];
    const taskContext = sumContextMeasurements(context);
    const modelEvents = usageByTask.get(task.task_id) ?? [];
    return {
      taskId: task.task_id,
      agentId: task.agent_id,
      status: task.status,
      currentAttempt: number(task.attempt),
      context: taskContext,
      modelAttemptMeasurements: modelEvents,
    };
  });

  const warnings = [];
  if (contextTotals.measuredCount < contextTotals.preparationCount) {
    warnings.push(`context_efficiency_measurement_partial:${contextTotals.measuredCount}/${contextTotals.preparationCount}:context_preparations_without_context_engine_metrics`);
  }
  if (contextTotals.preparationCount === 0 && tasks.length > 0) {
    warnings.push("context_efficiency_context_ready_events_unavailable:run_predates_efficiency_v1_or_context_not_prepared_yet");
  }
  if (contextReady.duplicateCount > 0) {
    warnings.push(`context_efficiency_duplicate_context_ready_ignored:${contextReady.duplicateCount}:latest_semantic_task_attempt_wins`);
  }
  if (model.fallbackAttemptMeasurements > 0) {
    warnings.push(`context_efficiency_model_usage_fallback:${model.fallbackAttemptMeasurements}:terminal_attempts_using_task_row_estimates`);
  }
  if (model.missingPriorRetryAttempts > 0) {
    warnings.push(`context_efficiency_model_usage_retry_history_incomplete:${model.missingPriorRetryAttempts}:prior_attempts_not_reconstructible_from_task_rows`);
  }
  if (model.missingTerminalAttempts > 0) {
    warnings.push(`context_efficiency_model_usage_missing_terminal:${model.missingTerminalAttempts}:terminal_attempts_without_observed_or_fallback_usage`);
  }

  return {
    contractVersion: "runtime-efficiency/v1",
    generatedAt: new Date().toISOString(),
    runId,
    runStatus: run.status,
    accountingPolicy: {
      grandTotalTokensSaved: null,
      reason: "Runtime-owned input savings are exact for the controlled manifest boundary but remain non-additive with provider usage, semantic retrieval estimates, provider cache reads and budget headroom.",
      observed: "Directly measured runtime/model/context values.",
      estimated: "Source-specific estimate whose counterfactual is not directly observed.",
      counterfactual: "Upper-bound comparison against configured budget; not a claim of model tokens actually saved by the DAG.",
    },
    observed: {
      model,
      runtimeOwnedInput,
      performance,
      contextDelivery: {
        contextPreparations: contextTotals.preparationCount,
        duplicateContextReadyEventsIgnored: contextReady.duplicateCount,
        retryContextPreparations: contextTotals.retryPreparationCount,
        measuredPreparations: contextTotals.measuredCount,
        rawTokens: contextTotals.rawTokens,
        deliveredTokens: contextTotals.deliveredTokens,
        tokensSaved: contextTotals.observedDeliveryTokensSaved,
        savingsPercent: contextTotals.deliverySavingsPercent,
      },
      exactCache: {
        scope: "run-execution-context-ready",
        packHits: contextTotals.exactPackHits,
        packL1Hits: contextTotals.exactPackL1Hits,
        packL2Hits: contextTotals.exactPackL2Hits,
        packMisses: Math.max(0, contextTotals.measuredCount - contextTotals.exactPackHits),
        componentHits: contextTotals.componentCacheHits,
        componentMisses: contextTotals.componentCacheMisses,
        prefetch: {
          lookups: prefetchTotals.measuredCount,
          packHits: prefetchTotals.exactPackHits,
          packL1Hits: prefetchTotals.exactPackL1Hits,
          packL2Hits: prefetchTotals.exactPackL2Hits,
          packMisses: Math.max(0, prefetchTotals.measuredCount - prefetchTotals.exactPackHits),
          measuredPrefetches: prefetchTotals.measuredCount,
          totalPrefetchEvents: prefetchEvents.length,
        },
        directModelPromptTokensSaved: null,
        note: "packHits/packMisses are execution Context Pack lookups for this run only. Prefetch lookups are reported separately because source revisions can legitimately change before execution. Exact cache avoids retrieval/build work; it is not direct prompt-token saving.",
      },
    },
    estimated: {
      semanticCache: {
        tokensAvoidedEstimate: contextTotals.semanticTokensAvoidedEstimate,
        retrievalCallsAvoided: contextTotals.semanticRetrievalCallsAvoided,
        componentsReused: contextTotals.semanticComponentsReused,
        note: "Estimated upstream retrieval/context-construction avoidance from accepted semantic component reuse; do not add to observed delivery tokens saved.",
      },
    },
    counterfactual: {
      dagAndBudget: {
        contextBudgetBytesPerTask: number(run.context_budget_bytes),
        contextPreparations: contextTotals.preparationCount,
        requestedBudgetTokensEstimate: contextTotals.requestedBudgetTokensEstimate,
        packetEstimatedTokens: contextTotals.packetEstimatedTokens,
        budgetHeadroomTokensEstimate: contextTotals.budgetHeadroomTokensEstimate,
        budgetOverflowTokensEstimate: contextTotals.budgetOverflowTokensEstimate,
        budgetUtilizationPercent: contextTotals.budgetUtilizationPercent,
        taskCount: tasks.length,
        peakParallel: number(run.peak_parallel),
        observedParallelSpeedup: wallMs > 0 ? taskDurationMs / wallMs : null,
        note: "Budget headroom is a counterfactual upper bound for scoped DAG context, not causally observed token savings.",
      },
    },
    tasks: taskReports,
    warnings,
  };
}
