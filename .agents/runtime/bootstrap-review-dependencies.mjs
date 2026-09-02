const REVIEW_STAGES = [
  "architecture-review",
  "database-review",
  "infrastructure-review",
  "ai-operations-review",
  "security-review",
];

const REVIEW_STAGE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-review$/;

const HEURISTIC_RULES = [
  {
    fromStage: "architecture-review",
    toStage: "database-review",
    requiredDecision: "state-and-transaction-authority",
    pattern: /\b(source[- ]of[- ]truth|state authority|authoritative (?:store|state)|transaction boundary|consistency boundary|outbox|inbox|exactly[- ]once|event[- ]driven persistence|event[- ]driven.*(?:postgres|database)|(?:postgres|database).*event[- ]driven|redis.*(?:authority|authoritative)|(?:authority|authoritative).*redis)\b/i,
    rationale: "Database review depends on an architectural authority/consistency decision that is not safely inferable from persistence mechanics alone.",
  },
  {
    fromStage: "architecture-review",
    toStage: "infrastructure-review",
    requiredDecision: "runtime-and-deployment-topology",
    pattern: /\b(execution plane|control plane|worker topology|queue topology|queue ownership|service boundary|deployment topology|scaling boundary|runtime topology|network boundary|event[- ]driven.*worker|rabbitmq.*topology)\b/i,
    rationale: "Infrastructure review depends on an architectural runtime/topology decision before it can finalize deployment and capacity constraints.",
  },
  {
    fromStage: "architecture-review",
    toStage: "ai-operations-review",
    requiredDecision: "model-and-inference-boundary",
    pattern: /\b(semantic plane|model residency|model routing boundary|inference boundary|embedding service|retrieval topology|gpu scheduler|gpu.*residency|llm fallback semantics|model authority)\b/i,
    rationale: "AI/LLMOps review depends on an architectural model/inference boundary before it can finalize operational gates.",
  },
  {
    fromStage: "database-review",
    toStage: "infrastructure-review",
    requiredDecision: "database-availability-topology",
    pattern: /\b(database failover|postgres(?:ql)? ha|postgres(?:ql)? replication|database replication|database provisioning|connection pool topology)\b/i,
    rationale: "Infrastructure review depends on a database availability/provisioning decision before it can finalize runtime readiness constraints.",
  },
];

function compact(value) {
  return String(value ?? "").trim();
}

function edgeKey(edge) {
  return `${edge.fromStage}->${edge.toStage}:${edge.requiredDecision}`;
}

function assertReviewStage(stage, field) {
  if (!REVIEW_STAGE_PATTERN.test(stage)) throw new Error(`bootstrap_review_dependency_invalid_${field}:${stage}`);
}

export function bootstrapReviewStages() {
  return [...REVIEW_STAGES];
}

export function normalizeBootstrapReviewDependencies(value, { provenance = "reasoning" } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("bootstrap_review_dependencies_invalid");
  const seen = new Set();
  const normalized = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("bootstrap_review_dependency_invalid_entry");
    const fromStage = compact(raw.fromStage);
    const toStage = compact(raw.toStage);
    const requiredDecision = compact(raw.requiredDecision);
    const rationale = compact(raw.rationale);
    assertReviewStage(fromStage, "source");
    assertReviewStage(toStage, "target");
    if (fromStage === toStage) throw new Error(`bootstrap_review_dependency_self_cycle:${fromStage}`);
    if (!requiredDecision) throw new Error("bootstrap_review_dependency_required_decision_missing");
    if (!rationale) throw new Error("bootstrap_review_dependency_rationale_missing");
    const edge = {
      fromStage,
      toStage,
      requiredDecision,
      rationale,
      provenance: compact(raw.provenance) || provenance,
    };
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(edge);
  }
  return normalized;
}

export function inferBootstrapReviewDependencies({ request, selectedStages = REVIEW_STAGES }) {
  const selected = new Set(selectedStages);
  const text = String(request ?? "");
  return HEURISTIC_RULES
    .filter((rule) => selected.has(rule.fromStage) && selected.has(rule.toStage) && rule.pattern.test(text))
    .map((rule) => ({
      fromStage: rule.fromStage,
      toStage: rule.toStage,
      requiredDecision: rule.requiredDecision,
      rationale: rule.rationale,
      provenance: "heuristic-decision-dependency",
    }));
}

export function mergeBootstrapReviewDependencies(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const edge of group ?? []) {
      const key = edgeKey(edge);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(edge);
    }
  }
  return merged;
}

export function assertAcyclicBootstrapReviewDependencies(edges, selectedStages = REVIEW_STAGES) {
  const selected = new Set(selectedStages);
  const outgoing = new Map([...selected].map((stage) => [stage, []]));
  const indegree = new Map([...selected].map((stage) => [stage, 0]));
  for (const edge of edges) {
    if (!selected.has(edge.fromStage) || !selected.has(edge.toStage)) continue;
    outgoing.get(edge.fromStage).push(edge.toStage);
    indegree.set(edge.toStage, (indegree.get(edge.toStage) ?? 0) + 1);
  }
  const queue = [...selected].filter((stage) => (indegree.get(stage) ?? 0) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const stage = queue.shift();
    visited += 1;
    for (const target of outgoing.get(stage) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  if (visited !== selected.size) {
    const cyclicStages = [...selected].filter((stage) => (indegree.get(stage) ?? 0) > 0).sort();
    throw new Error(`bootstrap_review_dependency_cycle:${cyclicStages.join(",")}`);
  }
}

export function dependencyStagesFromEdges(edges) {
  return new Set(edges.flatMap((edge) => [edge.fromStage, edge.toStage]));
}

export function reviewDependenciesForStage({ stage, discoveryTaskId, edges, taskIdByStage }) {
  const upstream = edges
    .filter((edge) => edge.toStage === stage)
    .map((edge) => taskIdByStage.get(edge.fromStage))
    .filter(Boolean);
  return [...new Set([discoveryTaskId, ...upstream])];
}

export function materializeBootstrapReviewDependencies(edges, taskIdByStage) {
  return edges.map((edge) => ({
    fromStage: edge.fromStage,
    toStage: edge.toStage,
    fromTaskId: taskIdByStage.get(edge.fromStage) ?? null,
    toTaskId: taskIdByStage.get(edge.toStage) ?? null,
    requiredDecision: edge.requiredDecision,
    ...(edge.factId ? { factId: edge.factId } : {}),
    ...(edge.fromCapabilityId ? { fromCapabilityId: edge.fromCapabilityId } : {}),
    ...(edge.toCapabilityId ? { toCapabilityId: edge.toCapabilityId } : {}),
    ...(edge.legacyRequiredDecision ? { legacyRequiredDecision: edge.legacyRequiredDecision } : {}),
    rationale: edge.rationale,
    provenance: edge.provenance,
  }));
}
