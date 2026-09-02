import { join } from "node:path";
import { assessReasoning, maxReasoningLevel, scoreAgentFallback } from "./reasoning.mjs";
import { newId, nowIso, writeJson } from "./utils.mjs";
import { assertSchema } from "./schema-validator.mjs";
import { materializeBootstrapReviewDependencies, reviewDependenciesForStage } from "./bootstrap-review-dependencies.mjs";
import {
  capabilityCatalogFromRegistry,
  inferBootstrapFactRequirements,
  legacyEdgesToFactRequirements,
  materializeBootstrapFactBindings,
  normalizeBootstrapFactRequirements,
  resolveBootstrapFactTopology,
} from "./bootstrap-capabilities.mjs";
import { stableFingerprint } from "./event-driven-contracts.mjs";
import { assertPolicyAllowed, RuntimePolicyEngine } from "./policy-engine.mjs";
import { modelRequirementsForTask } from "./model-capabilities.mjs";

const PROCESS_AGENT_IDS = new Set(["product-owner", "architecture-governance", "ux-design", "devops-engineering", "ai-llmops", "database-administration", "security-reviewer", "technical-lead", "verification-evidence"]);
const STAGES = {
  productDiscovery: "product-discovery",
  architectureReview: "architecture-review",
  databaseReview: "database-review",
  infrastructureReview: "infrastructure-review",
  aiOperationsReview: "ai-operations-review",
  securityReview: "security-review",
  technicalRefinement: "technical-refinement",
};

const REVIEW_TASK_DEFINITIONS = Object.freeze({
  [STAGES.architectureReview]: {
    objective: (request, hint) => `Define durable application/data/integration/security boundaries and ADR deltas for: ${request}${hint}`,
    acceptanceCriteria: () => [
      criterion("PROC-ARCH-1", "runtime", "Architecture covers every PRD criterion that changes a system boundary or invariant.", "architecture handoff references affected acceptance criteria and ADR evidence"),
      criterion("PROC-ARCH-2", "runtime", "Rejected alternatives and operational trade-offs are explicit.", "architecture handoff contains evidence with no blocking required delta"),
    ],
  },
  [STAGES.databaseReview]: {
    objective: (request, hint) => `Classify database impact for the scoped increment. Preserved persistence/runtime invariants are constraints, not evidence that the increment changes the database. If impact is none, prove that no schema, migration, query, index, transaction, persistence or backfill behavior changes and approve the no-impact review. If impact exists, define the migration/backfill safety, indexes, ACID, compatibility and rollback constraints that downstream Technical Refinement must honor; do not wait for a Technical Lead implementation plan, because this review is upstream of Technical Refinement. Review: ${request}${hint}`,
    acceptanceCriteria: () => [criterion("PROC-DB-1", "runtime", "Database impact is explicit and reviewable: either database_impact=none is proven for the scoped increment, or every affected migration/backfill, query/index, transactional and rollback/compatibility constraint is explicit.", "handoff criterionResults marks PROC-DB-1 passed only after proving database_impact=none from scoped evidence, or after approving all blocking persistence constraints for an impacted change")],
  },
  [STAGES.infrastructureReview]: {
    objective: (request, hint) => `Review IaC, security, cost, observability, capacity and rollback constraints for: ${request}${hint}`,
    acceptanceCriteria: () => [criterion("PROC-DEVOPS-1", "runtime", "Operational constraints and required readiness checks are explicit.", "handoff contains blocking operational requirements and final validation commands")],
  },
  [STAGES.aiOperationsReview]: {
    objective: (request, hint) => `Review model, dataset, evaluation, latency, token-cost, drift and rollback constraints for: ${request}${hint}`,
    acceptanceCriteria: () => [criterion("PROC-AIOPS-1", "runtime", "AI/ML operational constraints and quality gates are explicit.", "handoff contains measurable AI/ML gates and rollback evidence")],
  },
});

function genericReviewDefinition(capability) {
  const criterionId = `PROC-${capability.stage.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toUpperCase()}-1`;
  return {
    objective: (request, hint) => `Review ${capability.capabilityId} constraints, required facts, risks, compatibility and validation gates for: ${request}${hint}`,
    acceptanceCriteria: () => [criterion(
      criterionId,
      "runtime",
      `${capability.capabilityId} impact and every blocking domain constraint are explicit.`,
      `handoff proves ${capability.impactField || "domain impact"}, references affected acceptance criteria and resolves or delegates every required fact`,
    )],
  };
}

function fallbackAssessment(registry, request, explicitAgents) {
  const scored = registry.agents
    .filter((agent) => agent.id !== registry.orchestrator && !PROCESS_AGENT_IDS.has(agent.id))
    .map((agent) => ({ agent, ...scoreAgentFallback(agent, request) }))
    .filter((item) => item.score > 0 || explicitAgents.includes(item.agent.id))
    .sort((a, b) => b.score - a.score || a.agent.id.localeCompare(b.agent.id));
  return {
    mode: "adaptive", source: "heuristic", initialLevel: "medium", confidence: 0.35,
    rationale: "Bootstrap routing uses heuristics only to decide governance reviews; implementation ownership is decided by the Technical Lead implementation plan.",
    fallbackReason: "reasoning_assessment_not_supplied",
    recommendedAgents: scored.map((item) => item.agent.id), requiresArchitecture: false,
    signals: { complexity: "medium", ambiguity: 0.5, estimatedFiles: 1, estimatedDomains: 1, riskFactors: [] },
    routingEvidence: scored.map(({ agent, score, matched }) => ({ agentId: agent.id, score, matched })), assessmentPath: null,
  };
}

function ownedPathsFor(agent) {
  return [...new Set([...(agent.primaryPaths ?? []), ...(agent.collaborativePaths ?? []), ...(agent.sharedPaths ?? [])])];
}

function levelFor(agentId, initial, stage = null) {
  if (String(stage ?? "").endsWith("-review") || ["product-owner", "architecture-governance", "database-administration", "devops-engineering", "ai-llmops", "technical-lead"].includes(agentId)) return maxReasoningLevel(initial, "high");
  return initial;
}

function criterion(id, source, statement, verification) {
  return { id, source, statement, blocking: true, verification };
}

function governanceTask({ runId, agent, stage, objective, dependencies, workItemId, initialLevel, acceptanceCriteria, capabilityId }) {
  return {
    taskId: `${runId}:${stage}`,
    agentId: agent.id,
    objective,
    dependencies: [...new Set(dependencies)],
    ownedPaths: ownedPathsFor(agent),
    role: "contract",
    sddRole: agent.role,
    stage,
    workItemId,
    reasoningLevel: levelFor(agent.id, initialLevel, stage),
    acceptanceCriteria,
    validation: [],
    complexity: "high",
    estimatedFiles: 0,
    contractChange: true,
    migration: false,
    executionRequirements: {
      capabilityId,
      ...modelRequirementsForTask({ stage, role: "contract", sddRole: agent.role, reasoningLevel: levelFor(agent.id, initialLevel, stage) }),
      modelBinding: "runtime-route",
    },
  };
}

function reviewRequirements({ request, reasoning, selectedIds, registry }) {
  const normalized = request.toLowerCase();
  const recommendedIds = new Set(reasoning.recommendedAgents ?? []);
  const devOpsByRouting = ["devops-engineering", "platform-release", "async-control-plane"].some((id) => selectedIds.has(id) || recommendedIds.has(id));
  const aiOpsAgentIds = new Set(
    registry.agents
      .filter((agent) => agent.kind === "ai-operations" || agent.id === "ai-llmops")
      .map((agent) => agent.id),
  );
  const aiOpsByRouting = [...aiOpsAgentIds].some((id) => selectedIds.has(id) || recommendedIds.has(id));
  const databaseByRouting = selectedIds.has("database-administration") || recommendedIds.has("database-administration");
  const semanticAuthoritative = reasoning.source === "llm" || reasoning.source === "explicit";
  const databaseSignals = databaseByRouting || /\b(database|schema|migration|migrate|postgres|postgresql|sql|query|queries|index|indexes|índice|índices|transaction|acid|backfill|persistence|persistência)\b/i.test(normalized);
  const devOpsSignals = devOpsByRouting || (!semanticAuthoritative && /\b(devops|iac|terraform|cloud|aws|azure|gcp|deploy|release|docker|compose|kubernetes|observability|slo|rpo|rto|security|capacity)\b/i.test(normalized));
  const aiOpsSignals = aiOpsByRouting || (!semanticAuthoritative && /\b(llmops|mlops|prompt|model|dataset|evaluation|token|inference|latency|drift|training|embedding|semantic)\b/i.test(normalized));
  const securitySignals = selectedIds.has("security-reviewer") || recommendedIds.has("security-reviewer") || (!semanticAuthoritative && /\b(security|threat|authentication|authorization|oauth|oidc|jwt|secret|credential|encryption|tls|mtls|vulnerability|cve|permission|rbac)\b/i.test(normalized));
  return { requiresDatabase: databaseSignals, requiresDevOps: devOpsSignals, requiresAiLlmOps: aiOpsSignals, requiresSecurity: securitySignals };
}

export function createExecutionPlan({
  registry,
  request,
  schemas,
  explicitAgents = [],
  reasoningAssessment = null,
  identity = null,
  policyEngine = null,
}) {
  if (!request?.trim()) throw new Error("agent_request_required");
  const activePolicy = policyEngine ?? new RuntimePolicyEngine();
  const reasoning = reasoningAssessment ?? fallbackAssessment(registry, request, explicitAgents);
  const capabilityCatalog = capabilityCatalogFromRegistry(registry);
  const selectedIds = new Set([...(reasoning.recommendedAgents ?? []), ...explicitAgents]);
  const processAgentIds = new Set([
    ...PROCESS_AGENT_IDS,
    ...capabilityCatalog.capabilities.map((capability) => capability.agentId),
  ]);
  const domainCount = [...selectedIds].filter((id) => !processAgentIds.has(id)).length;
  const authoritativeReviewCapabilities = Array.isArray(reasoning.bootstrapRequiredCapabilities)
    ? new Set(reasoning.bootstrapRequiredCapabilities)
    : null;
  const selectedCapabilityIds = new Set();

  if (authoritativeReviewCapabilities) {
    for (const capabilityId of authoritativeReviewCapabilities) {
      if (!capabilityCatalog.byId.has(capabilityId)) throw new Error(`bootstrap_capability_unknown:${capabilityId}`);
      selectedCapabilityIds.add(capabilityId);
    }
  } else {
    const structural = reasoning.requiresArchitecture || domainCount > 1 || /\b(refactor|architecture|migration|schema|contract|cross-domain|multi-agent|multiagente)\b/i.test(request);
    const reviews = reviewRequirements({ request, reasoning, selectedIds, registry });
    if (structural && capabilityCatalog.byId.has("review.architecture")) selectedCapabilityIds.add("review.architecture");
    if (reviews.requiresDatabase && capabilityCatalog.byId.has("review.database")) selectedCapabilityIds.add("review.database");
    if (reviews.requiresDevOps && capabilityCatalog.byId.has("review.infrastructure")) selectedCapabilityIds.add("review.infrastructure");
    if (reviews.requiresAiLlmOps && capabilityCatalog.byId.has("review.ai-operations")) selectedCapabilityIds.add("review.ai-operations");
    if (reviews.requiresSecurity && capabilityCatalog.byId.has("review.security")) selectedCapabilityIds.add("review.security");
  }

  const hasDeclaredFactRequirements = Array.isArray(reasoning.bootstrapFactRequirements);
  const hasLegacyReviewDependencies = Array.isArray(reasoning.bootstrapReviewDependencies);
  const factRequirements = hasDeclaredFactRequirements
    ? normalizeBootstrapFactRequirements(reasoning.bootstrapFactRequirements, {
      catalog: capabilityCatalog,
      provenance: `reasoning:${reasoning.source ?? "unknown"}`,
    })
    : hasLegacyReviewDependencies
      ? legacyEdgesToFactRequirements(reasoning.bootstrapReviewDependencies, {
        catalog: capabilityCatalog,
        provenance: `legacy-reasoning:${reasoning.source ?? "unknown"}`,
      })
      : inferBootstrapFactRequirements({ request, catalog: capabilityCatalog });
  const factTopology = resolveBootstrapFactTopology({ catalog: capabilityCatalog, requirements: factRequirements });

  // A required fact activates both its consumer and, when unresolved, its
  // provider capability. This keeps selection and topology coherent while
  // preserving full fan-out when every fact is already supplied by an
  // authoritative source.
  for (const capabilityId of factTopology.requiredCapabilityIds) {
    if (!capabilityCatalog.byId.has(capabilityId)) throw new Error(`bootstrap_capability_unknown:${capabilityId}`);
    selectedCapabilityIds.add(capabilityId);
  }

  const selectedReviewCapabilities = capabilityCatalog.capabilities
    .filter((capability) => selectedCapabilityIds.has(capability.capabilityId));
  const selectedReviewStages = new Set(selectedReviewCapabilities.map((capability) => capability.stage));
  const reviewEdges = factTopology.edges.filter((edge) => selectedReviewStages.has(edge.fromStage) && selectedReviewStages.has(edge.toStage));
  const structural = selectedReviewStages.has(STAGES.architectureReview);
  const reviews = {
    requiresDatabase: selectedReviewStages.has(STAGES.databaseReview),
    requiresDevOps: selectedReviewStages.has(STAGES.infrastructureReview),
    requiresAiLlmOps: selectedReviewStages.has(STAGES.aiOperationsReview),
    requiresSecurity: selectedReviewStages.has(STAGES.securityReview),
  };

  const productOwner = registry.byId.get("product-owner");
  const technicalLead = registry.byId.get("technical-lead");
  const qa = registry.byId.get("verification-evidence");
  for (const agent of [productOwner, technicalLead, qa]) if (!agent) throw new Error("sdd_process_agent_missing");
  for (const capability of selectedReviewCapabilities) {
    if (!registry.byId.get(capability.agentId)) throw new Error(`sdd_review_agent_missing:${capability.agentId}`);
  }

  const runId = String(identity?.runId ?? newId("run"));
  const createdAt = String(identity?.createdAt ?? nowIso());
  if (!runId.trim()) throw new Error("execution_plan_run_id_required");
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("execution_plan_created_at_invalid");
  const workItemId = `${runId}:spec`;
  const initialLevel = reasoning.initialLevel ?? "medium";
  const tasks = [];

  const discovery = governanceTask({
    runId, agent: productOwner, stage: STAGES.productDiscovery, workItemId, initialLevel, dependencies: [],
    capabilityId: "process.product-discovery",
    objective: `Create or refine the PRD with stable, binary acceptance criteria for: ${request}`,
    acceptanceCriteria: [
      criterion("PROC-PO-1", "runtime", "The PRD exposes stable product acceptance-criterion IDs with binary observable outcomes.", "handoff.acceptanceCriteria is non-empty, contains only product criteria (never Task Brief PROC-PO-* process gates), and every criterion is testable with an explicit proofStage"),
      criterion("PROC-PO-2", "runtime", "Business scope and non-goals are explicit enough that downstream roles do not infer product behavior.", "PRD evidence and zero open blocking product ambiguity"),
      criterion("PROC-PO-3", "runtime", "Product Discovery classifies required bootstrap review capabilities, preserves explicit request-scoped capability/fact dependency requirements, and resolves or delegates every cross-review fact dependency.", "handoff.bootstrapReviewAssessment uses bootstrap-review-assessment/v1 with explicit requiredCapabilities and factRequirements, including any request-declared producer->consumer fact relation"),
    ],
  });
  tasks.push(discovery);

  const taskIdByStage = new Map([...selectedReviewStages].map((stage) => [stage, `${runId}:${stage}`]));
  const dependenciesFor = (stage) => reviewDependenciesForStage({
    stage,
    discoveryTaskId: discovery.taskId,
    edges: reviewEdges,
    taskIdByStage,
  });
  const upstreamDecisionHint = (stage) => {
    const required = reviewEdges.filter((edge) => edge.toStage === stage);
    if (required.length === 0) return " No cross-review fact dependency is declared for this stage. Review directly from Product Discovery plus authoritative repository/ADR/Project Memory facts; do not wait for sibling review outputs.";
    return ` Consume these upstream facts before final approval: ${required.map((edge) => `${edge.factId} from ${edge.fromCapabilityId}`).join("; ")}. Do not require any other sibling review output.`;
  };
  const capabilityIdForStage = (stage) => capabilityCatalog.byStage.get(stage)?.capabilityId ?? `review.${stage}`;

  const reviewTaskIds = [];
  for (const capability of selectedReviewCapabilities) {
    const agent = registry.byId.get(capability.agentId);
    const definition = REVIEW_TASK_DEFINITIONS[capability.stage] ?? genericReviewDefinition(capability);
    const reviewTask = governanceTask({
      runId,
      agent,
      stage: capability.stage,
      workItemId,
      initialLevel,
      dependencies: dependenciesFor(capability.stage),
      capabilityId: capability.capabilityId,
      objective: definition.objective(request, upstreamDecisionHint(capability.stage)),
      acceptanceCriteria: definition.acceptanceCriteria(),
    });
    tasks.push(reviewTask);
    reviewTaskIds.push(reviewTask.taskId);
  }

  const refinement = governanceTask({
    runId, agent: technicalLead, stage: STAGES.technicalRefinement, workItemId, initialLevel,
    dependencies: [discovery.taskId, ...reviewTaskIds],
    capabilityId: "process.technical-refinement",
    objective: `Compile the approved product/architecture intent into a machine-readable implementation DAG for: ${request}`,
    acceptanceCriteria: [
      criterion("PROC-TL-1", "runtime", "Every blocking product acceptance criterion is assigned to at least one concrete implementation work item.", "implementationPlan acceptance coverage check passes"),
      criterion("PROC-TL-2", "runtime", "Every work item has one owner, explicit paths, dependencies, validation and bounded scope.", "implementationPlan schema and DAG validation pass"),
      criterion("PROC-TL-3", "runtime", "The implementation DAG is acyclic and executable without developers inferring missing requirements.", "runtime DAG compiler accepts the implementationPlan"),
    ],
  });
  tasks.push(refinement);

  const registryAuthority = {
    orchestrator: registry.orchestrator,
    workflow: registry.workflow,
    agents: registry.agents,
  };
  const provenance = {
    contractVersion: "agent-runtime-provenance/v1",
    plannerVersion: "capability-fact-planner/v1",
    compilerVersion: "technical-lead-compiled-dag/v2",
    requestFingerprint: stableFingerprint(request.trim()),
    registryFingerprint: stableFingerprint(registryAuthority),
    capabilityCatalogFingerprint: stableFingerprint(capabilityCatalog.capabilities),
    reasoningFingerprint: stableFingerprint(reasoning),
    schemaFingerprint: stableFingerprint(schemas),
    policyFingerprint: activePolicy.fingerprint,
  };

  const plan = {
    schemaVersion: 2,
    runId,
    request: request.trim(),
    createdAt,
    phase: "bootstrap",
    reasoning,
    provenance,
    routing: [...new Set([...(reasoning.recommendedAgents ?? []), ...explicitAgents])].map((agentId) => ({
      agentId,
      source: explicitAgents.includes(agentId) ? "explicit" : reasoning.source,
      confidence: explicitAgents.includes(agentId) ? 1 : reasoning.confidence,
    })),
    sharedPathOwner: {},
    workflow: {
      requiresDatabase: reviews.requiresDatabase,
      requiresDevOps: reviews.requiresDevOps,
      requiresAiLlmOps: reviews.requiresAiLlmOps,
      requiresSecurity: reviews.requiresSecurity,
      productOwnerTaskId: discovery.taskId,
      technicalLeadTaskId: refinement.taskId,
      qualityAgentId: qa.id,
      bootstrapReviewTopology: "decision-dependent-v1",
      bootstrapFactTopology: "fact-capability-v2",
      bootstrapTopologyState: "provisional",
      bootstrapTopologyRevision: 1,
      bootstrapTopologyAuthority: "initial-reasoning",
      bootstrapCandidateReviewStages: selectedReviewCapabilities.map((capability) => capability.stage),
      bootstrapFactBindings: materializeBootstrapFactBindings(factTopology.bindings, taskIdByStage),
      // Compatibility projection for V11.5 readers. New policy and replay use
      // bootstrapFactBindings as the authority.
      bootstrapReviewDependencies: materializeBootstrapReviewDependencies(reviewEdges, taskIdByStage),
      implementationPlanRevision: null,
      compiledAt: null,
    },
    tasks,
  };
  const planDecision = activePolicy.evaluatePlan({
    phase: plan.phase,
    bootstrapFactBindings: plan.workflow.bootstrapFactBindings,
    bootstrapReviewDependencies: plan.workflow.bootstrapReviewDependencies,
    topologyState: plan.workflow.bootstrapTopologyState,
  });
  assertPolicyAllowed(planDecision, "runtime_policy_plan_denied");
  plan.policy = {
    contractVersion: activePolicy.contractVersion,
    fingerprint: activePolicy.fingerprint,
    planDecision,
  };
  assertSchema(plan, schemas.executionPlan, "executionPlan");
  return plan;
}

export async function createAdaptiveExecutionPlan({ repositoryRoot, registry, request, schemas, explicitAgents = [], reasoningOptions = {}, identity = null, policyEngine = null }) {
  const reasoningAssessment = await assessReasoning({ repositoryRoot, registry, schemas, request, explicitAgents, ...reasoningOptions });
  return createExecutionPlan({ registry, request, schemas, explicitAgents, reasoningAssessment, identity, policyEngine });
}

export async function saveExecutionPlan(repositoryRoot, plan, filename = "execution-plan.json") {
  const path = join(repositoryRoot, ".runtime", "agents", "runs", plan.runId, filename);
  await writeJson(path, plan);
  return path;
}
