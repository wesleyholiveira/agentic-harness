import { assertSchema } from "./schema-validator.mjs";
import { capabilityCatalogFromRegistry, isBootstrapReviewStage, normalizeBootstrapFactRequirements } from "./bootstrap-capabilities.mjs";
import { createExecutionPlan } from "./planner.mjs";
import { stableFingerprint } from "./event-driven-contracts.mjs";


function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function compact(value) {
  return String(value ?? "").trim();
}

export function normalizeProductDiscoveryReviewAssessment(handoff, registry) {
  const raw = handoff?.bootstrapReviewAssessment;
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("product_discovery_bootstrap_review_assessment_invalid");
  if (raw.contractVersion !== "bootstrap-review-assessment/v1") throw new Error("product_discovery_bootstrap_review_assessment_version_invalid");
  if (!Array.isArray(raw.requiredCapabilities)) throw new Error("product_discovery_bootstrap_required_capabilities_missing");
  if (!Array.isArray(raw.factRequirements)) throw new Error("product_discovery_bootstrap_fact_requirements_missing");
  const catalog = capabilityCatalogFromRegistry(registry);
  const declaredCapabilities = [...new Set((raw.requiredCapabilities ?? []).map(compact).filter(Boolean))];
  for (const capabilityId of declaredCapabilities) {
    if (!catalog.byId.has(capabilityId)) throw new Error(`product_discovery_bootstrap_capability_unknown:${capabilityId}`);
  }
  const requiredCapabilities = catalog.capabilities
    .map((capability) => capability.capabilityId)
    .filter((capabilityId) => declaredCapabilities.includes(capabilityId));
  const factRequirements = normalizeBootstrapFactRequirements(raw.factRequirements, {
    catalog,
    provenance: "product-discovery",
  });
  const capabilitySet = new Set(requiredCapabilities);
  for (const requirement of factRequirements) {
    if (!capabilitySet.has(requirement.consumerCapabilityId)) {
      throw new Error(`product_discovery_bootstrap_consumer_capability_not_required:${requirement.consumerCapabilityId}:${requirement.factId}`);
    }
    if (requirement.providerCapabilityId && !capabilitySet.has(requirement.providerCapabilityId)) {
      throw new Error(`product_discovery_bootstrap_provider_capability_not_required:${requirement.providerCapabilityId}:${requirement.factId}`);
    }
  }
  const evidence = compact(raw.evidence);
  if (!evidence) throw new Error("product_discovery_bootstrap_assessment_evidence_missing");
  return {
    contractVersion: raw.contractVersion,
    requiredCapabilities,
    factRequirements,
    evidence,
  };
}

function taskByStage(tasks) {
  return new Map(tasks.map((task) => [task.stage, task]));
}

function stageSelected(plan, stage) {
  return plan.tasks.some((task) => task.stage === stage);
}

function requiredAgentIds(assessment, catalog) {
  return assessment.requiredCapabilities.map((capabilityId) => catalog.byId.get(capabilityId)?.agentId).filter(Boolean);
}

function authoritativeBootstrapTasks(existingPlan, candidatePlan, catalog) {
  const existing = taskByStage(existingPlan.tasks);
  const candidate = taskByStage(candidatePlan.tasks);
  const product = clone(candidate.get("product-discovery") ?? existing.get("product-discovery"));
  const technical = clone(candidate.get("technical-refinement") ?? existing.get("technical-refinement"));
  if (!product || !technical) throw new Error("bootstrap_topology_process_task_missing");

  // Product Discovery is the authority for the exact review set. Registry order
  // is deterministic but the stage vocabulary remains extensible.
  const selectedReviews = catalog.reviewStages.filter((stage) => candidate.has(stage));
  const reviewTasks = selectedReviews.map((stage) => clone(candidate.get(stage)));
  technical.dependencies = [product.taskId, ...reviewTasks.map((task) => task.taskId)];
  return [product, ...reviewTasks, technical];
}

export function provisionalizeBootstrapPlan(plan, schemas = null, policyEngine = null) {
  if (plan?.phase !== "bootstrap") return clone(plan);
  const byStage = taskByStage(plan.tasks ?? []);
  const product = clone(byStage.get("product-discovery"));
  const technical = clone(byStage.get("technical-refinement"));
  if (!product || !technical) throw new Error("bootstrap_topology_process_task_missing");
  const declaredCandidateStages = plan.workflow?.bootstrapCandidateReviewStages;
  const candidateReviewStages = Array.isArray(declaredCandidateStages)
    ? [...new Set(declaredCandidateStages.filter((stage) => isBootstrapReviewStage(stage) && byStage.has(stage)))]
    : [...byStage.keys()].filter((stage) => isBootstrapReviewStage(stage));
  technical.dependencies = [product.taskId];
  const provisional = {
    ...clone(plan),
    tasks: [product, technical],
    workflow: {
      ...clone(plan.workflow),
      requiresDatabase: false,
      requiresDevOps: false,
      requiresAiLlmOps: false,
      bootstrapTopologyState: "provisional",
      bootstrapTopologyAuthority: "product-discovery-pending",
      bootstrapCandidateReviewStages: candidateReviewStages,
      bootstrapFactBindings: (plan.workflow?.bootstrapFactBindings ?? []).map((binding) => ({
        ...clone(binding), consumerTaskId: null, providerTaskId: null,
      })),
      // Concrete review edges are intentionally absent until Product Discovery
      // authorizes the review set. Candidate fact bindings remain as provenance.
      bootstrapReviewDependencies: [],
    },
    provenance: {
      ...clone(plan.provenance),
      initialPlanFingerprint: plan.provenance?.initialPlanFingerprint ?? stableFingerprint(plan),
    },
  };
  // `createExecutionPlan()` evaluates policy against the candidate bootstrap
  // topology. Production then intentionally strips sibling reviews until
  // Product Discovery authorizes them, so the policy receipt must be projected
  // again against the *provisional* topology. Keep that projection in this
  // canonical helper so live planning and replay hash exactly the same plan.
  if (policyEngine?.evaluatePlan) {
    const planDecision = policyEngine.evaluatePlan({
      phase: provisional.phase,
      bootstrapFactBindings: provisional.workflow.bootstrapFactBindings,
      bootstrapReviewDependencies: provisional.workflow.bootstrapReviewDependencies,
      topologyState: provisional.workflow.bootstrapTopologyState,
    });
    provisional.policy = { ...provisional.policy, planDecision };
  }
  if (schemas?.executionPlan) assertSchema(provisional, schemas.executionPlan, "executionPlan");
  return provisional;
}

function materializedFactBindings(candidatePlan, tasks) {
  const ids = new Map(tasks.map((task) => [task.stage, task.taskId]));
  return (candidatePlan.workflow.bootstrapFactBindings ?? []).map((binding) => ({
    ...binding,
    consumerTaskId: ids.get(binding.consumerStage) ?? null,
    providerTaskId: binding.providerStage ? (ids.get(binding.providerStage) ?? null) : null,
  }));
}

function materializedReviewDependencies(candidatePlan, tasks) {
  const ids = new Map(tasks.map((task) => [task.stage, task.taskId]));
  return (candidatePlan.workflow.bootstrapReviewDependencies ?? []).map((edge) => ({
    ...edge,
    fromTaskId: ids.get(edge.fromStage) ?? null,
    toTaskId: ids.get(edge.toStage) ?? null,
  }));
}

export function refineBootstrapPlanFromProductDiscovery({ plan, handoff, registry, schemas, policyEngine = null }) {
  if (plan?.phase !== "bootstrap") return { changed: false, plan, reason: "not-bootstrap" };
  if (plan?.workflow?.bootstrapTopologyState === "refined") return { changed: false, plan, reason: "already-refined" };
  const catalog = capabilityCatalogFromRegistry(registry);
  const assessment = normalizeProductDiscoveryReviewAssessment(handoff, registry);
  if (!assessment) throw new Error("product_discovery_bootstrap_review_assessment_missing");
  const reasoning = clone(plan.reasoning ?? {});
  const authority = "product-discovery";

  reasoning.bootstrapFactRequirements = clone(assessment.factRequirements);
  reasoning.bootstrapRequiredCapabilities = clone(assessment.requiredCapabilities);
  delete reasoning.bootstrapReviewDependencies;
  // Keep recommendedAgents only as non-authoritative routing context. Review
  // selection is owned by bootstrapRequiredCapabilities + required facts.
  reasoning.recommendedAgents = [...new Set([
    ...(reasoning.recommendedAgents ?? []),
    ...requiredAgentIds(assessment, catalog),
  ])];
  reasoning.requiresArchitecture = assessment.requiredCapabilities.includes("review.architecture");

  const candidate = createExecutionPlan({
    registry,
    schemas,
    request: plan.request,
    reasoningAssessment: reasoning,
    identity: { runId: plan.runId, createdAt: plan.createdAt },
    policyEngine,
  });
  const tasks = authoritativeBootstrapTasks(plan, candidate, catalog);
  const selectedReviewStages = new Set(tasks.filter((task) => catalog.byStage.has(task.stage)).map((task) => task.stage));
  const reviewDependencies = materializedReviewDependencies(candidate, tasks)
    .filter((edge) => selectedReviewStages.has(edge.fromStage) && selectedReviewStages.has(edge.toStage));
  const factBindings = materializedFactBindings(candidate, tasks)
    .filter((binding) => selectedReviewStages.has(binding.consumerStage) && (!binding.providerStage || selectedReviewStages.has(binding.providerStage)));

  const refined = {
    ...candidate,
    tasks,
    workflow: {
      ...candidate.workflow,
      requiresDatabase: selectedReviewStages.has("database-review"),
      requiresDevOps: selectedReviewStages.has("infrastructure-review"),
      requiresAiLlmOps: selectedReviewStages.has("ai-operations-review"),
      bootstrapFactBindings: factBindings,
      bootstrapReviewDependencies: reviewDependencies,
      bootstrapTopologyState: "refined",
      bootstrapTopologyRevision: Number(plan.workflow?.bootstrapTopologyRevision ?? 1) + 1,
      bootstrapTopologyAuthority: authority,
    },
    provenance: {
      ...candidate.provenance,
      initialPlanFingerprint: plan.provenance?.initialPlanFingerprint ?? stableFingerprint(plan),
      productDiscoveryAssessmentFingerprint: stableFingerprint(assessment),
      bootstrapTopologyFingerprint: stableFingerprint({ factBindings, reviewDependencies, selectedReviewStages: [...selectedReviewStages].sort() }),
    },
  };
  const policyDecision = policyEngine?.evaluatePlan({
    phase: refined.phase,
    bootstrapFactBindings: factBindings,
    bootstrapReviewDependencies: reviewDependencies,
    topologyState: "refined",
  }) ?? null;
  if (policyDecision && !policyDecision.allowed) {
    const error = new Error(`runtime_policy_bootstrap_refinement_denied:${policyDecision.code}`);
    error.code = policyDecision.code;
    error.policyDecision = policyDecision;
    throw error;
  }
  assertSchema(refined, schemas.executionPlan, "executionPlan");

  const oldByStage = taskByStage(plan.tasks);
  const nextStages = new Set(tasks.map((task) => task.stage));
  const addedTasks = tasks.filter((task) => !oldByStage.has(task.stage));
  const reviewStageUniverse = new Set([...(plan.workflow?.bootstrapCandidateReviewStages ?? []), ...catalog.reviewStages]);
  const removedTasks = plan.tasks.filter((task) => reviewStageUniverse.has(task.stage) && !nextStages.has(task.stage));
  const dependencyUpdates = tasks
    .filter((task) => oldByStage.has(task.stage))
    .filter((task) => JSON.stringify(oldByStage.get(task.stage).dependencies ?? []) !== JSON.stringify(task.dependencies ?? []))
    .map((task) => ({ taskId: task.taskId, dependencies: task.dependencies }));
  return { changed: true, plan: refined, assessment, addedTasks, removedTasks, dependencyUpdates, policyDecision };
}

export function bootstrapTopologyReadyForTask(plan, taskPlan) {
  if (taskPlan?.stage === "product-discovery") return true;
  if (plan?.phase !== "bootstrap") return true;
  return plan?.workflow?.bootstrapTopologyState === "refined";
}

export function bootstrapReviewStageSelected(plan, stage) {
  return isBootstrapReviewStage(stage) && stageSelected(plan, stage);
}
