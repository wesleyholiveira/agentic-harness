import { join } from "node:path";
import { collectImplementationPlanValidationIssues, compileImplementationDag, saveCompiledDag } from "./dag-compiler.mjs";
import { assertPolicyAllowed, recordPolicyDecision } from "./policy-engine.mjs";
import { deriveRetryBudgetState } from "./retry-efficiency.mjs";
import { finalizeExecution } from "./executor.mjs";
import { finalizeExecutionResult } from "./event-driven-finalizer.mjs";
import { dependenciesFailed, dependenciesSatisfied, stableFingerprint, SUCCESS_TASK_STATUSES, TERMINAL_RUN_STATUSES, TERMINAL_TASK_STATUSES } from "./event-driven-contracts.mjs";
import { prefetchTaskPreparation, prepareTaskExecution } from "./event-driven-preparation.mjs";
import { nowIso, readJson } from "./utils.mjs";
import { recordReplayCapsuleArtifact, updateReplayCapsuleWithCompiledPlan, updateReplayCapsuleWithRefinedBootstrapPlan } from "./run-replay.mjs";
import { bootstrapTopologyReadyForTask, refineBootstrapPlanFromProductDiscovery } from "./bootstrap-topology-refiner.mjs";


export function classifyPreparationFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (
    error
    && typeof error === "object"
    && error.code === "context_semantic_dependency_unavailable"
  ) {
    return {
      code: "context_semantic_dependency_unavailable",
      message,
      retryable: error.retryable === true,
      category: error.category ?? "context-infrastructure",
      dependency: error.dependency ?? "unknown",
      causeCode: error.causeCode ?? null,
    };
  }
  if (message.startsWith("handoff_review_revision_ambiguous:")) {
    return {
      code: "handoff_review_revision_ambiguous",
      message,
      retryable: false,
      category: "runtime-contract",
      dependency: "review-revision-lineage",
      causeCode: message,
    };
  }
  return null;
}

async function persistPreparationFailure({ store, plan, row, failure, options }) {
  const attempt = Number(row.attempt ?? 0) + 1;
  const maxAttempts = Number(row.max_attempts ?? options.maxAttempts ?? 1);
  const retryBudgetState = deriveRetryBudgetState(await store.listEvents(plan.runId), { taskId: row.task_id, startedAtMs: row.started_at ? Date.parse(row.started_at) : null });
  const retryDecision = options.policyEngine.evaluateRetry({ failure, attempt, maxAttempts, retryBudgetState });
  await recordPolicyDecision(store, { runId: plan.runId, taskId: row.task_id, operation: "retry", decision: retryDecision });
  const canRetry = retryDecision.allowed === true;
  const retryAfterMs = canRetry ? Math.max(0, Number(retryDecision.retryAfterMs ?? 30_000)) : null;
  const retryNotBefore = canRetry ? new Date(Date.now() + retryAfterMs).toISOString() : null;
  const status = canRetry ? "retrying" : "failed";
  await store.updateTask(row.task_id, {
    status,
    attempt,
    error_code: failure.code,
    error_message: failure.message,
    lease_owner: null,
    lease_expires_at: null,
    retry_not_before: retryNotBefore,
    ...(canRetry ? { completed_at: null } : { completed_at: nowIso() }),
  });
  await store.event(plan.runId, row.task_id, "context.preparation_failed", {
    attempt,
    dispatchGeneration: Number(row.dispatch_generation ?? 0),
    fencingToken: Number(row.fencing_token ?? 0),
    code: failure.code,
    category: failure.category,
    dependency: failure.dependency,
    causeCode: failure.causeCode,
    retryable: canRetry,
    retryAfterMs,
    policyRetryAfterMs: retryAfterMs,
    policyCode: retryDecision.code ?? null,
    retryNotBefore,
  });
  await store.event(
    plan.runId,
    row.task_id,
    canRetry ? "task.retry_scheduled" : "task.failed",
    {
      attempt,
      code: failure.code,
      message: failure.message,
      failureCategory: failure.category ?? null,
      retryable: canRetry,
      retryDisposition: retryDecision.details?.retryDisposition ?? null,
      retryAfterMs,
      backoffApplied: retryAfterMs > 0,
      reason: "context_preparation_failed",
    },
  );
  if (canRetry) {
    const retryDisposition = retryDecision.details?.retryDisposition ?? null;
    await store.event(plan.runId, row.task_id, "retry.true_scheduled", {
      attempt,
      failureCode: failure.code,
      failureCategory: failure.category ?? null,
      failureMessage: String(failure.message ?? "Context preparation failed").slice(0, 4_000),
      retryDisposition,
      retryAfterMs,
      retryNotBefore,
      backoffApplied: retryAfterMs > 0,
      repairExhausted: false,
    });
    if (retryAfterMs > 0) await store.event(plan.runId, row.task_id, "retry.backoff_applied", { attempt, failureCode: failure.code, retryDisposition, retryAfterMs });
  }
  // A notification may wake the same run immediately after this event. The
  // durable retry_not_before gate below, not process-local sleeping, prevents
  // those reconciles from consuming the failure budget before the repair sweep.
  return { canRetry, attempt, status };
}

function taskPlanMap(plan) {
  return new Map(plan.tasks.map((task) => [task.taskId, task]));
}

function stateMap(tasks) {
  return new Map(tasks.map((task) => [task.task_id, task.status]));
}

async function refineBootstrapTopologyIfReady({ repositoryRoot, registry, schemas, plan, store, options }) {
  if (plan.phase !== "bootstrap" || plan.workflow?.bootstrapTopologyState === "refined") return plan;
  const rows = await store.listTasks(plan.runId);
  const product = rows.find((task) => task.task_id === plan.workflow.productOwnerTaskId);
  if (!SUCCESS_TASK_STATUSES.has(product?.status)) return plan;
  const artifacts = (await store.listArtifacts(plan.runId))
    .filter((artifact) => artifact.task_id === plan.workflow.productOwnerTaskId && artifact.kind === "handoff" && Number(artifact.accepted) === 1)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const productArtifact = artifacts[0];
  if (!productArtifact) throw new Error("product_owner_handoff_artifact_missing");
  const handoff = await readJson(productArtifact.path);
  if (!handoff?.bootstrapReviewAssessment) {
    const error = new Error("product_discovery_bootstrap_review_assessment_missing");
    error.code = "product_discovery_bootstrap_review_assessment_missing";
    throw error;
  }
  const refined = refineBootstrapPlanFromProductDiscovery({ plan, handoff, registry, schemas, policyEngine: options.policyEngine });
  if (!refined.changed) return refined.plan;
  const currentRun = await store.getRun(plan.runId);
  await store.applyBootstrapPlanRefinement(plan.runId, refined.plan, {
    addedTasks: refined.addedTasks,
    removedTaskIds: refined.removedTasks.map((task) => task.taskId),
    dependencyUpdates: refined.dependencyUpdates,
    expectedVersion: currentRun?.state_version,
    maxAttempts: options.maxAttempts,
    reasoningSource: refined.plan.reasoning?.source ?? null,
  });
  if (refined.policyDecision) {
    await recordPolicyDecision(store, { runId: plan.runId, taskId: plan.workflow.productOwnerTaskId, operation: "plan", decision: refined.policyDecision });
    await store.event(plan.runId, plan.workflow.productOwnerTaskId, "policy.bootstrap_refinement_decision", {
      ...refined.policyDecision,
      policyFingerprint: options.policyEngine?.fingerprint ?? null,
    });
  }
  const replayUpdate = await updateReplayCapsuleWithRefinedBootstrapPlan(repositoryRoot, refined.plan, {
    assessment: refined.assessment,
    authority: refined.plan.workflow.bootstrapTopologyAuthority,
    schemas,
  });
  await recordReplayCapsuleArtifact(store, {
    runId: plan.runId,
    taskId: plan.workflow.productOwnerTaskId,
    path: replayUpdate.path,
    capsule: replayUpdate.capsule,
    stage: "refined",
  });
  await store.event(plan.runId, plan.workflow.productOwnerTaskId, "bootstrap.topology.refined", {
    topologyRevision: refined.plan.workflow.bootstrapTopologyRevision,
    authority: refined.plan.workflow.bootstrapTopologyAuthority,
    addedTaskIds: refined.addedTasks.map((task) => task.taskId),
    removedTaskIds: refined.removedTasks.map((task) => task.taskId),
    dependencyUpdates: refined.dependencyUpdates,
    factBindings: refined.plan.workflow.bootstrapFactBindings.length,
    reviewEdges: refined.plan.workflow.bootstrapReviewDependencies.length,
    replayCapsuleFingerprint: replayUpdate.capsule.capsuleFingerprint,
  });
  return refined.plan;
}

async function compileRefinedDagIfReady({ repositoryRoot, registry, schemas, plan, store, options }) {
  if (plan.phase !== "bootstrap") return plan;
  const rows = await store.listTasks(plan.runId);
  const technicalLead = rows.find((task) => task.task_id === plan.workflow.technicalLeadTaskId);
  if (!SUCCESS_TASK_STATUSES.has(technicalLead?.status)) return plan;

  const artifacts = await store.listArtifacts(plan.runId);
  const newestAccepted = (taskId) => artifacts
    .filter((artifact) => artifact.task_id === taskId && artifact.kind === "handoff" && Number(artifact.accepted) === 1)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  const tlArtifact = newestAccepted(plan.workflow.technicalLeadTaskId);
  if (!tlArtifact) throw new Error("technical_lead_handoff_artifact_missing");
  const poArtifact = newestAccepted(plan.workflow.productOwnerTaskId);
  if (!poArtifact) throw new Error("product_owner_handoff_artifact_missing");

  const [technicalLeadHandoff, poHandoff] = await Promise.all([readJson(tlArtifact.path), readJson(poArtifact.path)]);
  const validationIssues = collectImplementationPlanValidationIssues(technicalLeadHandoff?.implementationPlan, registry);
  const compileDecision = options.policyEngine.evaluateCompile({ phase: plan.phase, technicalLeadAccepted: true, validationIssues });
  await recordPolicyDecision(store, { runId: plan.runId, taskId: plan.workflow.technicalLeadTaskId, operation: "compile", decision: compileDecision });
  await store.event(plan.runId, plan.workflow.technicalLeadTaskId, "policy.compile_decision", { ...compileDecision, policyFingerprint: options.policyEngine.fingerprint });
  assertPolicyAllowed(compileDecision, "runtime_policy_compile_denied");
  const compileStartedAt = Date.now();
  const compiled = compileImplementationDag({
    registry,
    plan,
    technicalLeadHandoff,
    schemas,
    requiredAcceptanceCriteria: poHandoff.acceptanceCriteria ?? [],
  });
  const compileDurationMs = Date.now() - compileStartedAt;
  const materializationStartedAt = Date.now();
  const existingIds = new Set(rows.map((task) => task.task_id));
  const newTasks = compiled.tasks.filter((task) => !existingIds.has(task.taskId));
  await store.addTasks(plan.runId, newTasks, {
    maxAttempts: options.maxAttempts,
    reasoningSource: compiled.reasoning?.source ?? null,
  });
  await store.replacePlan(plan.runId, compiled);
  const refinedDagPath = await saveCompiledDag(repositoryRoot, compiled);
  const replayUpdate = await updateReplayCapsuleWithCompiledPlan(repositoryRoot, compiled, {
    implementationPlan: technicalLeadHandoff.implementationPlan,
    requiredAcceptanceCriteria: poHandoff.acceptanceCriteria ?? [],
    schemas,
  });
  await recordReplayCapsuleArtifact(store, {
    runId: plan.runId,
    taskId: plan.workflow.technicalLeadTaskId,
    path: replayUpdate.path,
    capsule: replayUpdate.capsule,
    stage: "compiled",
  });
  await store.event(plan.runId, null, "replay.capsule.compiled_plan_recorded", {
    path: replayUpdate.path,
    capsuleFingerprint: replayUpdate.capsule.capsuleFingerprint,
    compiledPlanFingerprint: replayUpdate.capsule.compiled.planFingerprint,
  });
  await store.event(plan.runId, null, "dag.compiled", {
    implementationPlanRevision: compiled.workflow.implementationPlanRevision,
    taskCount: compiled.tasks.length,
    newTaskIds: newTasks.map((task) => task.taskId),
    refinedDagPath,
    compileDurationMs,
    materializationDurationMs: Date.now() - materializationStartedAt,
  });
  return compiled;
}

async function finalizePendingResults(input, plan) {
  const { repositoryRoot, registry, schemas, store, options } = input;
  const plans = taskPlanMap(plan);
  for (const resultRow of await store.listPendingExecutionResults(plan.runId)) {
    const taskPlan = plans.get(resultRow.task_id);
    if (!taskPlan) {
      await store.event(plan.runId, resultRow.task_id, "execution.result.orphaned", { resultId: resultRow.result_id });
      await store.consumeExecutionResult(resultRow.result_id);
      continue;
    }
    await finalizeExecutionResult({ repositoryRoot, plan, taskPlan, registry, schemas, store, options, resultRow });
  }
}

async function recoverExpiredExecutions(plan, store) {
  const now = Date.now();
  for (const task of await store.listTasks(plan.runId)) {
    if (task.status !== "running" || !task.lease_expires_at) continue;
    const expires = Date.parse(task.lease_expires_at);
    if (!Number.isFinite(expires) || expires > now) continue;
    await store.updateTask(task.task_id, {
      status: "routed",
      lease_owner: null,
      lease_expires_at: null,
      error_code: "execution_lease_expired",
      error_message: "Execution lease expired before a fenced result was committed",
      cleanup_state: "queued",
    });
    await store.event(plan.runId, task.task_id, "execution.lease_expired", {
      taskAttempt: task.attempt,
      dispatchGeneration: task.dispatch_generation,
      fencingToken: task.fencing_token,
    });
    await store.requestWorkspaceCleanup(task.task_id, { reason: "expired_execution_lease" }).catch(() => {});
  }
}

async function cascadeDependencyFailures(plan, store) {
  let changed = true;
  while (changed) {
    changed = false;
    const tasks = await store.listTasks(plan.runId);
    const states = stateMap(tasks);
    for (const task of tasks) {
      if (["routed", "retrying"].includes(task.status) && dependenciesFailed(task, states)) {
        await store.updateTask(task.task_id, {
          status: "cancelled",
          completed_at: nowIso(),
          error_code: "dependency_failed",
          error_message: "Upstream task did not integrate",
        });
        await store.event(plan.runId, task.task_id, "task.cancelled", { reason: "dependency_failed" });
        changed = true;
      }
    }
  }
}

async function prefetchBlockedTasks(input, plan, tasks, states) {
  const plans = taskPlanMap(plan);
  const candidates = tasks.filter((task) => {
    const taskPlan = plans.get(task.task_id);
    return ["routed", "retrying"].includes(task.status)
      && bootstrapTopologyReadyForTask(plan, taskPlan)
      && !dependenciesSatisfied(task, states)
      && !dependenciesFailed(task, states);
  });
  const concurrency = Math.max(1, Math.min(4, Number(input.options.prefetchParallel ?? 2)));
  for (let index = 0; index < candidates.length; index += concurrency) {
    const batch = candidates.slice(index, index + concurrency);
    await Promise.allSettled(batch.map(async (row) => {
      const taskPlan = plans.get(row.task_id);
      if (!taskPlan || !bootstrapTopologyReadyForTask(plan, taskPlan)) return;
      try {
        await prefetchTaskPreparation({ ...input, plan, taskPlan });
      } catch (error) {
        await input.store.event(plan.runId, row.task_id, "task.prefetch.degraded", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }));
  }
}

export function retryWindowOpen(task, nowMs = Date.now()) {
  if (task?.status !== "retrying") return true;
  const raw = task?.retry_not_before;
  if (!raw) return true;
  const retryAt = Date.parse(String(raw));
  return Number.isFinite(retryAt) && retryAt <= nowMs;
}

export function selectReadyDispatchTasks(tasks, maxParallel, nowMs = Date.now()) {
  const states = stateMap(tasks);
  const active = tasks.filter((task) => ["queued", "running"].includes(task.status)).length;
  const available = Math.max(0, Number(maxParallel ?? 1) - active);
  if (available <= 0) return { active, available: 0, ready: [] };
  const ready = tasks
    .filter((task) => ["routed", "retrying"].includes(task.status) && retryWindowOpen(task, nowMs) && dependenciesSatisfied(task, states))
    .sort((a, b) => String(a.task_id).localeCompare(String(b.task_id)))
    .slice(0, available);
  return { active, available, ready };
}

async function dispatchReadyTasks(input, plan, tasks, states) {
  const { store, options } = input;
  const plans = taskPlanMap(plan);
  const selection = selectReadyDispatchTasks(tasks, options.maxParallel);
  if (selection.available === 0) return { dispatched: 0, active: selection.active };

  const runStatus = (await store.getRun(plan.runId))?.status ?? "running";
  const preparationStartedAt = Date.now();
  const preparedResults = await Promise.all(selection.ready.map(async (row) => {
    const taskPlan = plans.get(row.task_id);
    if (!taskPlan) return null;
    const topologyReady = bootstrapTopologyReadyForTask(plan, taskPlan);
    const decision = options.policyEngine.evaluateDispatch({
      runStatus, taskStatus: row.status, dependenciesSatisfied: true, retryWindowOpen: retryWindowOpen(row), topologyReady,
    });
    await recordPolicyDecision(store, { runId: plan.runId, taskId: row.task_id, operation: "dispatch", decision });
    await store.event(plan.runId, row.task_id, "policy.dispatch_decision", { ...decision, policyFingerprint: options.policyEngine.fingerprint });
    // `selection.ready` already removed expected transient ineligibility
    // (dependencies/retry window/capacity). A policy denial here therefore
    // represents a correctness divergence and must fail closed instead of
    // leaving a permanently routed task that only looks like scheduler delay.
    assertPolicyAllowed(decision, "runtime_policy_dispatch_denied");
    try {
      const prepared = await prepareTaskExecution({ ...input, plan, taskPlan });
      return { row, taskPlan, prepared };
    } catch (error) {
      const failure = classifyPreparationFailure(error);
      if (!failure) throw error;
      await persistPreparationFailure({ store, plan, row, failure, options });
      return null;
    }
  }));
  const preparationDurationMs = Math.max(0, Date.now() - preparationStartedAt);
  await store.event(plan.runId, null, "scheduler.ready_preparation.completed", {
    selected: selection.ready.length,
    prepared: preparedResults.filter(Boolean).length,
    concurrency: Math.max(1, selection.ready.length),
    durationMs: preparationDurationMs,
    strategy: "parallel-ready-task-preparation/v1",
  });

  let dispatched = 0;
  for (const item of preparedResults.filter(Boolean)) {
    const { row, prepared } = item;
    const result = await store.dispatchPreparedTask(row.task_id, {
      attempt: prepared.reasoning.attempt,
      descriptorPath: prepared.descriptorPath,
      reason: prepared.repairResume ? "process_loss_repair_resume" : "dependencies_satisfied",
    });
    if (!result.dispatched) continue;
    if (prepared.repairResume) {
      const expectedGeneration = Number(prepared.repairResume.nextDispatchGeneration);
      const expectedFence = Number(prepared.repairResume.nextFencingToken);
      if (Number(result.dispatchGeneration) !== expectedGeneration || Number(result.fencingToken) !== expectedFence) {
        throw new Error(`replacement_dispatch_identity_mismatch:${row.task_id}:${result.dispatchGeneration}:${result.fencingToken}`);
      }
      const effectKey = stableFingerprint({ runId: plan.runId, taskId: row.task_id, taskAttempt: prepared.reasoning.attempt, dispatchGeneration: result.dispatchGeneration, fencingToken: result.fencingToken, eventType: "repair.replacement_execution_dispatched" });
      const payload = {
        sourceTaskAttempt: prepared.repairResume.taskAttempt,
        taskAttempt: prepared.reasoning.attempt,
        sameTaskAttempt: Number(prepared.repairResume.taskAttempt) === Number(prepared.reasoning.attempt),
        sourceDispatchGeneration: prepared.repairResume.sourceDispatchGeneration,
        dispatchGeneration: result.dispatchGeneration,
        sourceFencingToken: prepared.repairResume.sourceFencingToken,
        fencingToken: result.fencingToken,
        checkpointStatus: prepared.repairResume.checkpointStatus,
        checkpointEffectKey: prepared.repairResume.checkpointEffectKey,
        skippedFullAgentInvocationExpected: true,
        effectKey,
      };
      if (typeof store.eventOnce === "function") await store.eventOnce(plan.runId, row.task_id, "repair.replacement_execution_dispatched", payload, effectKey);
      else await store.event(plan.runId, row.task_id, "repair.replacement_execution_dispatched", payload);
    }
    dispatched += 1;
  }
  const peak = Math.max(Number((await store.getRun(plan.runId))?.peak_parallel ?? 0), selection.active + dispatched);
  if (peak > 0) await store.updateRun(plan.runId, { peak_parallel: peak });
  return { dispatched, active: selection.active + dispatched };
}

export async function reconcileRun({ repositoryRoot, registry, schemas, plan: suppliedPlan, store, options, ownerId = `semantic-controller:${process.pid}` }) {
  if (!options?.policyEngine) {
    const error = new Error("runtime_policy_engine_required:reconcile-run");
    error.code = "runtime_policy_engine_required";
    throw error;
  }
  const initial = await store.getRun(suppliedPlan.runId);
  if (!initial) throw new Error(`run_not_found:${suppliedPlan.runId}`);
  if (TERMINAL_RUN_STATUSES.has(initial.status)) {
    return { status: initial.status, terminal: true, plan: JSON.parse(initial.plan_json) };
  }
  const claim = await store.claimRunReconcile(suppliedPlan.runId, ownerId);
  if (!claim) return { status: initial.status, claimed: false };

  try {
    let run = await store.getRun(suppliedPlan.runId);
    let plan = JSON.parse(run.plan_json);
    if (run.status === "routed") {
      await store.updateRun(plan.runId, {
        status: "running",
        started_at: run.started_at ?? nowIso(),
        executor: options.executorCommand,
        workspace_mode: options.workspaceMode,
        max_parallel: options.maxParallel,
        runtime_driver: "event-driven-v1",
      });
      await store.event(plan.runId, null, "run.running", {
        driver: "event-driven-v1",
        maxParallel: options.maxParallel,
        integrate: options.integrate,
      });
    }

    await finalizePendingResults({ repositoryRoot, registry, schemas, store, options }, plan);
    run = await store.getRun(plan.runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return { status: run.status, terminal: true, plan };
    plan = JSON.parse(run.plan_json);
    plan = await refineBootstrapTopologyIfReady({ repositoryRoot, registry, schemas, plan, store, options });

    await recoverExpiredExecutions(plan, store);
    await cascadeDependencyFailures(plan, store);
    plan = await compileRefinedDagIfReady({ repositoryRoot, registry, schemas, plan, store, options });

    let tasks = await store.listTasks(plan.runId);
    if (tasks.length > 0 && tasks.every((task) => TERMINAL_TASK_STATUSES.has(task.status))) {
      const finalized = await finalizeExecution({ repositoryRoot, plan, schemas, store, policyEngine: options.policyEngine, peakParallel: Number((await store.getRun(plan.runId))?.peak_parallel ?? 0) });
      return { ...finalized, terminal: true };
    }

    let states = stateMap(tasks);
    // Dispatch the critical path first. Static prefetch for blocked successors is
    // intentionally overlapped with already-queued execution, never placed in
    // front of a ready Product/Architecture/Technical Lead task.
    const dispatch = await dispatchReadyTasks({ repositoryRoot, registry, schemas, store, options }, plan, tasks, states);
    // Preparation may deterministically fail a routed task without throwing to the
    // driver. Cascade that failure immediately so downstream tasks cannot sit in
    // a routed state until the periodic repair sweep.
    await cascadeDependencyFailures(plan, store);
    tasks = await store.listTasks(plan.runId);
    if (tasks.length > 0 && tasks.every((task) => TERMINAL_TASK_STATUSES.has(task.status))) {
      const finalized = await finalizeExecution({ repositoryRoot, plan, schemas, store, policyEngine: options.policyEngine, peakParallel: Number((await store.getRun(plan.runId))?.peak_parallel ?? 0) });
      return { ...finalized, terminal: true };
    }
    states = stateMap(tasks);
    await prefetchBlockedTasks({ repositoryRoot, registry, schemas, store, options }, plan, tasks, states);

    tasks = await store.listTasks(plan.runId);
    const nonTerminal = tasks.filter((task) => !TERMINAL_TASK_STATUSES.has(task.status));
    const hasActive = nonTerminal.some((task) => ["queued", "running"].includes(task.status));
    const hasFuture = nonTerminal.some((task) => ["routed", "retrying"].includes(task.status));
    if (!hasActive && hasFuture && dispatch.dispatched === 0) {
      const currentStates = stateMap(tasks);
      const trulyReady = nonTerminal.some((task) => ["routed", "retrying"].includes(task.status) && retryWindowOpen(task) && dependenciesSatisfied(task, currentStates));
      if (!trulyReady) {
        await store.event(plan.runId, null, "scheduler.waiting_dependencies", { taskIds: nonTerminal.map((task) => task.task_id) });
      }
    }
    return { status: (await store.getRun(plan.runId)).status, terminal: false, dispatched: dispatch.dispatched, plan };
  } finally {
    await store.releaseRunReconcile(suppliedPlan.runId, ownerId).catch(() => {});
  }
}
