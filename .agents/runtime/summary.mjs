import { formatDuration } from "./utils.mjs";
import { summarizeRuntimePerformance } from "./performance.mjs";
import { readFile } from "node:fs/promises";

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function compactInlineError(value, limit = 800) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

async function runMetrics(store, run) {
  const tasks = await store.listTasks(run.run_id);
  let persistedPlan = {};
  try { persistedPlan = JSON.parse(run.plan_json ?? "{}"); } catch { persistedPlan = {}; }
  const durations = tasks.map((task) => Number(task.duration_ms ?? 0)).filter((value) => value > 0);
  const totalTaskMs = durations.reduce((sum, value) => sum + value, 0);
  const wallMs = run.started_at && run.completed_at ? Date.parse(run.completed_at) - Date.parse(run.started_at) : 0;
  const contextBytes = tasks.reduce((sum, task) => sum + Number(task.context_bytes ?? 0), 0);
  const estimatedTokens = tasks.reduce((sum, task) => sum + Number(task.estimated_tokens ?? 0), 0);
  const contextDocuments = tasks.reduce((sum, task) => sum + Number(task.context_documents ?? 0), 0);
  const usedDocuments = tasks.reduce((sum, task) => sum + Number(task.used_context_documents ?? 0), 0);
  const knownUsageTasks = tasks.filter((task) => task.used_context_documents !== null).length;
  const conflicts = await store.listConflicts(run.run_id);
  const retries = tasks.reduce((sum, task) => sum + Math.max(0, Number(task.attempt ?? 0) - 1), 0);
  const events = await store.listEvents(run.run_id);
  const findings = events.filter((event) => event.event_type === "handoff.finding");
  const policyDecisions = events
    .filter((event) => event.event_type === "policy.decision")
    .map((event) => ({ eventId: event.event_id, taskId: event.task_id ?? null, createdAt: event.created_at, ...parseJsonObject(event.payload_json) }));
  const dagCompiledEvent = [...events].reverse().find((event) => event.event_type === "dag.compiled") ?? null;
  const dagCompilation = dagCompiledEvent ? parseJsonObject(dagCompiledEvent.payload_json) : null;
  const inputTokens = tasks.reduce((sum, task) => sum + Number(task.input_tokens ?? 0), 0);
  const outputTokens = tasks.reduce((sum, task) => sum + Number(task.output_tokens ?? 0), 0);
  const cachedInputTokens = tasks.reduce((sum, task) => sum + Number(task.cached_input_tokens ?? 0), 0);
  const costUsd = tasks.reduce((sum, task) => sum + Number(task.cost_usd ?? 0), 0);
  const stepLimitReached = tasks.filter((task) => task.step_limit_reached === true || Number(task.step_limit_reached ?? 0) === 1).length;
  const continuation = await store.continuationState(run.run_id).catch(() => null);
  const performance = summarizeRuntimePerformance({ run, tasks, events });

  // Load persisted artifacts once so summary can expose both Docker evidence
  // and auxiliary structured-model invocations attached to Handoffs.
  let runArtifacts = [];
  let dockerValidation = [];
  let dockerValidationSummary = null;
  try {
    runArtifacts = await store.listArtifacts(run.run_id);
    const decisionArtifact = runArtifacts.find(
      (a) => a.kind === "integration-decision" && a.version === "v2"
    );
    if (decisionArtifact) {
      let decision = null;
      try {
        const raw = await readFile(decisionArtifact.path, "utf8");
        decision = JSON.parse(raw);
      } catch {
        // Path-based loading failed — skip docker validation
      }
      dockerValidation = decision?.dockerValidation ?? [];
      if (decision?.dockerValidation && tasks.length > 0) {
        const dvArr = decision.dockerValidation;
        dockerValidationSummary = {
          totalTasks: tasks.length,
          tasksWithDocker: dvArr.filter((dv) => dv.profile !== "none").length,
          tasksValidated: dvArr.filter((dv) => dv.result === "pass" && dv.profile !== "none").length,
          tasksBlocked: dvArr.filter((dv) => dv.result === "blocked").length,
          tasksWithMocks: dvArr.filter((dv) => dv.profile === "none").length,
        };
      }
    }
  } catch {
    // No dockerValidation available
  }

  const replayArtifact = runArtifacts
    .filter((artifact) => artifact.kind === "replay-capsule")
    .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")))[0] ?? null;

  const auxiliaryByTaskId = new Map();
  for (const task of tasks) {
    const candidates = runArtifacts
      .filter((artifact) => artifact.task_id === task.task_id && artifact.kind === "handoff")
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
    for (const artifact of candidates) {
      try {
        const handoff = JSON.parse(await readFile(artifact.path, "utf8"));
        auxiliaryByTaskId.set(task.task_id, Array.isArray(handoff.auxiliaryInvocations) ? handoff.auxiliaryInvocations : []);
        break;
      } catch {}
    }
  }

  // Build a map of dockerValidation by taskId for quick lookup
  const dvByTaskId = new Map();
  for (const dv of dockerValidation) {
    dvByTaskId.set(dv.taskId, dv);
  }

  return {
    runId: run.run_id,
    request: run.request,
    status: run.status,
    runtimeDriver: run.runtime_driver ?? null,
    reconcileGeneration: Number(run.reconcile_generation ?? 0),
    taskCount: tasks.length,
    wallMs,
    totalTaskMs,
    speedup: wallMs > 0 ? totalTaskMs / wallMs : 0,
    peakParallel: Number(run.peak_parallel ?? 0),
    contextBytes,
    estimatedTokens,
    contextDocuments,
    usedDocuments,
    contextUtilization: knownUsageTasks > 0 && contextDocuments > 0 ? usedDocuments / contextDocuments : null,
    retries,
    conflicts: conflicts.length,
    findings: findings.length,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costUsd,
    stepLimitReached,
    continuation,
    performance,
    retryEvidence: performance.execution.retryEvidence,
    continuationDelivered: continuation?.deliveries?.filter((delivery) => delivery.status === "observed").length ?? 0,
    continuationSuppressedOrPending: continuation?.deliveries?.filter((delivery) => delivery.status !== "observed").length ?? 0,
    reasoningMode: run.reasoning_mode ?? null,
    reasoningSource: run.reasoning_source ?? null,
    initialReasoningLevel: run.initial_reasoning_level ?? null,
    reasoningConfidence: run.reasoning_confidence === null || run.reasoning_confidence === undefined ? null : Number(run.reasoning_confidence),
    reasoningPromotions: events.filter((event) => event.event_type === "reasoning.promoted").length,
    bootstrapReviewTopology: persistedPlan.workflow?.bootstrapReviewTopology ?? null,
    bootstrapFactTopology: persistedPlan.workflow?.bootstrapFactTopology ?? null,
    bootstrapTopologyState: persistedPlan.workflow?.bootstrapTopologyState ?? null,
    bootstrapTopologyRevision: Number(persistedPlan.workflow?.bootstrapTopologyRevision ?? 0),
    bootstrapTopologyAuthority: persistedPlan.workflow?.bootstrapTopologyAuthority ?? null,
    bootstrapFactBindings: Array.isArray(persistedPlan.workflow?.bootstrapFactBindings)
      ? persistedPlan.workflow.bootstrapFactBindings
      : [],
    bootstrapReviewDependencies: Array.isArray(persistedPlan.workflow?.bootstrapReviewDependencies)
      ? persistedPlan.workflow.bootstrapReviewDependencies
      : [],
    policy: {
      contractVersion: persistedPlan.policy?.contractVersion ?? null,
      fingerprint: persistedPlan.policy?.fingerprint ?? persistedPlan.provenance?.policyFingerprint ?? null,
      decisions: policyDecisions,
    },
    replay: replayArtifact ? {
      artifactId: replayArtifact.artifact_id,
      version: replayArtifact.version,
      path: replayArtifact.path,
      sha256: replayArtifact.sha256 ?? null,
      accepted: Boolean(replayArtifact.accepted),
    } : null,
    dagCompilation: dagCompilation ? {
      compileDurationMs: Number(dagCompilation.compileDurationMs ?? 0),
      materializationDurationMs: Number(dagCompilation.materializationDurationMs ?? 0),
      taskCount: Number(dagCompilation.taskCount ?? tasks.length),
    } : null,
    p50TaskMs: percentile(durations, 0.50),
    p95TaskMs: percentile(durations, 0.95),
    dockerValidationSummary,
    auxiliaryInvocationCount: [...auxiliaryByTaskId.values()].reduce((sum, items) => sum + items.length, 0),
    tasks: tasks.map((task) => {
      const dv = dvByTaskId.get(task.task_id);
      return {
        taskId: task.task_id,
        agentId: task.agent_id,
        status: task.status,
        attempt: task.attempt,
        dispatchGeneration: Number(task.dispatch_generation ?? 0),
        fencingToken: Number(task.fencing_token ?? 0),
        leaseOwner: task.lease_owner ?? null,
        leaseExpiresAt: task.lease_expires_at ?? null,
        cleanupState: task.cleanup_state ?? null,
        cleanupAttempts: Number(task.cleanup_attempts ?? 0),
        cleanupError: task.cleanup_error ?? null,
        durationMs: Number(task.duration_ms ?? 0),
        contextBytes: Number(task.context_bytes ?? 0),
        estimatedTokens: Number(task.estimated_tokens ?? 0),
        usedContextDocuments: task.used_context_documents,
        inputTokens: Number(task.input_tokens ?? 0),
        outputTokens: Number(task.output_tokens ?? 0),
        cachedInputTokens: Number(task.cached_input_tokens ?? 0),
        costUsd: Number(task.cost_usd ?? 0),
        modelId: task.model_id ?? null,
        modelVariant: task.model_variant ?? null,
        reasoningEffort: task.reasoning_effort ?? null,
        stepsLimit: task.steps_limit === null || task.steps_limit === undefined ? null : Number(task.steps_limit),
        stepsUsed: task.steps_used === null || task.steps_used === undefined ? null : Number(task.steps_used),
        stepLimitReached: task.step_limit_reached === true || Number(task.step_limit_reached ?? 0) === 1,
        stopReason: task.stop_reason ?? null,
        openCodeSessionId: task.opencode_session_id ?? null,
        auxiliaryInvocations: auxiliaryByTaskId.get(task.task_id) ?? [],
        reasoningLevel: task.reasoning_level ?? null,
        reasoningSource: task.reasoning_source ?? null,
        reasoningReasons: parseJsonArray(task.reasoning_reasons_json),
        errorCode: task.error_code,
        // Keep the terminal reason directly available in agent_summary. Detailed
        // Handoff evidence may still be content-addressed, but operators must not
        // depend on resolving a ctxref merely to learn why a task stopped.
        errorMessage: compactInlineError(task.error_message),
        dockerValidation: dv ? {
          profile: dv.profile,
          result: dv.result,
          services: dv.services,
          limitation: dv.limitation,
        } : undefined,
      };
    }),
  };
}

export async function buildSummary(store, runId = null) {
  const runs = runId ? [await store.getRun(runId)].filter(Boolean) : await store.listRuns(100);
  const details = await Promise.all(runs.map((run) => runMetrics(store, run)));
  const totalWallMs = details.reduce((sum, run) => sum + run.wallMs, 0);
  const totalTaskMs = details.reduce((sum, run) => sum + run.totalTaskMs, 0);
  const executionPlane = await store.runtimeWorkerHealth(
    Number(process.env.AGENT_HARNESS_RUNTIME_WORKER_HEARTBEAT_TIMEOUT_MS ?? 45_000),
  ).catch(() => ({ available: false, healthy: false, reason: "worker_health_unavailable" }));
  return {
    generatedAt: new Date().toISOString(),
    executionPlane,
    runCount: details.length,
    statusCounts: Object.fromEntries([...new Set(details.map((run) => run.status))].map((status) => [status, details.filter((run) => run.status === status).length])),
    totalContextBytes: details.reduce((sum, run) => sum + run.contextBytes, 0),
    totalEstimatedTokens: details.reduce((sum, run) => sum + run.estimatedTokens, 0),
    totalRetries: details.reduce((sum, run) => sum + run.retries, 0),
    totalConflicts: details.reduce((sum, run) => sum + run.conflicts, 0),
    totalReasoningPromotions: details.reduce((sum, run) => sum + run.reasoningPromotions, 0),
    totalInputTokens: details.reduce((sum, run) => sum + run.inputTokens, 0),
    totalOutputTokens: details.reduce((sum, run) => sum + run.outputTokens, 0),
    totalCachedInputTokens: details.reduce((sum, run) => sum + run.cachedInputTokens, 0),
    totalCostUsd: details.reduce((sum, run) => sum + run.costUsd, 0),
    totalStepLimitReached: details.reduce((sum, run) => sum + run.stepLimitReached, 0),
    totalAuxiliaryInvocations: details.reduce((sum, run) => sum + Number(run.auxiliaryInvocationCount ?? 0), 0),
    totalContinuationDeliveries: details.reduce((sum, run) => sum + Number(run.continuationDelivered ?? 0), 0),
    pendingContinuationDeliveries: details.reduce((sum, run) => sum + Number(run.continuationSuppressedOrPending ?? 0), 0),
    observedParallelSpeedup: totalWallMs > 0 ? totalTaskMs / totalWallMs : 0,
    runs: details,
  };
}

export function summaryMarkdown(summary) {
  const lines = [
    "# Resumo da operação multiagente",
    "",
    `Gerado em: ${summary.generatedAt}`,
    "",
    "## Visão geral",
    "",
    `- Runs: **${summary.runCount}**`,
    `- Contexto: **${summary.totalContextBytes.toLocaleString("pt-BR")} bytes** (~${summary.totalEstimatedTokens.toLocaleString("pt-BR")} tokens estimados)`,
    `- Retentativas: **${summary.totalRetries}**`,
    `- Conflitos: **${summary.totalConflicts}**`,
    `- Promoções de raciocínio: **${summary.totalReasoningPromotions}**`,
    `- Custo observado: **US$ ${summary.totalCostUsd.toFixed(4)}**`,
    `- Tokens observados: **${summary.totalInputTokens.toLocaleString("pt-BR")} input / ${summary.totalCachedInputTokens.toLocaleString("pt-BR")} cache-read / ${summary.totalOutputTokens.toLocaleString("pt-BR")} output**`,
    `- Limite de steps atingido: **${summary.totalStepLimitReached} task(s)**`,
    `- Chamadas estruturadas auxiliares: **${summary.totalAuxiliaryInvocations}**`,
    `- Continuações OpenCode observadas: **${summary.totalContinuationDeliveries}** (pendentes/manual-review/dead: ${summary.pendingContinuationDeliveries})`,
    `- Speedup observado: **${summary.observedParallelSpeedup.toFixed(2)}x**`,
    `- Execution plane Rust: **${summary.executionPlane?.healthy ? "healthy" : "unavailable/degraded"}**${summary.executionPlane?.worker_id ? ` (${summary.executionPlane.worker_id})` : ""}`,
    "",
    "## Runs",
    "",
    "| Run | Estado | Raciocínio inicial | Fonte | Tarefas | Duração | Pico paralelo | Speedup | Contexto | Retries | Promoções | Conflitos |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const run of summary.runs) {
    lines.push(`| ${run.runId} | ${run.status} | ${run.initialReasoningLevel ?? "—"} | ${run.reasoningSource ?? "—"} | ${run.taskCount} | ${formatDuration(run.wallMs)} | ${run.peakParallel} | ${run.speedup.toFixed(2)}x | ${run.contextBytes.toLocaleString("pt-BR")} B | ${run.retries} | ${run.reasoningPromotions} | ${run.conflicts} |`);
  }
  for (const run of summary.runs) {
    lines.push("", `### ${run.runId}`, "", run.request);
    if (run.bootstrapReviewTopology) {
      lines.push("", `- Bootstrap review topology: **${run.bootstrapReviewTopology}** / **${run.bootstrapFactTopology ?? "legacy"}**`);
      lines.push(`- Bootstrap topology authority: **${run.bootstrapTopologyAuthority ?? "unknown"}**, state **${run.bootstrapTopologyState ?? "unknown"}**, revision **${run.bootstrapTopologyRevision}**`);
      lines.push(`- Bootstrap fact bindings: **${run.bootstrapFactBindings.length}**`);
      if (run.bootstrapReviewDependencies.length === 0) {
        lines.push("- Bootstrap review decision edges: **none (safe fan-out)**");
      } else {
        lines.push(`- Bootstrap review decision edges: ${run.bootstrapReviewDependencies.map((edge) => `${edge.fromStage} → ${edge.toStage} [${edge.requiredDecision}]`).join("; ")}`);
      }
    }
    lines.push("", `- Runtime policy: **${run.policy.fingerprint ?? "unavailable"}** (${run.policy.decisions.length} decision receipts)`);
    lines.push(`- Replay capsule: **${run.replay?.path ?? "unavailable"}**`);
    if (run.dagCompilation) lines.push(`- DAG compiler: **${run.dagCompilation.compileDurationMs} ms** compile + **${run.dagCompilation.materializationDurationMs} ms** materialization`);
    lines.push("", "| Agente | Modelo | Estado | Reasoning | Tentativas | Steps | Custo | In/cache/out | Duração | Erro |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
    for (const task of run.tasks) {
      const steps = task.stepsUsed === null ? "—" : `${task.stepsUsed}/${task.stepsLimit ?? "?"}${task.stepLimitReached ? " ⚠" : ""}`;
      const tokenUsage = `${task.inputTokens}/${task.cachedInputTokens}/${task.outputTokens}`;
      lines.push(`| ${task.agentId} | ${task.modelId ?? "—"} | ${task.status} | ${task.reasoningEffort ?? task.reasoningLevel ?? "—"} | ${task.attempt} | ${steps} | US$ ${task.costUsd.toFixed(4)} | ${tokenUsage} | ${formatDuration(task.durationMs)} | ${task.errorCode ?? "—"} |`);
    }

    // Docker Validation section (per run)
    if (run.dockerValidationSummary) {
      const dv = run.dockerValidationSummary;
      lines.push(
        "",
        "### Validação Docker",
        "",
        `- Total de tasks: **${dv.totalTasks}**`,
        `- Tasks com perfil Docker: **${dv.tasksWithDocker}**`,
        `- Tasks validadas contra serviços reais: **${dv.tasksValidated}**`,
        `- Tasks bloqueadas (Docker indisponível / timeout): **${dv.tasksBlocked}**`,
        `- Tasks com perfil 'none' (apenas mocks): **${dv.tasksWithMocks}**`,
      );

      // Per-task Docker validation details
      const tasksWithDocker = run.tasks.filter((t) => t.dockerValidation);
      if (tasksWithDocker.length > 0) {
        lines.push(
          "",
          "| Task | Perfil | Resultado | Serviços | Limitação |",
          "|---|---|---|---|---|",
        );
        for (const task of tasksWithDocker) {
          const taskDv = task.dockerValidation;
          const resultIcon = taskDv.result === "pass" ? "✅ pass" : taskDv.result === "blocked" ? "🚫 blocked" : "❌ fail";
          const services = (taskDv.services && taskDv.services.length > 0) ? taskDv.services.join(", ") : "—";
          const limitation = taskDv.limitation ?? "—";
          lines.push(`| ${task.taskId} | ${taskDv.profile} | ${resultIcon} | ${services} | ${limitation} |`);
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
