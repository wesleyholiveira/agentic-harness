import { join } from "node:path";
import { readJson, writeJson, fileFingerprint, exists } from "./utils.mjs";
import { stableFingerprint } from "./event-driven-contracts.mjs";
import { createExecutionPlan } from "./planner.mjs";
import { compileImplementationDag } from "./dag-compiler.mjs";
import { provisionalizeBootstrapPlan, refineBootstrapPlanFromProductDiscovery } from "./bootstrap-topology-refiner.mjs";
import { isBootstrapReviewStage } from "./bootstrap-capabilities.mjs";
import { assertSchema, validateAgainstSchema } from "./schema-validator.mjs";

export const RUN_REPLAY_CAPSULE_VERSION = "agent-runtime-replay-capsule/v1";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function refinedBootstrapTopology(plan) {
  return {
    selectedReviewStages: (plan?.tasks ?? [])
      .map((task) => String(task?.stage ?? "").trim())
      .filter(isBootstrapReviewStage),
    bootstrapFactBindings: clone(plan?.workflow?.bootstrapFactBindings ?? []),
    bootstrapReviewDependencies: clone(plan?.workflow?.bootstrapReviewDependencies ?? []),
  };
}

function registryAuthority(registry) {
  return {
    orchestrator: registry?.orchestrator ?? null,
    workflow: registry?.workflow ?? null,
    agents: [...(registry?.agents ?? [])]
      .map((agent) => clone(agent))
      .sort((left, right) => String(left?.id ?? "").localeCompare(String(right?.id ?? ""))),
  };
}

function compareEvidence(left, right, sequenceField, identityFields) {
  const leftSequence = Number(left?.[sequenceField]);
  const rightSequence = Number(right?.[sequenceField]);
  if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence) && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  const leftTime = String(left?.created_at ?? left?.createdAt ?? "");
  const rightTime = String(right?.created_at ?? right?.createdAt ?? "");
  if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
  for (const field of identityFields) {
    const compared = String(left?.[field] ?? "").localeCompare(String(right?.[field] ?? ""));
    if (compared !== 0) return compared;
  }
  return stableFingerprint(left).localeCompare(stableFingerprint(right));
}

export function canonicalReplayEvidence({ events = [], artifacts = [], checkpoints = [] } = {}) {
  return {
    events: clone(events).sort((left, right) => compareEvidence(left, right, "event_sequence", ["event_id", "event_type"])),
    // Replay-capsule artifacts point back to this file. Capturing them inside the
    // capsule would create an ever-changing self-reference on duplicate terminal
    // reconciliation, so the replay evidence contract deliberately excludes them.
    artifacts: clone(artifacts)
      .filter((artifact) => artifact?.kind !== "replay-capsule")
      .sort((left, right) => compareEvidence(left, right, "artifact_sequence", ["artifact_id", "kind", "version"])),
    checkpoints: clone(checkpoints).sort((left, right) => compareEvidence(left, right, "checkpoint_sequence", ["checkpoint_id", "checkpoint_type", "type"])),
  };
}

function capsuleFingerprintInput(capsule) {
  const copy = clone(capsule);
  delete copy.capsuleFingerprint;
  return copy;
}

function refreshCapsuleFingerprint(capsule) {
  capsule.capsuleFingerprint = stableFingerprint(capsuleFingerprintInput(capsule));
  return capsule;
}

function assertReplaySchema(capsule, schemas) {
  if (schemas?.replayCapsule) assertSchema(capsule, schemas.replayCapsule, "replayCapsule");
  return capsule;
}

export function replayCapsulePath(repositoryRoot, runId) {
  return join(repositoryRoot, ".runtime", "agents", "runs", runId, "replay-capsule.json");
}

export function replayArtifactVersion(stage) {
  const normalized = String(stage ?? "").trim();
  if (!["bootstrap", "refined", "compiled", "terminal"].includes(normalized)) throw new Error(`replay_artifact_stage_invalid:${normalized || "missing"}`);
  return `${RUN_REPLAY_CAPSULE_VERSION}:${normalized}`;
}

export function buildReplayCapsule({ plan, events = [], artifacts = [], checkpoints = [], registry, schemas = null, policyEngine = null, explicitAgents = [] }) {
  if (!plan?.runId) throw new Error("replay_capsule_plan_required");
  const capsule = {
    schemaVersion: 1,
    contractVersion: RUN_REPLAY_CAPSULE_VERSION,
    runId: plan.runId,
    capturedAt: plan.createdAt,
    identity: { runId: plan.runId, createdAt: plan.createdAt },
    inputs: {
      request: plan.request,
      reasoningAssessment: clone(plan.reasoning),
      explicitAgents: [...new Set(clone(explicitAgents ?? []).map((value) => String(value).trim()).filter(Boolean))].sort(),
    },
    provenance: {
      ...(clone(plan.provenance ?? {})),
      registryFingerprint: stableFingerprint(registryAuthority(registry)),
      policyFingerprint: policyEngine?.fingerprint ?? plan.provenance?.policyFingerprint ?? null,
      replaySchemaFingerprint: schemas?.replayCapsule ? stableFingerprint(schemas.replayCapsule) : null,
    },
    plan: clone(plan),
    planFingerprint: stableFingerprint(plan),
    refinedBootstrap: null,
    compiled: null,
    terminal: null,
    evidence: canonicalReplayEvidence({ events, artifacts, checkpoints }),
  };
  refreshCapsuleFingerprint(capsule);
  return assertReplaySchema(capsule, schemas);
}

export function replayBootstrapPlan({ capsule, registry, schemas, policyEngine = null }) {
  if (capsule?.contractVersion !== RUN_REPLAY_CAPSULE_VERSION) throw new Error("replay_capsule_version_invalid");
  const candidate = createExecutionPlan({
    registry,
    schemas,
    request: capsule.inputs.request,
    reasoningAssessment: clone(capsule.inputs.reasoningAssessment),
    explicitAgents: clone(capsule.inputs.explicitAgents ?? []),
    identity: clone(capsule.identity),
    policyEngine,
  });
  const authority = capsule.plan?.workflow?.bootstrapTopologyAuthority ?? null;
  const persistedAsProvisional = authority === "product-discovery-pending"
    || Array.isArray(capsule.plan?.workflow?.bootstrapCandidateReviewStages);
  return persistedAsProvisional ? provisionalizeBootstrapPlan(candidate, schemas, policyEngine) : candidate;
}

export function verifyReplayCapsule({ capsule, registry, schemas, policyEngine = null }) {
  const violations = [];
  if (schemas?.replayCapsule) {
    const schemaResult = validateAgainstSchema(capsule, schemas.replayCapsule, "replayCapsule");
    for (const error of schemaResult.errors) violations.push(`replay_schema_invalid:${error}`);
  }
  if (capsule?.contractVersion !== RUN_REPLAY_CAPSULE_VERSION) {
    violations.push(`replay_capsule_version_invalid:${capsule?.contractVersion ?? "missing"}`);
    return { ok: false, violations };
  }
  const expectedCapsuleFingerprint = stableFingerprint(capsuleFingerprintInput(capsule));
  if (capsule.capsuleFingerprint !== expectedCapsuleFingerprint) {
    violations.push(`replay_capsule_fingerprint_mismatch:${capsule.capsuleFingerprint ?? "missing"}:${expectedCapsuleFingerprint}`);
  }
  const actualPlanFingerprint = stableFingerprint(capsule.plan);
  if (capsule.planFingerprint !== actualPlanFingerprint) {
    violations.push(`replay_plan_fingerprint_mismatch:${capsule.planFingerprint ?? "missing"}:${actualPlanFingerprint}`);
  }
  const registryFingerprint = stableFingerprint(registryAuthority(registry));
  if (capsule.provenance?.registryFingerprint !== registryFingerprint) {
    violations.push(`replay_registry_fingerprint_mismatch:${capsule.provenance?.registryFingerprint ?? "missing"}:${registryFingerprint}`);
  }
  const policyFingerprint = policyEngine?.fingerprint ?? null;
  if ((capsule.provenance?.policyFingerprint ?? null) !== policyFingerprint) {
    violations.push(`replay_policy_fingerprint_mismatch:${capsule.provenance?.policyFingerprint ?? "missing"}:${policyFingerprint ?? "missing"}`);
  }
  if (schemas?.replayCapsule) {
    const schemaFingerprint = stableFingerprint(schemas.replayCapsule);
    if ((capsule.provenance?.replaySchemaFingerprint ?? null) !== schemaFingerprint) {
      violations.push(`replay_schema_fingerprint_mismatch:${capsule.provenance?.replaySchemaFingerprint ?? "missing"}:${schemaFingerprint}`);
    }
  }
  const canonical = canonicalReplayEvidence(capsule.evidence);
  if (stableFingerprint(canonical) !== stableFingerprint(capsule.evidence)) violations.push("replay_evidence_order_not_canonical");
  try {
    const replayed = replayBootstrapPlan({ capsule, registry, schemas, policyEngine });
    const replayedFingerprint = stableFingerprint(replayed);
    if (replayedFingerprint !== capsule.planFingerprint) {
      violations.push(`replay_reproduced_plan_mismatch:${capsule.planFingerprint}:${replayedFingerprint}`);
    }
    let effectiveBootstrapPlan = replayed;
    if (capsule.refinedBootstrap) {
      const refinedReplay = refineBootstrapPlanFromProductDiscovery({
        plan: replayed,
        handoff: { bootstrapReviewAssessment: clone(capsule.refinedBootstrap.assessment) },
        registry,
        schemas,
        policyEngine,
      });
      effectiveBootstrapPlan = refinedReplay.plan;
      const refinedFingerprint = stableFingerprint(effectiveBootstrapPlan);
      if (refinedFingerprint !== capsule.refinedBootstrap.planFingerprint) {
        violations.push(`replay_reproduced_refined_bootstrap_mismatch:${capsule.refinedBootstrap.planFingerprint}:${refinedFingerprint}`);
      }
      const topologyFingerprint = stableFingerprint(refinedBootstrapTopology(effectiveBootstrapPlan));
      const recordedTopologyFingerprint = stableFingerprint(capsule.refinedBootstrap.topology);
      if (topologyFingerprint !== recordedTopologyFingerprint) {
        violations.push(`replay_refined_bootstrap_topology_mismatch:${recordedTopologyFingerprint}:${topologyFingerprint}`);
      }
    }
    if (capsule.compiled) {
      const technicalLeadHandoff = { implementationPlan: clone(capsule.compiled.implementationPlan) };
      const replayedCompiled = compileImplementationDag({
        registry,
        plan: effectiveBootstrapPlan,
        technicalLeadHandoff,
        schemas,
        requiredAcceptanceCriteria: clone(capsule.compiled.requiredAcceptanceCriteria ?? []),
        compiledAt: capsule.compiled.compiledAt,
      });
      const replayedCompiledFingerprint = stableFingerprint(replayedCompiled);
      if (replayedCompiledFingerprint !== capsule.compiled.planFingerprint) {
        violations.push(`replay_reproduced_compiled_plan_mismatch:${capsule.compiled.planFingerprint}:${replayedCompiledFingerprint}`);
      }
    }
  } catch (error) {
    violations.push(`replay_execution_failed:${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: violations.length === 0, violations, capsuleFingerprint: expectedCapsuleFingerprint };
}

export async function updateReplayCapsuleWithRefinedBootstrapPlan(repositoryRoot, refinedPlan, { assessment = null, authority = null, schemas = null } = {}) {
  if (!refinedPlan?.runId || refinedPlan?.phase !== "bootstrap") throw new Error("replay_refined_bootstrap_plan_required");
  const path = replayCapsulePath(repositoryRoot, refinedPlan.runId);
  const capsule = await readJson(path);
  if (capsule?.contractVersion !== RUN_REPLAY_CAPSULE_VERSION) throw new Error("replay_capsule_version_invalid");
  const resolvedAuthority = String(authority ?? refinedPlan.workflow?.bootstrapTopologyAuthority ?? "").trim();
  if (!resolvedAuthority) throw new Error("replay_refined_bootstrap_authority_required");
  if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) throw new Error("replay_refined_bootstrap_assessment_required");
  const topologyFingerprint = refinedPlan.provenance?.bootstrapTopologyFingerprint ?? null;
  if (!String(topologyFingerprint ?? "").startsWith("sha256:")) throw new Error("replay_refined_bootstrap_topology_fingerprint_required");
  capsule.refinedBootstrap = {
    authority: resolvedAuthority,
    assessment: clone(assessment),
    topology: refinedBootstrapTopology(refinedPlan),
    planFingerprint: stableFingerprint(refinedPlan),
    topologyFingerprint,
  };
  refreshCapsuleFingerprint(capsule);
  assertReplaySchema(capsule, schemas);
  await writeJson(path, capsule);
  return { path, capsule };
}

export async function updateReplayCapsuleWithCompiledPlan(repositoryRoot, compiledPlan, { implementationPlan, requiredAcceptanceCriteria = [], schemas = null } = {}) {
  if (!compiledPlan?.runId || compiledPlan?.phase !== "compiled") throw new Error("replay_compiled_plan_required");
  const path = replayCapsulePath(repositoryRoot, compiledPlan.runId);
  const capsule = await readJson(path);
  if (capsule?.contractVersion !== RUN_REPLAY_CAPSULE_VERSION) throw new Error("replay_capsule_version_invalid");
  if (!implementationPlan) throw new Error("replay_compiled_implementation_plan_required");
  const compiledAt = compiledPlan.workflow?.compiledAt ?? null;
  if (!compiledAt || Number.isNaN(Date.parse(compiledAt))) throw new Error("replay_compiled_at_required");
  capsule.compiled = {
    compiledAt,
    implementationPlan: clone(implementationPlan),
    requiredAcceptanceCriteria: clone(requiredAcceptanceCriteria),
    planFingerprint: stableFingerprint(compiledPlan),
  };
  refreshCapsuleFingerprint(capsule);
  assertReplaySchema(capsule, schemas);
  await writeJson(path, capsule);
  return { path, capsule };
}

export async function updateReplayCapsuleEvidence(repositoryRoot, runId, {
  events = [], artifacts = [], checkpoints = [], terminal = null, schemas = null,
} = {}) {
  const path = replayCapsulePath(repositoryRoot, runId);
  if (!(await exists(path))) return null;
  const capsule = await readJson(path);
  if (capsule?.contractVersion !== RUN_REPLAY_CAPSULE_VERSION) throw new Error("replay_capsule_version_invalid");
  capsule.evidence = canonicalReplayEvidence({ events, artifacts, checkpoints });
  capsule.terminal = terminal == null
    ? capsule.terminal ?? null
    : { ...(clone(capsule.terminal) ?? {}), ...clone(terminal) };
  refreshCapsuleFingerprint(capsule);
  assertReplaySchema(capsule, schemas);
  await writeJson(path, capsule);
  return { path, capsule };
}

export async function recordReplayCapsuleArtifact(store, { runId, taskId = null, path, capsule, stage }) {
  if (!store?.addArtifact) return null;
  const fingerprint = await fileFingerprint(path);
  const version = replayArtifactVersion(stage);
  const existing = (await store.listArtifacts?.(runId) ?? [])
    .find((artifact) => artifact.kind === "replay-capsule" && artifact.version === version && artifact.sha256 === (fingerprint?.sha256 ?? null));
  if (existing) return existing.artifact_id ?? existing.artifactId ?? null;
  return await store.addArtifact({
    runId,
    taskId,
    kind: "replay-capsule",
    version,
    path,
    sha256: fingerprint?.sha256 ?? null,
    accepted: true,
  });
}

export async function saveReplayCapsule(repositoryRoot, capsule, schemas = null) {
  assertReplaySchema(capsule, schemas);
  const path = replayCapsulePath(repositoryRoot, capsule.runId);
  await writeJson(path, capsule);
  return path;
}

export async function loadReplayCapsule(path, schemas = null) {
  return assertReplaySchema(await readJson(path), schemas);
}
