import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertSchema } from "./schema-validator.mjs";
import { anyPatternMatches, estimateTokens, exists, newId, nowIso, sha256, writeJson, readJson, runtimeTaskDirectoryName } from "./utils.mjs";
import { resolveModelRoute } from "./model-router.mjs";
import { taskExecutionTopologyForAgent } from "./agent-topology.mjs";
import { assertExecutableValidationCommands } from "./validation-command.mjs";
import { authoritativeReviewRevisionFromContext, isSddReviewStage } from "./review-contract.mjs";
import { isBootstrapReviewStage } from "./bootstrap-capabilities.mjs";
import { projectHandoffEvidence, writeContentAddressedArtifact } from "./agent-input-manifest.mjs";

async function nearestAgentsFile(repositoryRoot, pathPattern) {
  const clean = pathPattern.replace(/\*.*$/, "").replace(/\/$/, "");
  let current = join(repositoryRoot, clean || ".");
  if (!(await exists(current))) current = dirname(current);
  while (current.startsWith(repositoryRoot)) {
    const candidate = join(current, "AGENTS.md");
    if (await exists(candidate)) return candidate;
    if (current === repositoryRoot) break;
    current = dirname(current);
  }
  return join(repositoryRoot, "AGENTS.md");
}

async function addReference({ repositoryRoot, references, seen, path, kind, budget, used, includeContent = true, reason = "" }) {
  if (!path) return used;
  const absolute = path.startsWith(repositoryRoot) ? path : join(repositoryRoot, path);
  if (!(await exists(absolute))) return used;
  const relative = absolute.slice(repositoryRoot.length + 1).replaceAll("\\", "/");
  if (seen.has(relative)) return used;
  seen.add(relative);
  const content = await readFile(absolute, "utf8");
  const bytes = Buffer.byteLength(content);
  const included = includeContent && used + bytes <= budget;
  references.push({ path: relative, kind, sha256: sha256(content), bytes, included, ...(included ? { content } : {}), ...(reason ? { reason } : {}) });
  return included ? used + bytes : used;
}


function isRetryableSemanticDependencyError(error) {
  return Boolean(
    error
    && typeof error === "object"
    && error.code === "context_semantic_dependency_unavailable"
    && error.retryable === true
  );
}

function rethrowRetryableContextDependency(error) {
  if (!isRetryableSemanticDependencyError(error)) return false;
  const wrapped = new Error(error.message);
  wrapped.code = error.code;
  wrapped.retryable = true;
  wrapped.category = error.category ?? "context-infrastructure";
  wrapped.dependency = error.dependency ?? "unknown";
  wrapped.causeCode = error.causeCode ?? null;
  throw wrapped;
}

async function getContextEnginePack({ contextProvider, task, budgetBytes }) {
  if (typeof contextProvider !== "function") {
    return { status: "degraded", packId: null, cacheStatus: null, payload: null, error: "context_provider_unavailable", metrics: null };
  }
  const budgetTokens = Math.max(2_000, Math.round(budgetBytes / 4));
  try {
    const result = await contextProvider({
      task: `${task.objective}\nAcceptance criteria: ${(task.acceptanceCriteria ?? []).map((item) => `${item.id}: ${item.statement}`).join(" | ")}`,
      budgetTokens,
      mode: "compact",
      role: task.sddRole ?? task.role ?? task.agentId ?? "generic",
      stage: task.stage ?? "generic",
    });
    if (!result || result.status !== "ok") {
      return { status: "degraded", packId: null, cacheStatus: null, payload: null, error: result?.error ?? "context_provider_failed", metrics: null };
    }
    return {
      status: "ok",
      packId: result.packId ?? null,
      cacheStatus: result.cacheStatus ?? null,
      payload: result.payload ?? null,
      error: null,
      metrics: result.metrics ?? null,
    };
  } catch (error) {
    rethrowRetryableContextDependency(error);
    return { status: "degraded", packId: null, cacheStatus: null, payload: null, error: `context_provider_failed:${error.message}`, metrics: null };
  }
}

function wireUpstreamProjection(artifact) {
  const content = artifact?.content ?? null;
  if (!content) return artifact;
  const acceptanceCriterionIds = (content.acceptanceCriteria ?? []).map((criterion) => criterion?.id).filter(Boolean);
  const { acceptanceCriteria: _acceptanceCriteria, ...rest } = content;
  return {
    ...artifact,
    content: { ...rest, acceptanceCriterionIds },
  };
}

async function projectUpstreamArtifacts({ repositoryRoot, plan, task, upstreamArtifacts }) {
  const projected = [];
  const fullArtifacts = [];
  const taskDirectory = join(repositoryRoot, ".runtime", "agents", "runs", plan.runId, "tasks", runtimeTaskDirectoryName(task.taskId, task.agentId));
  for (const artifact of upstreamArtifacts) {
    try {
      const content = await readJson(artifact.path);
      const fullArtifact = await writeContentAddressedArtifact({
        repositoryRoot,
        taskDirectory,
        value: content,
        sourceRef: artifact.path,
        mediaType: "application/json",
        maxBytes: 2_000_000,
      });
      fullArtifacts.push({ ...fullArtifact, producer: artifact.producer, artifactId: artifact.artifactId, version: artifact.version });
      projected.push({
        artifactId: artifact.artifactId,
        version: artifact.version,
        producer: artifact.producer,
        path: artifact.path,
        content: projectHandoffEvidence({ artifact, content, fullArtifact }),
      });
    } catch {
      projected.push({ ...artifact, content: null });
    }
  }
  return { projected, fullArtifacts };
}

function normalizedPaths(values) {
  return [...new Set((values ?? []).map((value) => String(value).replaceAll("\\", "/")).filter(Boolean))].sort();
}

export function buildAcceptedDependencyChangeProvenance({ plan, contextPacket }) {
  const taskById = new Map((plan?.tasks ?? []).map((item) => [item.taskId, item]));
  const entries = (contextPacket?.upstreamArtifacts ?? []).map((artifact) => {
    const task = taskById.get(artifact.producer) ?? null;
    const content = artifact.content ?? {};
    return {
      taskId: String(artifact.producer ?? ""),
      agentId: task?.agentId ?? content.agentId ?? null,
      role: task?.role ?? null,
      stage: task?.stage ?? content.sddReview?.stage ?? null,
      artifactId: artifact.artifactId ?? null,
      artifactVersion: artifact.version ?? content.artifactVersion ?? null,
      changedPaths: normalizedPaths(content.changedPaths),
      reusedPaths: normalizedPaths(content.reusedPaths),
      usedContextPaths: normalizedPaths(content.usedContextPaths),
    };
  }).filter((entry) => entry.taskId);
  const implementationEntries = entries.filter((entry) => entry.role === "implementation");
  return {
    authority: "runtime-accepted-dependency-handoffs",
    scope: "direct-dependencies",
    preexistingWorkingTreeIsNotAttributed: true,
    entries,
    implementationChangedPaths: normalizedPaths(implementationEntries.flatMap((entry) => entry.changedPaths)),
    implementationReusedPaths: normalizedPaths(implementationEntries.flatMap((entry) => entry.reusedPaths)),
  };
}

export async function buildContextPacket({ repositoryRoot, registry, plan, task, schemas, budgetBytes = 120_000, upstreamArtifacts = [], contextProvider = null }) {
  const agent = registry.byId.get(task.agentId);
  if (!agent) throw new Error(`agent_not_found:${task.agentId}`);
  const references = [];
  const seen = new Set();
  let usedBytes = 0;
  // R16: AGENTS, agent manifests and skills are already supplied by the OpenCode
  // agent/session boundary. Repeating their bodies inside the Context Packet
  // creates model-wire duplication, so the Runtime Context Packet owns only
  // retrieved repository context and exact source/doc references.
  // Required docs are references only when the Context Engine can retrieve/cache them; inline fallback is preserved for degraded mode below.
  const contextEngine = await getContextEnginePack({ contextProvider, task, budgetBytes });
  if (contextEngine.status === "degraded") {
    for (const doc of agent.requiredDocs ?? []) usedBytes = await addReference({ repositoryRoot, references, seen, path: doc, kind: "canonical-doc", budget: budgetBytes, used: usedBytes, reason: "context-engine degraded fallback" });
  } else {
    for (const doc of agent.requiredDocs ?? []) usedBytes = await addReference({ repositoryRoot, references, seen, path: doc, kind: "canonical-doc", budget: budgetBytes, used: usedBytes, includeContent: false, reason: "retrievable via context-engine compact refs" });
  }
  usedBytes = await addReference({ repositoryRoot, references, seen, path: `.runtime/agents/runs/${plan.runId}/${plan.phase === "compiled" ? "refined-dag.json" : "execution-plan.json"}`, kind: "plan", budget: budgetBytes, used: usedBytes, reason: "current execution DAG" });
  for (const ownedPath of task.ownedPaths ?? []) {
    if (ownedPath.includes("*") || !(await exists(join(repositoryRoot, ownedPath)))) continue;
    usedBytes = await addReference({ repositoryRoot, references, seen, path: ownedPath, kind: ownedPath.includes("test") ? "test" : "source", budget: budgetBytes, used: usedBytes, includeContent: false, reason: "critical path; inspect progressively" });
  }
  const contextEngineMetrics = contextEngine.metrics ?? null;
  const contextEnginePacket = {
    status: contextEngine.status,
    packId: contextEngine.packId,
    cacheStatus: contextEngine.cacheStatus,
    payload: contextEngine.payload,
    error: contextEngine.error,
  };
  const contextEngineBytes = contextEngine.payload ? Buffer.byteLength(JSON.stringify(contextEngine.payload)) : 0;
  const upstream = await projectUpstreamArtifacts({ repositoryRoot, plan, task, upstreamArtifacts });
  const enrichedUpstreamArtifacts = upstream.projected;
  const upstreamBytes = Buffer.byteLength(JSON.stringify(enrichedUpstreamArtifacts));
  const taskDirectory = join(repositoryRoot, ".runtime", "agents", "runs", plan.runId, "tasks", runtimeTaskDirectoryName(task.taskId, task.agentId));
  const upstreamEvidencePath = join(taskDirectory, "upstream-evidence.json");
  await writeJson(upstreamEvidencePath, { contractVersion: "agent-upstream-evidence-projection/v1", artifacts: enrichedUpstreamArtifacts.map(wireUpstreamProjection) });
  const packet = {
    schemaVersion: 2,
    packetId: newId("context"), runId: plan.runId, taskId: task.taskId, agentId: task.agentId, createdAt: nowIso(), budgetBytes,
    usedBytes: usedBytes + contextEngineBytes + upstreamBytes,
    estimatedTokens: estimateTokens(usedBytes + contextEngineBytes + upstreamBytes),
    references, upstreamArtifacts: enrichedUpstreamArtifacts, upstreamEvidenceRef: "upstream-evidence.json", contextEngine: contextEnginePacket,
  };
  assertSchema(packet, schemas.contextPacket, "contextPacket");
  const path = join(taskDirectory, "context-packet.json");
  const wirePacket = {
    ...packet,
    upstreamArtifacts: [],
    usedBytes: usedBytes + contextEngineBytes,
    estimatedTokens: estimateTokens(usedBytes + contextEngineBytes),
  };
  assertSchema(wirePacket, schemas.contextPacket, "contextPacketWire");
  await writeJson(path, wirePacket);
  return {
    packet,
    wirePacket,
    path,
    upstreamEvidencePath,
    metrics: {
      runtimeBudgetBytes: budgetBytes,
      runtimeBudgetTokensEstimate: Math.ceil(Math.max(0, budgetBytes) / 4),
      contextEngine: contextEngineMetrics,
    },
    fullArtifacts: upstream.fullArtifacts,
  };
}

export async function buildTaskBrief({ repositoryRoot, registry, plan, task, contextPacket, schemas, maxAttempts = 3, reasoning = null }) {
  const agent = registry.byId.get(task.agentId);
  const modelRouting = resolveModelRoute({
    agent,
    task,
    reasoning: reasoning ?? { level: task.reasoningLevel },
    attempt: reasoning?.attempt ?? 1,
    priorFailureCode: reasoning?.priorFailureCode ?? null,
    routingCatalog: registry.modelRouting,
  });
  const ownedPaths = task.ownedPaths ?? [];
  const upstreamAcceptanceCriteria = task.stage === "technical-refinement"
    ? [...new Map((contextPacket.upstreamArtifacts ?? [])
      .filter((artifact) => artifact.producer === plan.workflow.productOwnerTaskId)
      .flatMap((artifact) => artifact.content?.acceptanceCriteria ?? [])
      .map((criterion) => [criterion.id, criterion])).values()]
    : [];
  if (task.stage === "technical-refinement" && upstreamAcceptanceCriteria.length === 0) {
    throw new Error("technical_refinement_upstream_acceptance_criteria_missing");
  }
  const upstreamOutputPaths = (contextPacket.upstreamArtifacts ?? [])
    .flatMap((artifact) => [
      ...(artifact.content?.changedPaths ?? []),
      ...(artifact.content?.reusedPaths ?? []),
    ]);
  const readOnlyContextPaths = [...new Set([
    ...(contextPacket.references ?? []).map((reference) => reference.path),
    ...upstreamOutputPaths,
  ].filter((path) => !anyPatternMatches(ownedPaths, path)))]
    .sort();
  const taskValidation = task.validation ?? agent.validationCommands ?? [];
  assertExecutableValidationCommands(taskValidation, { label: `taskBrief.${task.taskId}.validation` });
  const changeProvenance = buildAcceptedDependencyChangeProvenance({ plan, contextPacket });
  const brief = {
    schemaVersion: 2,
    runId: plan.runId, taskId: task.taskId, agentId: task.agentId, objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    upstreamAcceptanceCriteria,
    invariants: [
      "The repository and agent-first documentation are authoritative.",
      "A blocking acceptance criterion may not be marked complete without explicit evidence.",
      "Final blocking validation must pass; RED-phase TDD failures are allowed only when phase=red.",
      "Do not hide blocked validation, required deltas, or required follow-ups.",
      "Task Brief.validation is the complete blocking executable validation authority for this task; catalog/manifests/AGENTS/skills are reusable guidance and do not silently add commands.",
      "Task Brief.validation executes only in Task Brief.validationExecutionScope. Never reinterpret container/workspace localhost as the authoritative host.",
      ...(task.stage === "implementation" ? ["Implementation validation is workspace scoped. Authoritative-host and live/TUI proofs belong to downstream operational-readiness or live qualification gates and cannot block implementation completion."] : []),
      ...(task.stage === "product-discovery" ? [
        "Product Discovery is upstream of all governance reviews, Technical Refinement, QA/readiness and Product Acceptance. Pending downstream stages are expected and cannot block this task.",
        "Task Brief.acceptanceCriteria are Runtime process gates (PROC-PO-*). Prove them only in handoff.criterionResults; never copy those process IDs into handoff.acceptanceCriteria.",
        "handoff.acceptanceCriteria is exclusively the Product Owner product-behavior catalog. Every emitted product criterion requires an explicit proofStage and must not use a PROC-* process ID.",
        "A generic docs:check or repository-wide validation absent from Task Brief.validation cannot block Product Discovery.",
        "Product Discovery must emit bootstrapReviewAssessment using bootstrap-review-assessment/v1. The Runtime treats it as the authority that refines review capabilities and fact dependencies before downstream dispatch.",
        "Classify each required cross-review fact as authoritative-context with concrete evidence, or as review-provided with exactly one providerCapabilityId. Never serialize reviews merely because they both exist.",
      ] : []),
      ...(isBootstrapReviewStage(task.stage) ? [
        "Bootstrap governance reviews are upstream of Technical Refinement. A Technical Lead implementationPlan does not exist yet by construction and its absence can never block this review.",
        "Only Task Brief.dependencies and the corresponding Context Packet upstreamArtifacts are prerequisite review outputs. A sibling bootstrap review that is not an explicit dependency must not be awaited or required.",
        "Use the current execution plan bootstrapFactBindings as fact authority. Resolved authoritative-context facts do not create review dependencies; unresolved review-provided facts do.",
        "Classify domain impact from the scoped increment itself. Requirements to preserve an existing invariant are constraints for downstream planning, not evidence that this increment changes that domain.",
        "This review produces constraints for downstream Technical Refinement; it does not validate a future implementation plan, implementation, QA, readiness, rollout or terminal run.",
      ] : []),
      ...(task.stage === "technical-refinement" ? ["The attached ownership projection is the planning view. The Runtime compiler retains the full .agents/agents/*/agent.json as final ownership authority; every implementationPlan ownedPath must still pass compiler ownership validation."] : []),
    ],
    ownedPaths, readOnlyContextPaths, sharedPathOwner: plan.sharedPathOwner, inputs: [], dependencies: task.dependencies, changeProvenance,
    outOfScope: [
      "Paths outside ownedPaths are read-only unless explicitly assigned through sharedPathOwner.",
      "readOnlyContextPaths are context only: report them in usedContextPaths, never changedPaths or reusedPaths.",
      "Accepted upstream changed/reused artifacts outside this task's ownedPaths are downstream verification context, not reused task output.",
      "Repository status may contain pre-existing dirty/tracked/untracked state. Attribute dependency changes only through Task Brief.changeProvenance, never raw working-tree status alone.",
      "Unrequested product behavior.",
    ],
    expectedEvidence: [...new Set([
      "artifactVersion", "changedPaths", "reusedPaths", "contractChanges", "assumptions",
      "criterionResults", "validation", "residualRisks", "followUps",
      ...(task.stage === "product-discovery" ? ["acceptanceCriteria", "bootstrapReviewAssessment", "sddReview"] : []),
      ...(isSddReviewStage(task.stage) ? ["sddReview"] : []),
      ...(task.stage === "technical-refinement" ? ["implementationPlan"] : []),
    ])],
    validation: taskValidation, validationExecutionScope: task.validationExecutionScope ?? "workspace", executionMode: task.executionMode ?? "agent", contextPacketId: contextPacket.packetId, attemptBudget: maxAttempts, deadlineOrBudget: null,
    sdd: { role: task.sddRole ?? "developer", stage: task.stage ?? "implementation", workItemId: task.workItemId ?? plan.runId, workflowSkill: "agentic-harness-sdd-workflow", requiredSuperpowers: agent.superpowersSkills ?? ["verification-before-completion"], reviewedRevision: authoritativeReviewRevisionFromContext({ stage: task.stage ?? "implementation", contextPacket }) },
    modelRouting,
    executionTopology: taskExecutionTopologyForAgent(agent),
    ...(reasoning ? { reasoning } : {}),
  };
  assertSchema(brief, schemas.taskBrief, "taskBrief");
  const path = join(repositoryRoot, ".runtime", "agents", "runs", plan.runId, "tasks", runtimeTaskDirectoryName(task.taskId, task.agentId), "task-brief.json");
  await writeJson(path, brief);
  return { brief, path };
}
