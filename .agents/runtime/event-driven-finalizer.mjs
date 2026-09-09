import { recordPolicyDecision } from "./policy-engine.mjs";
import { deriveRetryBudgetState, repairEffectKey } from "./retry-efficiency.mjs";
import { readFile } from "node:fs/promises";
import { evaluateCompletion } from "./completion-gate.mjs";
import { assertSchema } from "./schema-validator.mjs";
import { classifyValidationFailure, stageContractFailure } from "./executor.mjs";
import { classifyWorkspaceChanges, inspectWorkspaceChanges, integrateWorkspace, reconcileHandoffPathDisposition } from "./workspace.mjs";
import { anyPatternMatches, exists, fileFingerprint, nowIso, readJson, sha256, writeJson } from "./utils.mjs";
import { SUCCESS_TASK_STATUSES } from "./event-driven-contracts.mjs";
import { sanitizeHandoffTelemetryShape } from "./handoff-telemetry.mjs";
import { classifyHandoffValidationError, normalizeModelHandoffContract } from "./handoff-contract.mjs";
import {
  readRepairCheckpoint,
  readRepairResumeReceipt,
  repairCheckpointPathForHandoff,
  repairResumeReceiptPathForHandoff,
} from "./repair-checkpoint.mjs";

const BUFFERED_PERFORMANCE_EVENT_TYPES = new Set([
  "opencode.launching",
  "opencode.spawned",
  "opencode.completed",
  "opencode.session_export",
  "opencode.handoff_authority_resolved",
]);

async function persistBufferedPerformanceEvents({ store, runId, taskId, attempt, runtimeEvents }) {
  for (const event of runtimeEvents ?? []) {
    if (!event || !BUFFERED_PERFORMANCE_EVENT_TYPES.has(event.type)) continue;
    await store.event(runId, taskId, event.type, {
      ...(event.payload ?? {}),
      attempt,
      observedAt: event.observedAt ?? null,
      source: "rust-buffered-opencode-runtime-event",
    });
  }
}

function workspaceFromResult(result, taskPlan) {
  return {
    mode: result.workspace?.mode ?? "copy",
    path: result.workspace?.path,
    baseline: null,
    baselinePath: result.workspace?.baselinePath ?? null,
    _snapshotPatterns: ["**"],
    task: taskPlan,
  };
}


async function inspectExecutionChangeSet(result, workspace, taskPlan) {
  const changeSetPath = result.changeSetPath ?? null;
  if (!changeSetPath || !(await exists(changeSetPath))) return await inspectWorkspaceChanges(workspace, taskPlan);
  const changeSet = await readJson(changeSetPath);
  if (changeSet.schemaVersion !== "workspace-change-set/v1"
      || changeSet.runId !== result.runId
      || changeSet.taskId !== result.taskId
      || Number(changeSet.attempt) !== Number(result.attempt)
      || Number(changeSet.dispatchGeneration) !== Number(result.dispatchGeneration)
      || Number(changeSet.fencingToken) !== Number(result.fencingToken)) {
    throw new Error("workspace_changeset_identity_mismatch");
  }
  const observedPaths = [...new Set((changeSet.observedPaths ?? []).map((path) => String(path).replaceAll("\\", "/")).filter(Boolean))].sort();
  const { changedPaths, toolingSideEffects } = classifyWorkspaceChanges(observedPaths);
  const unauthorized = changedPaths.filter((path) => !anyPatternMatches(taskPlan.ownedPaths ?? [], path));
  return { changedPaths, unauthorized, toolingSideEffects, observedPaths, source: "rust-change-set" };
}

async function hydrateWorkspaceBaseline(workspace) {
  if (workspace.mode === "worktree") return workspace;
  if (!workspace.baselinePath || !(await exists(workspace.baselinePath))) {
    if (workspace.mode === "none") return workspace;
    throw new Error(`workspace_baseline_missing:${workspace.baselinePath ?? "unknown"}`);
  }
  const payload = await readJson(workspace.baselinePath);
  workspace.baseline = new Map(Object.entries(payload.files ?? {}));
  return workspace;
}

async function loadExecutionResult(resultRow) {
  if (resultRow.result_path && await exists(resultRow.result_path)) return await readJson(resultRow.result_path);
  return JSON.parse(resultRow.result_json ?? "{}");
}

function staleExecutionResult(taskRow, result) {
  return Number(result.attempt) !== Number(taskRow.attempt)
    || Number(result.dispatchGeneration) !== Number(taskRow.dispatch_generation)
    || Number(result.fencingToken) !== Number(taskRow.fencing_token);
}

async function scheduleCleanup(store, taskPlan, reason) {
  try {
    await store.requestWorkspaceCleanup(taskPlan.taskId, { reason });
  } catch (error) {
    // Cleanup is operational/reconciliable. It must never overturn a semantic
    // task result or fail the run (Run 5 EBUSY regression).
    await store.event(taskPlan.runId ?? null, taskPlan.taskId, "workspace.cleanup.enqueue_failed", {
      code: error?.code ?? null,
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
  }
}

async function scheduleReconcile(store, plan, taskPlan, reason) {
  try {
    await store.requestReconcile(plan.runId, reason);
  } catch (error) {
    await store.event(plan.runId, taskPlan.taskId, "runtime.reconcile.enqueue_failed", {
      code: error?.code ?? null,
      message: error instanceof Error ? error.message : String(error),
      reason,
    }).catch(() => {});
  }
}

export async function persistRuntimeRepairFindingEvents({
  store,
  runId,
  taskId,
  finding,
  taskAttempt,
  dispatchGeneration = null,
  fencingToken = null,
}) {
  if (finding?.type !== "runtime_repair") return { repairEvent: null, repairEffectKey: null, avoidedEffectKey: null };
  const repairEvent = finding.status === "candidate" ? "repair.started"
    : finding.status === "completed" ? "repair.completed"
    : finding.status === "exhausted" ? "repair.exhausted"
    : finding.status === "failed" ? "repair.failed"
    : null;
  const repairIdentity = {
    taskAttempt: finding.taskAttempt ?? taskAttempt ?? null,
    dispatchGeneration,
    fencingToken,
  };

  let persistedRepairEffectKey = null;
  if (repairEvent) {
    persistedRepairEffectKey = finding.effectKey ?? repairEffectKey({
      runId,
      taskId,
      taskAttempt: repairIdentity.taskAttempt,
      repairKind: finding.repairKind,
      repairPass: finding.repairPass ?? finding.repairPasses ?? 0,
      sourceRevision: finding.sourceRevision ?? 0,
      eventType: repairEvent,
    });
    const payload = { ...finding, ...repairIdentity, effectKey: persistedRepairEffectKey, authoritative: true };
    if (typeof store.eventOnce === "function") await store.eventOnce(runId, taskId, repairEvent, payload, persistedRepairEffectKey);
    else await store.event(runId, taskId, repairEvent, payload);
  }

  let avoidedEffectKey = null;
  if (finding.status === "completed" && finding.avoidedFullRetry === true) {
    avoidedEffectKey = repairEffectKey({
      runId, taskId, taskAttempt: repairIdentity.taskAttempt, repairKind: finding.repairKind,
      repairPass: finding.repairPass ?? 0, sourceRevision: finding.sourceRevision ?? 0, eventType: "retry.full_attempt_avoided",
    });
    const avoidedPayload = {
      failureCode: finding.failureCode ?? (finding.repairKind === "technical-review-semantic" ? "review_not_approved" : "handoff_schema_invalid"),
      ...repairIdentity, repairPass: finding.repairPass ?? null, estimatedAvoidedMs: finding.estimatedAvoidedMs ?? null,
      estimateClass: finding.estimateClass ?? "counterfactual", effectKey: avoidedEffectKey,
    };
    if (typeof store.eventOnce === "function") await store.eventOnce(runId, taskId, "retry.full_attempt_avoided", avoidedPayload, avoidedEffectKey);
    else await store.event(runId, taskId, "retry.full_attempt_avoided", avoidedPayload);
  }
  return { repairEvent, repairEffectKey: persistedRepairEffectKey, avoidedEffectKey };
}

export async function persistRepairResumeReceiptEvidence({ store, plan, taskPlan, result, handoffPath }) {
  if (!handoffPath) return null;
  const receipt = await readRepairResumeReceipt(repairResumeReceiptPathForHandoff(handoffPath), {
    runId: plan.runId,
    taskId: taskPlan.taskId,
    taskAttempt: result.attempt,
    dispatchGeneration: result.dispatchGeneration,
    fencingToken: result.fencingToken,
  });
  if (!receipt) return null;
  if (receipt.skippedFullAgentInvocation !== true || receipt.sameTaskAttempt !== true) {
    throw new Error(`repair_resume_receipt_invalid:${taskPlan.taskId}:${result.attempt}`);
  }
  const payload = {
    sourceTaskAttempt: Number(receipt.sourceTaskAttempt ?? receipt.taskAttempt),
    taskAttempt: Number(receipt.taskAttempt),
    sameTaskAttempt: true,
    dispatchGeneration: Number(receipt.dispatchGeneration),
    fencingToken: Number(receipt.fencingToken),
    repairKind: receipt.repairKind ?? null,
    repairPass: receipt.repairPass ?? null,
    checkpointStatus: receipt.checkpointStatus ?? null,
    checkpointEffectKey: receipt.checkpointEffectKey ?? null,
    sourceRevision: receipt.sourceRevision ?? null,
    repairedRevision: receipt.repairedRevision ?? null,
    skippedFullAgentInvocation: true,
    effectKey: receipt.effectKey,
    authoritative: true,
  };
  if (typeof store.eventOnce === "function") {
    await store.eventOnce(plan.runId, taskPlan.taskId, "repair.resume_checkpoint_loaded", payload, receipt.effectKey);
  } else {
    await store.event(plan.runId, taskPlan.taskId, "repair.resume_checkpoint_loaded", payload);
  }
  return payload;
}

export async function finalizeExecutionResult({ repositoryRoot, plan, taskPlan, registry, schemas, store, options, resultRow }) {
  if (!options?.policyEngine) {
    const error = new Error("runtime_policy_engine_required:finalize-execution-result");
    error.code = "runtime_policy_engine_required";
    throw error;
  }
  const taskRow = await store.getTask(taskPlan.taskId);
  if (!taskRow) throw new Error(`task_not_found:${taskPlan.taskId}`);
  const result = await loadExecutionResult(resultRow);
  if (result.schemaVersion !== "agent-execution-result/v1") throw new Error("agent_execution_result_version_invalid");
  if (result.runId !== plan.runId || result.taskId !== taskPlan.taskId) throw new Error("agent_execution_result_identity_mismatch");
  if (staleExecutionResult(taskRow, result)) {
    await store.event(plan.runId, taskPlan.taskId, "execution.result.stale", {
      attempt: result.attempt,
      dispatchGeneration: result.dispatchGeneration,
      fencingToken: result.fencingToken,
      currentAttempt: taskRow.attempt,
      currentDispatchGeneration: taskRow.dispatch_generation,
      currentFencingToken: taskRow.fencing_token,
    });
    await store.consumeExecutionResult(resultRow.result_id);
    return { status: "stale", stale: true };
  }

  const handoffPath = result.handoffPath ?? taskRow.handoff_path;
  await persistRepairResumeReceiptEvidence({ store, plan, taskPlan, result, handoffPath });

  if (SUCCESS_TASK_STATUSES.has(taskRow.status)) {
    await store.consumeExecutionResult(resultRow.result_id).catch(() => {});
    await scheduleCleanup(store, { ...taskPlan, runId: plan.runId }, "terminal_result_replayed");
    await scheduleReconcile(store, plan, taskPlan, "terminal_result_replayed");
    return { status: taskRow.status, replayed: true };
  }

  const brief = await readJson(taskRow.brief_path);
  const executionMode = result.telemetry?.executionMode ?? taskPlan.executionMode ?? brief.executionMode ?? "agent";
  const logPath = result.logPath ?? null;
  const startedAt = taskRow.started_at ?? result.startedAt ?? nowIso();
  await store.updateTask(taskPlan.taskId, {
    status: "running",
    execution_result_path: resultRow.result_path,
    opencode_session_id: result.telemetry?.sessionId ?? taskRow.opencode_session_id ?? null,
  });
  await store.event(plan.runId, taskPlan.taskId, "execution.result.received", {
    attempt: result.attempt,
    dispatchGeneration: result.dispatchGeneration,
    fencingToken: result.fencingToken,
    exitCode: result.exitCode,
    timedOut: Boolean(result.timedOut),
    softTimedOut: Boolean(result.softTimedOut),
    stalled: Boolean(result.stalled),
    aborted: Boolean(result.aborted),
    startedAt: result.startedAt ?? null,
    completedAt: result.completedAt ?? null,
    executorDurationMs: result.startedAt && result.completedAt ? Math.max(0, Date.parse(result.completedAt) - Date.parse(result.startedAt)) : null,
    executionMode,
  });
  await persistBufferedPerformanceEvents({
    store, runId: plan.runId, taskId: taskPlan.taskId, attempt: result.attempt,
    runtimeEvents: result.telemetry?.runtimeEvents ?? [],
  });
  if (logPath && await exists(logPath)) {
    const logFingerprint = sha256(await readFile(logPath));
    const existing = (await store.listArtifacts(plan.runId)).find((artifact) => artifact.task_id === taskPlan.taskId && artifact.path === logPath);
    if (!existing) await store.addArtifact({ runId: plan.runId, taskId: taskPlan.taskId, kind: "executor-log", version: `attempt-${result.attempt}`, path: logPath, sha256: logFingerprint });
  }

  let failure = null;
  let handoff = null;
  const processResult = {
    status: Number(result.exitCode ?? 1),
    signal: result.signal ?? null,
    stdout: "",
    stderr: result.stderrSummary ?? "",
    timedOut: Boolean(result.timedOut),
    softTimedOut: Boolean(result.softTimedOut),
    stalled: Boolean(result.stalled),
    aborted: Boolean(result.aborted),
    error: result.error ?? null,
  };
  if (processResult.aborted) {
    failure = { code: "executor_cancelled", message: "Executor cancelled", retryable: false, cancelled: true, category: "code" };
  } else if (processResult.status !== 0) {
    failure = classifyValidationFailure({ result: processResult, preTeardownHealth: null, dockerBlocked: null, lifecycleUsed: false });
    if (failure?.code === "handoff_schema_invalid" && handoffPath) {
      const checkpoint = await readRepairCheckpoint(repairCheckpointPathForHandoff(handoffPath), {
        runId: plan.runId,
        taskId: taskPlan.taskId,
        taskAttempt: result.attempt,
      });
      if (checkpoint?.status === "repair-exhausted" && checkpoint?.failureCode === "handoff_schema_invalid") {
        await persistRuntimeRepairFindingEvents({
          store,
          runId: plan.runId,
          taskId: taskPlan.taskId,
          finding: {
            type: "runtime_repair",
            repairKind: checkpoint.repairKind ?? "handoff-schema",
            status: "exhausted",
            repairPass: checkpoint.repairPass ?? 1,
            repairPasses: checkpoint.repairPassLimit ?? checkpoint.repairPass ?? 1,
            taskAttempt: checkpoint.taskAttempt ?? result.attempt,
            sameTaskAttempt: true,
            failureCode: "handoff_schema_invalid",
            sourceRevision: checkpoint.sourceRevision ?? 0,
          },
          taskAttempt: result.attempt,
          dispatchGeneration: result.dispatchGeneration ?? null,
          fencingToken: result.fencingToken ?? null,
        });
      }
    }
  } else if (!handoffPath || !(await exists(handoffPath))) {
    failure = { code: "handoff_missing", message: `Executor exited successfully without writing ${handoffPath ?? "handoff"}`, retryable: true };
  } else {
    try {
      handoff = await readJson(handoffPath);
      const normalizedContract = normalizeModelHandoffContract({ handoff, brief, attempt: result.attempt });
      handoff = normalizedContract.handoff;
      if (normalizedContract.changed) {
        await store.event(plan.runId, taskPlan.taskId, "handoff.contract_normalized", {
          remappedFields: normalizedContract.remappedFields,
          removedFields: normalizedContract.removedFields,
          defaultedFields: normalizedContract.defaultedFields,
          droppedValidationEntries: normalizedContract.droppedValidationEntries,
          identityEchoCorrections: normalizedContract.identityEchoCorrections ?? [],
          authority: "semantic-control-plane",
        });
        await writeJson(handoffPath, handoff);
      }
      const normalizedTelemetry = sanitizeHandoffTelemetryShape(handoff);
      handoff = normalizedTelemetry.handoff;
      if (normalizedTelemetry.removedMetricKeys.length || normalizedTelemetry.removedExecutionTelemetryKeys.length) {
        await store.event(plan.runId, taskPlan.taskId, "handoff.telemetry_normalized", {
          removedMetricKeys: normalizedTelemetry.removedMetricKeys,
          removedExecutionTelemetryKeys: normalizedTelemetry.removedExecutionTelemetryKeys,
          authority: "runtime-owned-telemetry-envelope",
        });
        await writeJson(handoffPath, handoff);
      }
      assertSchema(handoff, schemas.handoffResult, "handoffResult");
      if (handoff.runId !== plan.runId || handoff.taskId !== taskPlan.taskId || handoff.agentId !== taskPlan.agentId) throw new Error("handoff_identity_mismatch");
      await store.writeCheckpoint({
        runId: plan.runId, taskId: taskPlan.taskId, type: "handoff.written", attempt: result.attempt,
        dispatchGeneration: result.dispatchGeneration, fencingToken: result.fencingToken,
        fingerprint: `sha256:${sha256(await readFile(handoffPath))}`, reusable: false, payload: { path: handoffPath },
      });
    } catch (error) {
      failure = classifyHandoffValidationError(error);
    }
  }

  if (handoff) {
    for (const finding of handoff.findings ?? []) {
      await store.event(plan.runId, taskPlan.taskId, "handoff.finding", finding);
      if (finding?.type === "runtime_repair") {
        await persistRuntimeRepairFindingEvents({
          store,
          runId: plan.runId,
          taskId: taskPlan.taskId,
          finding,
          taskAttempt: result.attempt ?? null,
          dispatchGeneration: result.dispatchGeneration ?? null,
          fencingToken: result.fencingToken ?? null,
        });
      }
    }
    const deterministicReuse = executionMode === "deterministic-reuse";
    handoff.executionTelemetry = {
      ...(handoff.executionTelemetry ?? {}),
      modelId: deterministicReuse ? "runtime/deterministic-reuse" : brief.modelRouting.model,
      variant: deterministicReuse ? null : brief.modelRouting.variant ?? null,
      reasoningEffort: deterministicReuse ? "low" : brief.modelRouting.reasoningEffort,
      stepsLimit: deterministicReuse ? 1 : brief.modelRouting.stepsLimit,
      stepsUsed: deterministicReuse ? 0 : handoff.executionTelemetry?.stepsUsed ?? null,
      stepLimitReached: deterministicReuse ? false : handoff.executionTelemetry?.stepLimitReached ?? null,
      stopReason: deterministicReuse ? "deterministic_reuse_validation_complete" : handoff.executionTelemetry?.stopReason ?? (processResult.status === 0 ? "executor_exit_0" : "executor_nonzero"),
      attempt: result.attempt,
      sessionId: deterministicReuse ? null : handoff.executionTelemetry?.sessionId ?? result.telemetry?.sessionId ?? null,
      usageSource: deterministicReuse ? "unavailable" : handoff.executionTelemetry?.usageSource ?? "handoff",
    };
    await writeJson(handoffPath, handoff);
    if (deterministicReuse) {
      await store.event(plan.runId, taskPlan.taskId, "execution.deterministic_reuse.observed", {
        attempt: result.attempt, executionMode, fullAgentInvocation: false,
        validationCommands: (handoff.validation ?? []).filter((entry) => entry.authority === "runtime" && entry.phase === "final").map((entry) => entry.command),
        changedPaths: handoff.changedPaths ?? [], reusedPaths: handoff.reusedPaths ?? [],
      });
    } else {
      const auxiliaryInvocations = Array.isArray(handoff.auxiliaryInvocations)
        ? handoff.auxiliaryInvocations.map((invocation) => ({
          purpose: invocation.purpose ?? null,
          modelId: invocation.modelId ?? null,
          wallMs: invocation.wallMs !== null && invocation.wallMs !== undefined && Number.isFinite(Number(invocation.wallMs))
            ? Number(invocation.wallMs)
            : null,
        }))
        : [];
      const auxiliaryWallMs = auxiliaryInvocations
        .filter((invocation) => Number.isFinite(invocation.wallMs))
        .reduce((sum, invocation) => sum + invocation.wallMs, 0);
      await store.event(plan.runId, taskPlan.taskId, "model.usage.observed", {
        attempt: result.attempt,
        modelId: handoff.executionTelemetry.modelId,
        inputTokens: Number(handoff.metrics?.inputTokens ?? 0),
        outputTokens: Number(handoff.metrics?.outputTokens ?? 0),
        cachedInputTokens: Number(handoff.metrics?.cachedInputTokens ?? 0),
        costUsd: Number(handoff.metrics?.costUsd ?? 0),
        stepsLimit: handoff.executionTelemetry.stepsLimit ?? null,
        stepsUsed: handoff.executionTelemetry.stepsUsed ?? null,
        auxiliaryInvocationCount: auxiliaryInvocations.length,
        auxiliaryWallMs,
        auxiliaryInvocations,
      });
    }
    await store.updateTask(taskPlan.taskId, {
      used_context_documents: handoff.usedContextPaths?.length ?? null,
      input_tokens: deterministicReuse ? 0 : handoff.metrics?.inputTokens ?? null,
      output_tokens: deterministicReuse ? 0 : handoff.metrics?.outputTokens ?? null,
      cached_input_tokens: deterministicReuse ? 0 : handoff.metrics?.cachedInputTokens ?? null,
      cost_usd: deterministicReuse ? 0 : handoff.metrics?.costUsd ?? null,
      model_id: handoff.executionTelemetry.modelId,
      model_variant: handoff.executionTelemetry.variant,
      reasoning_effort: handoff.executionTelemetry.reasoningEffort,
      steps_limit: handoff.executionTelemetry.stepsLimit,
      steps_used: handoff.executionTelemetry.stepsUsed,
      step_limit_reached: handoff.executionTelemetry.stepLimitReached,
      stop_reason: handoff.executionTelemetry.stopReason,
      opencode_session_id: handoff.executionTelemetry.sessionId ?? null,
    });
    if (handoff.status === "blocked") failure = { code: "agent_blocked", message: handoff.residualRisks.join("; ") || "agent blocked", retryable: false, blocked: true };
    else if (handoff.status === "cancelled") failure = { code: "agent_cancelled", message: "agent cancelled", retryable: false, cancelled: true };
    else if (handoff.status === "failed") failure = { code: "agent_failed", message: handoff.residualRisks.join("; ") || "agent failed", retryable: handoff.retryable === true };
  }

  if (!failure && handoff) {
    const stageFailure = await stageContractFailure(taskPlan, handoff, schemas, registry, plan, store, brief);
    if (stageFailure) failure = stageFailure;
    const completion = evaluateCompletion({ taskBrief: brief, handoff });
    if (!failure && !completion.accepted) failure = { code: completion.code, message: completion.violations.join("; ") || "Completion was not proven", retryable: completion.retryable !== false, category: completion.category ?? "contract", repairExhausted: completion.repairExhausted === true, failureClass: completion.failureClass ?? null };
    if (!failure) {
      await store.event(plan.runId, taskPlan.taskId, "completion.proven", { criteria: brief.acceptanceCriteria.map((criterion) => criterion.id), stage: taskPlan.stage, model: brief.modelRouting.model });
      await store.writeCheckpoint({
        runId: plan.runId, taskId: taskPlan.taskId, type: "completion.proven", attempt: result.attempt,
        dispatchGeneration: result.dispatchGeneration, fencingToken: result.fencingToken, reusable: false,
        payload: { criteria: brief.acceptanceCriteria.map((criterion) => criterion.id), stage: taskPlan.stage },
      });
    } else {
      await store.event(plan.runId, taskPlan.taskId, "completion.rejected", { code: failure.code, stage: taskPlan.stage, model: brief.modelRouting.model });
    }
  }

  let workspace = null;
  let inspection = null;
  if (!failure && handoff) {
    workspace = await hydrateWorkspaceBaseline(workspaceFromResult(result, taskPlan));
    inspection = await inspectExecutionChangeSet(result, workspace, taskPlan);
    const disposition = await reconcileHandoffPathDisposition({
      workspace,
      task: taskPlan,
      inspection,
      handoff,
      changedPaths: handoff.changedPaths ?? [],
      reusedPaths: handoff.reusedPaths ?? [],
      contextReferencePaths: brief.readOnlyContextPaths ?? [],
    });
    if (inspection.toolingSideEffects.length > 0) await store.event(plan.runId, taskPlan.taskId, "workspace.tooling_side_effects", { paths: inspection.toolingSideEffects });
    const reusedSet = new Set(disposition.reusedPaths);
    const contextOnlySet = new Set(disposition.contextOnlyPaths ?? []);
    const fromChangedToReused = disposition.ghostDeclarations.filter((path) => reusedSet.has(path));
    const fromChangedToContext = disposition.ghostDeclarations.filter((path) => contextOnlySet.has(path));
    const fromReusedToChanged = disposition.reclassifiedReusedToChanged ?? [];
    if (fromChangedToReused.length > 0 || fromChangedToContext.length > 0 || fromReusedToChanged.length > 0) {
      await store.event(plan.runId, taskPlan.taskId, "handoff.path_disposition_normalized", {
        fromChangedToReused,
        fromChangedToContext,
        fromReusedToChanged,
        reason: fromReusedToChanged.length > 0 ? "workspace_change_authoritative" : "baseline_byte_identical",
      });
    }
    if (disposition.reusedPathFingerprints.length > 0) {
      await store.event(plan.runId, taskPlan.taskId, "workspace.reused_paths_verified", {
        paths: disposition.reusedPathFingerprints,
      });
    }
    if ((disposition.contextOnlyPathFingerprints ?? []).length > 0) {
      await store.event(plan.runId, taskPlan.taskId, "workspace.context_paths_verified", {
        paths: disposition.contextOnlyPathFingerprints,
      });
      handoff.usedContextPaths = [...new Set([...(handoff.usedContextPaths ?? []), ...disposition.contextOnlyPaths])].sort();
    }
    if ((disposition.baselineDetectedChanges ?? []).length > 0) {
      await store.event(plan.runId, taskPlan.taskId, "workspace.changeset_gap_reconciled", {
        paths: disposition.baselineDetectedChanges,
        collector: inspection.source ?? "unknown",
        authority: "workspace_baseline_fingerprint",
      });
    }
    if ((disposition.droppedPhantomReusedPaths ?? []).length > 0) {
      await store.event(plan.runId, taskPlan.taskId, "workspace.phantom_reused_paths_dropped", {
        paths: disposition.droppedPhantomReusedPaths,
        authority: "workspace_and_baseline_absence",
        scope: "zero-file-governance-review-non-evidentiary-bookkeeping",
      });
    }
    if (disposition.invalidReused.length > 0) {
      failure = { code: "handoff_reused_paths_invalid", message: disposition.invalidReused.map((entry) => `${entry.path}:${entry.reason}`).join(","), retryable: false };
    } else if (disposition.missingDeclaredChanges.length > 0) {
      failure = { code: "handoff_changed_paths_mismatch", message: `declared=${disposition.changedPaths.join(",")} actual=${inspection.changedPaths.join(",")} undeclared=${disposition.missingDeclaredChanges.join(",")}`, retryable: false };
    } else {
      handoff.changedPaths = disposition.changedPaths;
      handoff.reusedPaths = disposition.reusedPaths;
      await writeJson(handoffPath, handoff);
      await store.writeCheckpoint({
        runId: plan.runId, taskId: taskPlan.taskId, type: "workspace.changeset.ready", attempt: result.attempt,
        dispatchGeneration: result.dispatchGeneration, fencingToken: result.fencingToken, reusable: false,
        payload: { changedPaths: disposition.changedPaths, collectorChangedPaths: inspection.changedPaths, toolingSideEffects: inspection.toolingSideEffects, changeSetPath: result.changeSetPath ?? null },
      });
    }
  }

  if (!failure && handoff) {
    try {
      if (options.integrate) {
        await store.event(plan.runId, taskPlan.taskId, "workspace.integration_changeset_selected", {
          source: inspection?.source ?? "semantic-inspection",
          collectorChangedPaths: inspection?.changedPaths ?? [],
          approvedChangedPaths: handoff.changedPaths ?? [],
          dispatchGeneration: result.dispatchGeneration,
          fencingToken: result.fencingToken,
        });
      }
      const finalInspection = options.integrate
        ? await integrateWorkspace({
            repositoryRoot,
            workspace,
            task: taskPlan,
            store,
            runId: plan.runId,
            inspection,
            approvedChangedPaths: handoff.changedPaths ?? [],
          })
        : { ...inspection, changedPaths: handoff.changedPaths ?? inspection.changedPaths ?? [] };
      const fingerprint = await fileFingerprint(handoffPath);
      const artifactId = await store.addArtifact({ runId: plan.runId, taskId: taskPlan.taskId, kind: "handoff", version: handoff.artifactVersion, path: handoffPath, sha256: fingerprint?.sha256 ?? null, accepted: true });
      const completedAt = nowIso();
      const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
      const terminalStatus = taskPlan.role === "verification" ? "verified" : "integrated";
      await store.updateTask(taskPlan.taskId, {
        status: terminalStatus,
        completed_at: completedAt,
        duration_ms: durationMs,
        lease_owner: null,
        lease_expires_at: null,
        cleanup_state: "queued",
      });
      await store.writeCheckpoint({
        runId: plan.runId, taskId: taskPlan.taskId, type: "integration.applied", attempt: result.attempt,
        dispatchGeneration: result.dispatchGeneration, fencingToken: result.fencingToken, reusable: false,
        payload: { changedPaths: finalInspection.changedPaths },
      });
      await store.writeCheckpoint({
        runId: plan.runId, taskId: taskPlan.taskId, type: "task.integrated", attempt: result.attempt,
        dispatchGeneration: result.dispatchGeneration, fencingToken: result.fencingToken, reusable: false,
        payload: { artifactId, terminalStatus },
      });
      await store.event(plan.runId, taskPlan.taskId, "task.integrated", { artifactId, changedPaths: finalInspection.changedPaths, durationMs, verification: taskPlan.role === "verification", attempt: result.attempt, dispatchGeneration: result.dispatchGeneration, executionMode });
      await store.consumeExecutionResult(resultRow.result_id);
      await scheduleCleanup(store, { ...taskPlan, runId: plan.runId }, "integration_complete");
      await scheduleReconcile(store, plan, taskPlan, "task_integrated");
      return { status: terminalStatus, handoff, changedPaths: finalInspection.changedPaths };
    } catch (error) {
      failure = { code: "integration_failed", message: error instanceof Error ? error.message : String(error), retryable: false };
    }
  }

  const completedAt = nowIso();
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  const attempt = Number(result.attempt);
  const maxAttempts = Number(taskRow.max_attempts ?? options.maxAttempts);
  const retryBudgetState = deriveRetryBudgetState(await store.listEvents(plan.runId), { taskId: taskPlan.taskId, startedAtMs: Date.parse(startedAt) });
  const retryDecision = options.policyEngine.evaluateRetry({ failure, attempt, maxAttempts, retryBudgetState });
  await recordPolicyDecision(store, { runId: plan.runId, taskId: taskPlan.taskId, operation: "retry", decision: retryDecision });
  const canRetry = retryDecision.allowed === true;
  const retryAfterMs = canRetry ? Math.max(0, Number(retryDecision.retryAfterMs ?? 30_000)) : null;
  const retryNotBefore = canRetry ? new Date(Date.now() + retryAfterMs).toISOString() : null;
  const status = failure?.cancelled ? "cancelled" : failure?.blocked ? "blocked" : canRetry ? "retrying" : "failed";
  await store.updateTask(taskPlan.taskId, {
    status,
    completed_at: canRetry ? null : completedAt,
    duration_ms: durationMs,
    error_code: failure?.code ?? "execution_failed",
    error_message: failure?.message ?? "Execution failed",
    lease_owner: null,
    lease_expires_at: null,
    retry_not_before: retryNotBefore,
    cleanup_state: "queued",
  });
  await store.event(plan.runId, taskPlan.taskId, canRetry ? "task.retry_scheduled" : `task.${status}`, {
    attempt,
    code: failure?.code ?? "execution_failed",
    message: failure?.message ?? "Execution failed",
    failureCategory: failure?.category ?? null,
    retryable: canRetry,
    retryAfterMs,
    retryNotBefore,
    retryDisposition: retryDecision.details?.retryDisposition ?? null,
    backoffApplied: retryAfterMs > 0,
    policyCode: retryDecision.code ?? null,
  });
  if (canRetry) {
    const retryDisposition = retryDecision.details?.retryDisposition ?? null;
    await store.event(plan.runId, taskPlan.taskId, "retry.true_scheduled", {
      attempt,
      failureCode: failure?.code ?? "execution_failed",
      failureCategory: failure?.category ?? null,
      failureMessage: String(failure?.message ?? "Execution failed").slice(0, 4_000),
      retryDisposition,
      retryAfterMs,
      retryNotBefore,
      backoffApplied: retryAfterMs > 0,
      repairExhausted: failure?.repairExhausted === true,
    });
    if (retryAfterMs > 0) {
      await store.event(plan.runId, taskPlan.taskId, "retry.backoff_applied", {
        attempt,
        failureCode: failure?.code ?? "execution_failed",
        retryDisposition,
        retryAfterMs,
      });
    }
  }
  await store.consumeExecutionResult(resultRow.result_id);
  await scheduleCleanup(store, { ...taskPlan, runId: plan.runId }, canRetry ? "retry_attempt_complete" : "task_terminal_failure");
  await scheduleReconcile(store, plan, taskPlan, canRetry ? "retry_scheduled" : "task_terminal_failure");
  return { status, failure, retryScheduled: canRetry };
}

export function taskResultIsSuccessful(task) {
  return SUCCESS_TASK_STATUSES.has(task?.status);
}
