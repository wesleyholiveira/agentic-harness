import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildContextPacket, buildTaskBrief } from "./context-builder.mjs";
import { resolveTaskExecutionTopology } from "./agent-topology.mjs";
import { resolveTaskReasoning } from "./reasoning.mjs";
import { runtimeTaskPaths, stableFingerprint } from "./event-driven-contracts.mjs";
import { exists, nowIso, readJson, sha256, writeJson } from "./utils.mjs";
import { resolveExecutionLivenessPolicy } from "./execution-liveness.mjs";
import { recordPolicyDecision } from "./policy-engine.mjs";
import { persistContextReady } from "./context-ready.mjs";
import { isResumableRepairCheckpoint, readRepairCheckpoint, repairCheckpointPathForHandoff } from "./repair-checkpoint.mjs";
import { prepareAgentInputManifest } from "./agent-input-preparation.mjs";
import { loadAndVerifyAgentInputManifest } from "./agent-input-manifest.mjs";

function commandFromTemplate(template, values) {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`executor_template_unknown_placeholder:${key}`);
    return JSON.stringify(String(values[key]));
  });
}


function parseCheckpointPayload(checkpoint) {
  const value = checkpoint?.payload_json ?? checkpoint?.payload ?? null;
  if (value && typeof value === "object") return value;
  try { return JSON.parse(String(value ?? "{}")); }
  catch { return {}; }
}

export function buildStaticContextReuseEvidence({ plan, taskPlan, contextBudgetBytes }) {
  return {
    projectId: `registry:${plan.provenance?.registryFingerprint ?? "unknown"}`,
    branch: `run:${plan.runId}`,
    stage: taskPlan.stage ?? "unknown",
    role: taskPlan.sddRole ?? taskPlan.role ?? "unknown",
    schemaVersion: Number(plan.schemaVersion ?? 0),
    revision: Number(plan.workflow?.implementationPlanRevision ?? plan.workflow?.bootstrapTopologyRevision ?? 1),
    fingerprint: stableFingerprint({
      requestFingerprint: plan.provenance?.requestFingerprint ?? null,
      taskId: taskPlan.taskId,
      dependencies: taskPlan.dependencies ?? [],
      ownedPaths: taskPlan.ownedPaths ?? [],
      contextBudgetBytes: Number(contextBudgetBytes ?? 0),
    }),
  };
}

function upstreamArtifactsFor(taskRow, artifacts) {
  const dependencies = new Set(JSON.parse(taskRow.dependencies_json ?? "[]"));
  return artifacts
    .filter((artifact) => dependencies.has(artifact.task_id) && Number(artifact.accepted) === 1)
    .map((artifact) => ({ artifactId: artifact.artifact_id, version: artifact.version, producer: artifact.task_id, path: artifact.path }));
}

export async function resolveProcessLossRepairResumeCandidate({ repositoryRoot, plan, taskPlan, taskRow }) {
  if (!taskRow || !["routed", "retrying"].includes(taskRow.status)) return null;
  if (String(taskRow.error_code ?? "") !== "execution_lease_expired") return null;
  const taskAttempt = Number(taskRow.attempt ?? 0);
  if (!Number.isInteger(taskAttempt) || taskAttempt < 1) return null;
  const fallbackPaths = runtimeTaskPaths({
    repositoryRoot,
    runId: plan.runId,
    taskId: taskPlan.taskId,
    agentId: taskPlan.agentId,
    attempt: taskAttempt,
  });
  const handoffPath = taskRow.handoff_path || fallbackPaths.handoffPath;
  const checkpointPath = repairCheckpointPathForHandoff(handoffPath);
  const checkpoint = await readRepairCheckpoint(checkpointPath, {
    runId: plan.runId,
    taskId: taskPlan.taskId,
    taskAttempt,
  });
  if (!isResumableRepairCheckpoint(checkpoint)) return null;
  return {
    taskAttempt,
    handoffPath,
    checkpointPath,
    checkpoint,
    checkpointStatus: checkpoint.status,
    checkpointEffectKey: checkpoint.effectKey ?? null,
    sourceDispatchGeneration: Number(taskRow.dispatch_generation ?? 0),
    sourceFencingToken: Number(taskRow.fencing_token ?? 0),
    nextDispatchGeneration: Number(taskRow.dispatch_generation ?? 0) + 1,
    nextFencingToken: Number(taskRow.fencing_token ?? 0) + 1,
  };
}

async function reuseProcessLossPreparation({ taskRow, repairResume, attempt, schemas }) {
  if (!repairResume || !taskRow.brief_path || !taskRow.context_path || !taskRow.input_manifest_path) return null;
  if (!(await exists(taskRow.brief_path)) || !(await exists(taskRow.context_path)) || !(await exists(taskRow.input_manifest_path))) return null;
  try {
    const [brief, packet, manifest] = await Promise.all([
      readJson(taskRow.brief_path),
      readJson(taskRow.context_path),
      loadAndVerifyAgentInputManifest(taskRow.input_manifest_path, schemas?.agentInputManifest ?? null),
    ]);
    if (brief?.runId !== repairResume.checkpoint.runId || brief?.taskId !== repairResume.checkpoint.taskId) return null;
    if (Number(brief?.modelRouting?.attempt ?? 0) !== Number(attempt)) return null;
    if (manifest.runId !== brief.runId || manifest.taskId !== brief.taskId || Number(manifest.attempt) !== Number(attempt)) return null;
    if (taskRow.input_manifest_fingerprint && manifest.manifestFingerprint !== taskRow.input_manifest_fingerprint) {
      throw new Error(`agent_input_manifest_replacement_fingerprint_mismatch:${taskRow.input_manifest_fingerprint}:${manifest.manifestFingerprint}`);
    }
    return {
      brief, packet, briefPath: taskRow.brief_path, contextPath: taskRow.context_path,
      manifest, manifestPath: taskRow.input_manifest_path, manifestFingerprint: manifest.manifestFingerprint,
    };
  } catch (error) {
    if (String(error?.message ?? "").startsWith("agent_input_manifest_")) throw error;
    return null;
  }
}

export async function prefetchTaskPreparation({ repositoryRoot, plan, taskPlan, registry, schemas, store, options }) {
  const taskRow = await store.getTask(taskPlan.taskId);
  if (!taskRow || !["routed", "retrying"].includes(taskRow.status)) return { prefetched: false, reason: `status:${taskRow?.status ?? "missing"}` };
  const expectedReuseEvidence = buildStaticContextReuseEvidence({ plan, taskPlan, contextBudgetBytes: Math.max(10_000, Math.round(options.contextBudgetBytes * 0.65)) });
  const existingCheckpoint = await store.latestCheckpoint(taskPlan.taskId, "context.static.ready");
  if (existingCheckpoint) {
    if (!options.policyEngine) return { prefetched: false, reason: "already-prefetched" };
    const candidateReuseEvidence = parseCheckpointPayload(existingCheckpoint).reuseEvidence ?? null;
    const reuseDecision = options.policyEngine.evaluateReuse({ expected: expectedReuseEvidence, candidate: candidateReuseEvidence });
    await recordPolicyDecision(store, { runId: plan.runId, taskId: taskPlan.taskId, operation: "reuse", decision: reuseDecision });
    if (reuseDecision.allowed) return { prefetched: false, reason: "already-prefetched", policyDecision: reuseDecision };
    await store.event(plan.runId, taskPlan.taskId, "checkpoint.reuse_rejected", {
      checkpointId: existingCheckpoint.checkpoint_id ?? null,
      checkpointType: "context.static.ready",
      policyCode: reuseDecision.code,
    });
  }

  const reasoning = await resolveTaskReasoning({
    plan,
    taskPlan,
    taskRow,
    store,
    baseContextBudgetBytes: Math.max(10_000, Math.round(options.contextBudgetBytes * 0.65)),
  });
  // Static prefetch intentionally excludes upstream handoffs. Its purpose is to
  // warm Context Engine/CBM/reference caches; the final packet is rebuilt after
  // dependencies integrate.
  const { packet, metrics: contextMetrics } = await buildContextPacket({
    repositoryRoot,
    registry,
    plan,
    task: taskPlan,
    schemas,
    budgetBytes: reasoning.contextBudgetBytes,
    upstreamArtifacts: [],
    contextProvider: options.contextProvider ?? null,
  });
  const paths = runtimeTaskPaths({ repositoryRoot, runId: plan.runId, taskId: taskPlan.taskId, agentId: taskPlan.agentId, attempt: reasoning.attempt });
  await mkdir(paths.taskDirectory, { recursive: true });
  const prefetchPath = join(paths.taskDirectory, "context-prefetch.json");
  await writeJson(prefetchPath, packet);
  await mkdir(paths.workspacePath, { recursive: true });
  const fingerprint = stableFingerprint({ packetId: packet.packetId, references: packet.references.map((reference) => [reference.path, reference.sha256]) });
  await store.writeCheckpoint({
    runId: plan.runId,
    taskId: taskPlan.taskId,
    type: "context.static.ready",
    attempt: 0,
    fingerprint,
    reusable: true,
    payload: { path: prefetchPath, packId: packet.contextEngine?.packId ?? null, usedBytes: packet.usedBytes, reuseEvidence: expectedReuseEvidence },
  });
  await store.writeCheckpoint({
    runId: plan.runId,
    taskId: taskPlan.taskId,
    type: "workspace.scaffold.ready",
    attempt: 0,
    reusable: true,
    payload: { path: paths.workspacePath, sourceSnapshotDeferred: true },
  });
  await store.writeCheckpoint({
    runId: plan.runId,
    taskId: taskPlan.taskId,
    type: "model.preflight.ready",
    attempt: 0,
    reusable: true,
    payload: { agentId: taskPlan.agentId, reasoningLevel: reasoning.level },
  });
  await store.event(plan.runId, taskPlan.taskId, "task.prefetch.ready", {
    path: prefetchPath,
    sourceSnapshotDeferred: true,
    attempt: 0,
    runtimeBudgetBytes: reasoning.contextBudgetBytes,
    runtimeBudgetTokensEstimate: contextMetrics?.runtimeBudgetTokensEstimate ?? Math.ceil(reasoning.contextBudgetBytes / 4),
    packetEstimatedTokens: packet.estimatedTokens,
    contextEngineStatus: packet.contextEngine?.status ?? "unknown",
    cacheStatus: packet.contextEngine?.cacheStatus ?? null,
    packId: packet.contextEngine?.packId ?? null,
    contextEngineMetrics: contextMetrics?.contextEngine ?? null,
  });
  return { prefetched: true, path: prefetchPath, fingerprint };
}

export async function prepareTaskExecution({ repositoryRoot, plan, taskPlan, registry, schemas, store, options }) {
  const taskRow = await store.getTask(taskPlan.taskId);
  if (!taskRow) throw new Error(`task_not_found:${taskPlan.taskId}`);
  const repairResume = await resolveProcessLossRepairResumeCandidate({ repositoryRoot, plan, taskPlan, taskRow });
  const reasoning = await resolveTaskReasoning({
    plan,
    taskPlan,
    taskRow,
    store,
    baseContextBudgetBytes: options.contextBudgetBytes,
    attemptOverride: repairResume?.taskAttempt ?? null,
  });
  const attempt = reasoning.attempt;
  const executionMode = taskPlan.executionMode ?? "agent";
  await store.event(plan.runId, taskPlan.taskId, "task.preparation.started", {
    attempt, executionMode, repairResume: Boolean(repairResume),
  });
  const reusedPreparation = await reuseProcessLossPreparation({ taskRow, repairResume, attempt, schemas });
  if (repairResume && !reusedPreparation) {
    throw new Error(`agent_input_manifest_replacement_missing:${plan.runId}:${taskPlan.taskId}:${attempt}`);
  }
  let packet;
  let contextPath;
  let contextMetrics = null;
  let brief;
  let briefPath;
  let manifest;
  let manifestPath;
  let manifestFingerprint;
  let upstreamEvidencePath = null;
  let fullArtifacts = [];
  if (reusedPreparation) {
    ({ packet, contextPath, brief, briefPath, manifest, manifestPath, manifestFingerprint } = reusedPreparation);
  } else {
    const artifacts = await store.listArtifacts(plan.runId);
    const upstreamArtifacts = upstreamArtifactsFor(taskRow, artifacts);
    const context = await buildContextPacket({
      repositoryRoot, registry, plan, task: taskPlan, schemas,
      budgetBytes: reasoning.contextBudgetBytes,
      upstreamArtifacts,
      contextProvider: options.contextProvider ?? null,
    });
    packet = context.packet;
    contextPath = context.path;
    contextMetrics = context.metrics;
    upstreamEvidencePath = context.upstreamEvidencePath ?? null;
    fullArtifacts = context.fullArtifacts ?? [];
    const taskBrief = await buildTaskBrief({
      repositoryRoot, registry, plan, task: taskPlan, contextPacket: packet, schemas,
      maxAttempts: options.maxAttempts, reasoning,
    });
    brief = taskBrief.brief;
    briefPath = taskBrief.path;
  }
  const executionTopology = resolveTaskExecutionTopology(brief);
  const paths = runtimeTaskPaths({ repositoryRoot, runId: plan.runId, taskId: taskPlan.taskId, agentId: taskPlan.agentId, attempt });
  await mkdir(paths.taskDirectory, { recursive: true });
  if (!reusedPreparation) {
    const preparedInput = await prepareAgentInputManifest({
      repositoryRoot,
      taskDirectory: paths.taskDirectory,
      runId: plan.runId,
      taskId: taskPlan.taskId,
      agentId: taskPlan.agentId,
      attempt,
      stage: taskPlan.stage,
      brief,
      briefPath,
      contextPath,
      contextMetrics,
      upstreamEvidencePath,
      upstreamArtifactCount: packet.upstreamArtifacts?.length ?? 0,
      fullArtifacts,
      registry: registry.document ?? registry,
      schemas,
    });
    manifest = preparedInput.manifest;
    manifestPath = preparedInput.path;
    manifestFingerprint = manifest.manifestFingerprint;
    await store.writeCheckpoint({
      runId: plan.runId, taskId: taskPlan.taskId, type: "agent-input.manifest.ready", attempt,
      fingerprint: manifestFingerprint, reusable: true,
      payload: { contractVersion: "agent-input-manifest-receipt/v1", manifestPath, manifestFingerprint, attempt },
    });
    await store.event(plan.runId, taskPlan.taskId, "agent_input.manifest_ready", {
      attempt, manifestPath, manifestFingerprint, accounting: manifest.accounting,
      inventory: (manifest.entries ?? []).map((entry) => ({
        entryId: entry.entryId, category: entry.category, authorityClass: entry.authorityClass, deliveryMode: entry.deliveryMode,
        contentHash: entry.contentHash, estimatedTokens: entry.estimatedTokens, rawTokens: entry.rawTokens ?? entry.estimatedTokens,
        artifactRef: entry.artifactRef ?? null,
      })),
    });
  } else {
    await store.writeCheckpoint({
      runId: plan.runId, taskId: taskPlan.taskId, type: "agent-input.manifest.reused", attempt,
      dispatchGeneration: repairResume.nextDispatchGeneration, fencingToken: repairResume.nextFencingToken,
      fingerprint: manifestFingerprint, reusable: true,
      payload: {
        contractVersion: "agent-input-manifest-reuse-receipt/v1",
        manifestPath, manifestFingerprint, sameSemanticAttempt: true, skippedManifestRebuild: true,
        sourceDispatchGeneration: repairResume.sourceDispatchGeneration,
        replacementDispatchGeneration: repairResume.nextDispatchGeneration,
        sourceFencingToken: repairResume.sourceFencingToken,
        replacementFencingToken: repairResume.nextFencingToken,
      },
    });
    await store.event(plan.runId, taskPlan.taskId, "agent_input.manifest_reused", {
      attempt, manifestPath, manifestFingerprint, sameSemanticAttempt: true, skippedManifestRebuild: true,
      dispatchGeneration: repairResume.nextDispatchGeneration, fencingToken: repairResume.nextFencingToken,
    });
  }
  // The event-driven execution plane owns the mutable workspace lifecycle. The
  // semantic controller prepares only an ID/path descriptor; Rust snapshots the
  // repository after dependencies integrate and writes the baseline before spawn.
  const workspaceMode = options.workspaceMode === "none" ? "none" : "copy";
  const executionWorkspacePath = workspaceMode === "none" ? repositoryRoot : paths.workspacePath;

  const executorTemplate = executionMode === "deterministic-reuse"
    ? `${JSON.stringify(process.execPath)} ${JSON.stringify(join(options.harnessRoot ?? process.env.AGENT_HARNESS_ROOT ?? repositoryRoot, "scripts", "internal", "deterministic-reuse-executor.mjs"))} --agent-input-manifest {agentInputManifest} --task-brief {taskBrief} --workspace {workspace} --handoff {handoff} --agent-id {agentId}`
    : options.executorCommand;
  const command = commandFromTemplate(executorTemplate, {
    agentId: taskPlan.agentId,
    runId: plan.runId,
    taskId: taskPlan.taskId,
    taskBrief: briefPath,
    contextPacket: contextPath,
    agentInputManifest: manifestPath,
    workspace: executionWorkspacePath,
    handoff: paths.handoffPath,
    repository: repositoryRoot,
    reasoningLevel: reasoning.level,
    reasoningMode: reasoning.mode,
    reasoningSource: reasoning.source,
    model: brief.modelRouting.model,
    variant: brief.modelRouting.variant ?? "",
    reasoningEffort: brief.modelRouting.reasoningEffort,
    stepsLimit: brief.modelRouting.stepsLimit,
  });
  const executionLiveness = resolveExecutionLivenessPolicy({
    task: taskPlan,
    attempt,
    hardTimeoutMs: options.taskTimeoutMs,
  });
  await store.event(plan.runId, taskPlan.taskId, "execution.liveness_policy.selected", {
    attempt,
    ...executionLiveness,
  });

  const descriptor = {
    schemaVersion: "agent-execution-descriptor/v1",
    createdAt: nowIso(),
    runId: plan.runId,
    taskId: taskPlan.taskId,
    agentId: taskPlan.agentId,
    attempt,
    dispatchGeneration: Number(taskRow.dispatch_generation ?? 0) + 1,
    fencingToken: Number(taskRow.fencing_token ?? 0) + 1,
    executionMode,
    requestedModel: brief.modelRouting,
    executionTopology,
    repositoryRoot,
    taskBriefPath: briefPath,
    contextPacketPath: contextPath,
    agentInputManifestPath: manifestPath,
    agentInputManifestFingerprint: manifestFingerprint,
    handoffPath: paths.handoffPath,
    logPath: paths.logPath,
    resultPath: paths.resultPath,
    changeSetPath: paths.changeSetPath,
    workspace: {
      requestedMode: options.workspaceMode,
      mode: workspaceMode,
      materializer: "rust",
      path: executionWorkspacePath,
      baselinePath: paths.baselinePath,
      sourceRoot: repositoryRoot,
      ownedPaths: taskPlan.ownedPaths ?? [],
      dependencies: taskPlan.dependencies ?? [],
    },
    process: {
      command,
      timeoutMs: executionLiveness.hardTimeoutMs,
      softTimeoutMs: executionLiveness.softTimeoutMs,
      stallTimeoutMs: executionLiveness.stallTimeoutMs,
      livenessPolicy: executionLiveness.policy,
      env: {
        AGENT_HARNESS_AGENT_ID: taskPlan.agentId,
        AGENT_HARNESS_AGENT_RUN_ID: plan.runId,
        AGENT_HARNESS_AGENT_TASK_ID: taskPlan.taskId,
        AGENT_HARNESS_AGENT_TASK_ATTEMPT: String(attempt),
        AGENT_HARNESS_AGENT_EXECUTION_MODE: executionMode,
        AGENT_HARNESS_AGENT_DISPATCH_GENERATION: String(Number(taskRow.dispatch_generation ?? 0) + 1),
        AGENT_HARNESS_AGENT_FENCING_TOKEN: String(Number(taskRow.fencing_token ?? 0) + 1),
        AGENT_HARNESS_AGENT_TASK_BRIEF: briefPath,
        AGENT_HARNESS_AGENT_CONTEXT_PACKET: contextPath,
        AGENT_HARNESS_AGENT_INPUT_MANIFEST: manifestPath,
        AGENT_HARNESS_AGENT_INPUT_MANIFEST_FINGERPRINT: manifestFingerprint,
        AGENT_HARNESS_AGENT_HANDOFF: paths.handoffPath,
        AGENT_HARNESS_AGENT_WORKSPACE: executionWorkspacePath,
        AGENT_HARNESS_AGENT_REASONING_LEVEL: reasoning.level,
        AGENT_HARNESS_AGENT_REASONING_MODE: reasoning.mode,
        AGENT_HARNESS_AGENT_REASONING_SOURCE: reasoning.source,
        AGENT_HARNESS_AGENT_MODEL: brief.modelRouting.model,
        AGENT_HARNESS_AGENT_MODEL_VARIANT: brief.modelRouting.variant ?? "",
        AGENT_HARNESS_AGENT_REASONING_EFFORT: brief.modelRouting.reasoningEffort,
        AGENT_HARNESS_AGENT_STEPS_LIMIT: String(brief.modelRouting.stepsLimit),
        AGENT_HARNESS_AGENT_ORCHESTRATION_ROLE: executionTopology.orchestrationRole,
        AGENT_HARNESS_AGENT_INTERACTIVE_MODE: executionTopology.interactiveMode,
        AGENT_HARNESS_AGENT_SESSION_ROLE: executionTopology.sessionRole,
      },
    },
  };
  await writeJson(paths.descriptorPath, descriptor);
  const descriptorSha = sha256(await readFile(paths.descriptorPath));
  await store.updateTask(taskPlan.taskId, {
    brief_path: briefPath,
    context_path: contextPath,
    input_manifest_path: manifestPath,
    input_manifest_fingerprint: manifestFingerprint,
    handoff_path: paths.handoffPath,
    workspace_path: paths.workspacePath,
    execution_descriptor_path: paths.descriptorPath,
    context_bytes: packet.usedBytes,
    context_documents: packet.references.filter((reference) => reference.included).length,
    estimated_tokens: packet.estimatedTokens,
    model_id: brief.modelRouting.model,
    model_variant: brief.modelRouting.variant ?? null,
    reasoning_effort: brief.modelRouting.reasoningEffort,
    steps_limit: brief.modelRouting.stepsLimit,
    reasoning_level: reasoning.level,
    reasoning_source: reasoning.source,
    reasoning_reasons_json: JSON.stringify(reasoning.reasons),
  });
  await store.event(plan.runId, taskPlan.taskId, "reasoning.selected", reasoning);
  if (reasoning.level !== reasoning.baseLevel) await store.event(plan.runId, taskPlan.taskId, "reasoning.promoted", { from: reasoning.baseLevel, to: reasoning.level, reasons: reasoning.reasons, attempt });
  await store.event(plan.runId, taskPlan.taskId, "model.route.selected", { ...brief.modelRouting, executionMode });
  await store.event(plan.runId, taskPlan.taskId, "execution.mode.selected", { attempt, executionMode, fullAgentInvocation: executionMode !== "deterministic-reuse" });
  await store.event(plan.runId, taskPlan.taskId, "execution.topology.selected", { ...executionTopology, attempt, executionMode });
  if (!reusedPreparation) {
    await persistContextReady({
      store,
      runId: plan.runId,
      taskId: taskPlan.taskId,
      attempt: reasoning.attempt,
      packId: packet.contextEngine?.packId ?? null,
      packetId: packet.packetId ?? null,
      payload: {
        attempt: reasoning.attempt,
        bytes: packet.usedBytes,
        documents: packet.references.length,
        included: packet.references.filter((reference) => reference.included).length,
        packetEstimatedTokens: packet.estimatedTokens,
        runtimeBudgetBytes: contextMetrics?.runtimeBudgetBytes ?? reasoning.contextBudgetBytes,
        runtimeBudgetTokensEstimate: contextMetrics?.runtimeBudgetTokensEstimate ?? Math.ceil(reasoning.contextBudgetBytes / 4),
        contextEngineStatus: packet.contextEngine?.status ?? "unknown",
        cacheStatus: packet.contextEngine?.cacheStatus ?? null,
        packId: packet.contextEngine?.packId ?? null,
        contextEngineMetrics: contextMetrics?.contextEngine ?? null,
      },
    });
    await store.writeCheckpoint({
      runId: plan.runId, taskId: taskPlan.taskId, type: "context.final.ready", attempt,
      fingerprint: stableFingerprint({ packetId: packet.packetId, upstreamArtifacts: packet.upstreamArtifacts }),
      reusable: false, payload: { path: contextPath, packetId: packet.packetId },
    });
    await store.writeCheckpoint({
      runId: plan.runId, taskId: taskPlan.taskId, type: "task-brief.ready", attempt,
      fingerprint: stableFingerprint({ modelRouting: brief.modelRouting, dependencies: brief.dependencies, acceptanceCriteria: brief.acceptanceCriteria }),
      reusable: false, payload: { path: briefPath },
    });
  }
  if (repairResume) {
    const effectKey = stableFingerprint({
      runId: plan.runId,
      taskId: taskPlan.taskId,
      taskAttempt: attempt,
      dispatchGeneration: repairResume.nextDispatchGeneration,
      fencingToken: repairResume.nextFencingToken,
      eventType: "repair.replacement_execution_prepared",
    });
    const payload = {
      taskAttempt: attempt,
      sourceTaskAttempt: repairResume.taskAttempt,
      preservedSemanticAttempt: true,
      checkpointStatus: repairResume.checkpointStatus,
      checkpointEffectKey: repairResume.checkpointEffectKey,
      sourceDispatchGeneration: repairResume.sourceDispatchGeneration,
      dispatchGeneration: repairResume.nextDispatchGeneration,
      sourceFencingToken: repairResume.sourceFencingToken,
      fencingToken: repairResume.nextFencingToken,
      preparationReused: Boolean(reusedPreparation),
      effectKey,
    };
    if (typeof store.eventOnce === "function") await store.eventOnce(plan.runId, taskPlan.taskId, "repair.replacement_execution_prepared", payload, effectKey);
    else await store.event(plan.runId, taskPlan.taskId, "repair.replacement_execution_prepared", payload);
  }
  await store.event(plan.runId, taskPlan.taskId, "execution.descriptor.ready", {
    descriptorPath: paths.descriptorPath,
    descriptorSha256: descriptorSha,
    attempt,
    modelId: brief.modelRouting.model,
    orchestrationRole: executionTopology.orchestrationRole,
    interactiveMode: executionTopology.interactiveMode,
    sessionRole: executionTopology.sessionRole,
    executionMode,
  });
  return { descriptor, descriptorPath: paths.descriptorPath, descriptorSha, brief, packet, reasoning, repairResume, preparationReused: Boolean(reusedPreparation) };
}

export async function descriptorStillValid(descriptorPath) {
  return await exists(descriptorPath);
}
