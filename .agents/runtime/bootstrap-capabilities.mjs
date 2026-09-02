export const BOOTSTRAP_CAPABILITY_CONTRACT_VERSION = "bootstrap-capabilities/v1";
export const BOOTSTRAP_FACT_CONTRACT_VERSION = "bootstrap-facts/v1";

export const REVIEW_STAGE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-review$/;

const RESERVED_PROCESS_STAGES = new Set([
  "product-discovery",
  "technical-refinement",
  "implementation",
  "quality-assurance",
  "operational-readiness",
  "product-acceptance",
]);

export function isBootstrapReviewStage(stage) {
  const normalized = String(stage ?? "").trim();
  return REVIEW_STAGE_PATTERN.test(normalized) && !RESERVED_PROCESS_STAGES.has(normalized);
}

const DEFAULT_AUTHORITATIVE_SOURCES = Object.freeze([
  "product-discovery",
  "frozen-adr",
  "project-memory",
  "repository-context",
]);

const FACT_ALIASES = new Map([
  ["state-authority", "decision.state-authority"],
  ["state-and-transaction-authority", "decision.state-authority"],
  ["transaction-boundary", "decision.transaction-boundary"],
  ["consistency-boundary", "decision.consistency-boundary"],
  ["runtime-and-deployment-topology", "decision.runtime-topology"],
  ["runtime-topology", "decision.runtime-topology"],
  ["deployment-topology", "decision.runtime-topology"],
  ["model-and-inference-boundary", "decision.model-inference-boundary"],
  ["model-inference-boundary", "decision.model-inference-boundary"],
  ["database-availability-topology", "decision.database-availability-topology"],
]);

const HEURISTIC_FACT_RULES = Object.freeze([
  {
    factId: "decision.state-authority",
    requiredDecision: "state-and-transaction-authority",
    consumerCapabilityId: "review.database",
    providerCapabilityId: "review.architecture",
    pattern: /\b(source[- ]of[- ]truth|state authority|authoritative (?:store|state)|transaction boundary|consistency boundary|outbox|inbox|exactly[- ]once|event[- ]driven persistence|event[- ]driven.*(?:postgres|database)|(?:postgres|database).*event[- ]driven|redis.*(?:authority|authoritative)|(?:authority|authoritative).*redis)\b/i,
    rationale: "Database review needs an unresolved state/consistency authority decision from Architecture.",
  },
  {
    factId: "decision.runtime-topology",
    requiredDecision: "runtime-and-deployment-topology",
    consumerCapabilityId: "review.infrastructure",
    providerCapabilityId: "review.architecture",
    pattern: /\b(execution plane|control plane|worker topology|queue topology|queue ownership|service boundary|deployment topology|scaling boundary|runtime topology|network boundary|event[- ]driven.*worker|rabbitmq.*topology)\b/i,
    rationale: "Infrastructure review needs an unresolved Runtime/deployment topology decision from Architecture.",
  },
  {
    factId: "decision.model-inference-boundary",
    requiredDecision: "model-and-inference-boundary",
    consumerCapabilityId: "review.ai-operations",
    providerCapabilityId: "review.architecture",
    pattern: /\b(semantic plane|model residency|model routing boundary|inference boundary|embedding service|retrieval topology|gpu scheduler|gpu.*residency|llm fallback semantics|model authority)\b/i,
    rationale: "AI/LLMOps review needs an unresolved model/inference boundary decision from Architecture.",
  },
  {
    factId: "decision.database-availability-topology",
    requiredDecision: "database-availability-topology",
    consumerCapabilityId: "review.infrastructure",
    providerCapabilityId: "review.database",
    pattern: /\b(database failover|postgres(?:ql)? ha|postgres(?:ql)? replication|database replication|database provisioning|connection pool topology)\b/i,
    rationale: "Infrastructure review needs an unresolved database availability/provisioning decision from Database.",
  },
]);

function compact(value) { return String(value ?? "").trim(); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }

export function normalizeFactId(value) {
  const compacted = compact(value).toLowerCase().replace(/\s+/g, "-");
  if (!compacted) throw new Error("bootstrap_fact_id_missing");
  if (FACT_ALIASES.has(compacted)) return FACT_ALIASES.get(compacted);
  if (compacted.startsWith("decision.")) return compacted;
  return `decision.${compacted.replace(/^decision[-.]/, "")}`;
}

export function capabilityCatalogFromRegistry(registry) {
  const bootstrap = registry?.workflow?.bootstrap ?? {};
  const raw = bootstrap.reviewCapabilities;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("bootstrap_capability_catalog_missing");
  const capabilities = raw.map((entry) => {
    const capabilityId = compact(entry.capabilityId);
    const stage = compact(entry.stage);
    const agentId = compact(entry.agentId);
    if (!capabilityId) throw new Error(`bootstrap_capability_id_missing:${stage || agentId || "unknown"}`);
    if (!isBootstrapReviewStage(stage)) throw new Error(`bootstrap_capability_stage_invalid:${stage}`);
    if (!agentId || !registry.byId?.has(agentId)) throw new Error(`bootstrap_capability_agent_invalid:${agentId || "missing"}`);
    const providesFacts = unique((entry.providesFacts ?? []).map(normalizeFactId));
    if (providesFacts.length === 0) throw new Error(`bootstrap_capability_facts_missing:${capabilityId}`);
    return Object.freeze({ kind: "review", capabilityId, stage, agentId, impactField: entry.impactField ?? null, providesFacts });
  });
  const byId = new Map();
  const byStage = new Map();
  const providersByFact = new Map();
  for (const capability of capabilities) {
    if (byId.has(capability.capabilityId)) throw new Error(`bootstrap_capability_duplicate:${capability.capabilityId}`);
    if (byStage.has(capability.stage)) throw new Error(`bootstrap_capability_stage_duplicate:${capability.stage}`);
    byId.set(capability.capabilityId, capability);
    byStage.set(capability.stage, capability);
    for (const factId of capability.providesFacts) {
      const providers = providersByFact.get(factId) ?? [];
      providers.push(capability);
      providersByFact.set(factId, providers);
    }
  }
  const factResolution = bootstrap.factResolution ?? {};
  const factContractVersion = compact(factResolution.contractVersion) || BOOTSTRAP_FACT_CONTRACT_VERSION;
  if (factContractVersion !== BOOTSTRAP_FACT_CONTRACT_VERSION) throw new Error(`bootstrap_fact_contract_version_invalid:${factContractVersion}`);
  const authoritativeSources = unique(factResolution.authoritativeSources ?? DEFAULT_AUTHORITATIVE_SOURCES);
  if (authoritativeSources.length === 0) throw new Error("bootstrap_fact_authoritative_sources_missing");
  return {
    contractVersion: BOOTSTRAP_CAPABILITY_CONTRACT_VERSION,
    factContractVersion,
    capabilities,
    reviewStages: capabilities.map((capability) => capability.stage),
    byId,
    byStage,
    providersByFact,
    authoritativeSources: new Set(authoritativeSources),
  };
}

function requirementIdentity(requirement) { return `${requirement.consumerCapabilityId}|${requirement.factId}`; }
function requirementKey(requirement) {
  return [requirement.consumerCapabilityId, requirement.factId, requirement.resolution, requirement.providerCapabilityId ?? "", requirement.source].join("|");
}

function resolveProviderCapability({ catalog, factId, requestedProviderCapabilityId }) {
  if (requestedProviderCapabilityId) {
    const provider = catalog.byId.get(requestedProviderCapabilityId);
    if (!provider) throw new Error(`bootstrap_fact_provider_capability_unknown:${requestedProviderCapabilityId}`);
    if (!provider.providesFacts.includes(factId)) throw new Error(`bootstrap_fact_provider_does_not_provide:${requestedProviderCapabilityId}:${factId}`);
    return provider;
  }
  const providers = catalog.providersByFact.get(factId) ?? [];
  if (providers.length === 0) throw new Error(`bootstrap_fact_provider_missing:${factId}`);
  if (providers.length > 1) throw new Error(`bootstrap_fact_provider_ambiguous:${factId}:${providers.map((provider) => provider.capabilityId).sort().join(",")}`);
  return providers[0];
}

export function normalizeBootstrapFactRequirements(value, { catalog, provenance = "reasoning" } = {}) {
  if (value == null) return [];
  if (!catalog) throw new Error("bootstrap_capability_catalog_required");
  if (!Array.isArray(value)) throw new Error("bootstrap_fact_requirements_invalid");
  const seen = new Set();
  const identityMap = new Map();
  const normalized = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("bootstrap_fact_requirement_invalid_entry");
    const factId = normalizeFactId(raw.factId ?? raw.requiredDecision);
    const consumerCapabilityId = compact(raw.consumerCapabilityId);
    const consumer = catalog.byId.get(consumerCapabilityId);
    if (!consumer) throw new Error(`bootstrap_fact_consumer_capability_unknown:${consumerCapabilityId || "missing"}`);
    const resolution = compact(raw.resolution || (raw.providerCapabilityId ? "review" : "authoritative-context"));
    if (!["review", "authoritative-context"].includes(resolution)) throw new Error(`bootstrap_fact_resolution_invalid:${resolution}`);
    const source = compact(raw.source || provenance);
    const evidence = compact(raw.evidence);
    const rationale = compact(raw.rationale);
    if (!source) throw new Error("bootstrap_fact_source_missing");
    if (!evidence) throw new Error("bootstrap_fact_evidence_missing");
    if (!rationale) throw new Error("bootstrap_fact_rationale_missing");

    let providerCapabilityId = null;
    if (resolution === "authoritative-context") {
      if (!catalog.authoritativeSources.has(source)) throw new Error(`bootstrap_fact_authoritative_source_invalid:${source}`);
      if (compact(raw.providerCapabilityId)) throw new Error(`bootstrap_fact_authoritative_provider_forbidden:${factId}`);
    } else {
      const provider = resolveProviderCapability({ catalog, factId, requestedProviderCapabilityId: compact(raw.providerCapabilityId) });
      providerCapabilityId = provider.capabilityId;
      if (providerCapabilityId === consumerCapabilityId) throw new Error(`bootstrap_fact_self_dependency:${consumerCapabilityId}:${factId}`);
    }

    const requirement = {
      factId,
      legacyRequiredDecision: compact(raw.requiredDecision) || null,
      consumerCapabilityId,
      resolution,
      providerCapabilityId,
      source,
      evidence,
      rationale,
      provenance: compact(raw.provenance) || provenance,
    };
    const identity = requirementIdentity(requirement);
    const prior = identityMap.get(identity);
    if (prior && (prior.resolution !== requirement.resolution || prior.providerCapabilityId !== requirement.providerCapabilityId || prior.source !== requirement.source)) {
      throw new Error(`bootstrap_fact_requirement_conflict:${consumerCapabilityId}:${factId}`);
    }
    identityMap.set(identity, requirement);
    const key = requirementKey(requirement);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(requirement);
  }
  return normalized;
}

export function legacyEdgesToFactRequirements(edges, { catalog, provenance = "legacy-bootstrap-review-dependency" } = {}) {
  if (!Array.isArray(edges)) return [];
  return normalizeBootstrapFactRequirements(edges.map((edge) => {
    const provider = catalog.byStage.get(compact(edge.fromStage));
    const consumer = catalog.byStage.get(compact(edge.toStage));
    if (!provider) throw new Error(`bootstrap_fact_legacy_provider_stage_unknown:${edge.fromStage}`);
    if (!consumer) throw new Error(`bootstrap_fact_legacy_consumer_stage_unknown:${edge.toStage}`);
    return {
      factId: normalizeFactId(edge.requiredDecision),
      consumerCapabilityId: consumer.capabilityId,
      resolution: "review",
      providerCapabilityId: provider.capabilityId,
      source: "reasoning",
      evidence: compact(edge.evidence) || `Legacy V11.5 edge ${edge.fromStage}->${edge.toStage}`,
      rationale: compact(edge.rationale) || `Legacy dependency ${edge.fromStage}->${edge.toStage}`,
      provenance: edge.provenance || provenance,
    };
  }), { catalog, provenance });
}

export function inferBootstrapFactRequirements({ request, catalog }) {
  const text = String(request ?? "");
  return normalizeBootstrapFactRequirements(HEURISTIC_FACT_RULES
    .filter((rule) => catalog.byId.has(rule.consumerCapabilityId) && catalog.byId.has(rule.providerCapabilityId) && rule.pattern.test(text))
    .map((rule) => ({
      ...rule,
      resolution: "review",
      source: "reasoning",
      evidence: `High-confidence bounded heuristic matched request text for ${rule.factId}.`,
      provenance: "heuristic-fact-dependency",
    })), { catalog, provenance: "heuristic-fact-dependency" });
}

function assertAcyclic(edges, stages) {
  const selected = new Set(stages);
  const outgoing = new Map([...selected].map((stage) => [stage, []]));
  const indegree = new Map([...selected].map((stage) => [stage, 0]));
  for (const edge of edges) {
    if (!selected.has(edge.fromStage) || !selected.has(edge.toStage)) continue;
    outgoing.get(edge.fromStage).push(edge.toStage);
    indegree.set(edge.toStage, (indegree.get(edge.toStage) ?? 0) + 1);
  }
  const queue = [...selected].filter((stage) => (indegree.get(stage) ?? 0) === 0).sort();
  let visited = 0;
  while (queue.length > 0) {
    const stage = queue.shift();
    visited += 1;
    for (const target of outgoing.get(stage) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
    queue.sort();
  }
  if (visited !== selected.size) {
    const cyclic = [...selected].filter((stage) => (indegree.get(stage) ?? 0) > 0).sort();
    throw new Error(`bootstrap_fact_dependency_cycle:${cyclic.join(",")}`);
  }
}

export function resolveBootstrapFactTopology({ catalog, requirements = [] }) {
  if (!catalog) throw new Error("bootstrap_capability_catalog_required");
  const normalized = normalizeBootstrapFactRequirements(requirements, { catalog });
  const requiredCapabilityIds = new Set();
  const edges = [];
  const edgeSeen = new Set();
  const bindings = [];
  for (const requirement of normalized) {
    const consumer = catalog.byId.get(requirement.consumerCapabilityId);
    requiredCapabilityIds.add(consumer.capabilityId);
    if (requirement.resolution === "authoritative-context") {
      bindings.push({ ...requirement, consumerStage: consumer.stage, providerStage: null, status: "resolved" });
      continue;
    }
    const provider = catalog.byId.get(requirement.providerCapabilityId);
    requiredCapabilityIds.add(provider.capabilityId);
    const edge = {
      fromCapabilityId: provider.capabilityId,
      toCapabilityId: consumer.capabilityId,
      fromStage: provider.stage,
      toStage: consumer.stage,
      requiredDecision: requirement.factId,
      legacyRequiredDecision: requirement.legacyRequiredDecision,
      factId: requirement.factId,
      rationale: requirement.rationale,
      evidence: requirement.evidence,
      source: requirement.source,
      provenance: requirement.provenance,
    };
    const key = `${edge.fromStage}->${edge.toStage}:${edge.factId}`;
    if (!edgeSeen.has(key)) { edgeSeen.add(key); edges.push(edge); }
    bindings.push({ ...requirement, consumerStage: consumer.stage, providerStage: provider.stage, status: "unresolved-review-input" });
  }
  const stages = unique([...requiredCapabilityIds].map((id) => catalog.byId.get(id)?.stage));
  assertAcyclic(edges, stages);
  return {
    contractVersion: catalog.factContractVersion,
    capabilityContractVersion: catalog.contractVersion,
    requirements: normalized,
    bindings,
    edges,
    requiredCapabilityIds: [...requiredCapabilityIds].sort(),
  };
}

export function materializeBootstrapFactBindings(bindings, taskIdByStage) {
  return bindings.map((binding) => ({
    factId: binding.factId,
    status: binding.status,
    resolution: binding.resolution,
    consumerCapabilityId: binding.consumerCapabilityId,
    consumerStage: binding.consumerStage,
    consumerTaskId: taskIdByStage.get(binding.consumerStage) ?? null,
    providerCapabilityId: binding.providerCapabilityId,
    providerStage: binding.providerStage,
    providerTaskId: binding.providerStage ? (taskIdByStage.get(binding.providerStage) ?? null) : null,
    source: binding.source,
    evidence: binding.evidence,
    rationale: binding.rationale,
    provenance: binding.provenance,
  }));
}

export function capabilityIdsForStages(catalog, stages) {
  return unique([...stages].map((stage) => catalog.byStage.get(stage)?.capabilityId));
}
