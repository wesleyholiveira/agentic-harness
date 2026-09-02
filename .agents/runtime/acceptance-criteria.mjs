export const ACCEPTANCE_PROOF_STAGES = Object.freeze([
  "implementation",
  "quality-assurance",
  "database-readiness",
  "infrastructure-readiness",
  "ai-readiness",
  "product-acceptance",
]);

const PROOF_STAGE_SET = new Set(ACCEPTANCE_PROOF_STAGES);

function evidenceText(criterion) {
  return `${criterion?.statement ?? ""} ${criterion?.verification ?? ""}`.toLowerCase();
}

export function acceptanceCriterionProofStage(criterion) {
  const explicit = String(criterion?.proofStage ?? "").trim();
  if (PROOF_STAGE_SET.has(explicit)) return explicit;

  // Backward-compatible inference for historical Product Owner criteria that
  // predate proofStage. New Product Discovery handoffs should always emit the
  // field explicitly; this fallback only prevents old artifacts from forcing
  // downstream process gates onto implementation work items.
  const text = evidenceText(criterion);
  if (/product\s+acceptance|accept(?:ed|ance)\s+by\s+(?:the\s+)?product|product\s+owner\s+accept/.test(text)) return "product-acceptance";
  if (/\bqa\b|quality\s+assurance|independent\s+(?:qa|verification)|qa\s+confirm/.test(text)) return "quality-assurance";
  if (/database\s+readiness|migration\s+(?:safety|rollback)|database\s+rollback/.test(text)) return "database-readiness";
  if (/deploy(?:ment|ability)|operational\s+readiness|infrastructure\s+readiness|rollback\s+readiness|observability\s+readiness/.test(text)) return "infrastructure-readiness";
  if (/ai\s*(?:\/|and)?\s*ml\s+readiness|model\s+drift|model\s+rollback|llm\s+readiness/.test(text)) return "ai-readiness";
  return "implementation";
}

export function criteriaForProofStages(criteria, stages) {
  const allowed = new Set(stages);
  return (criteria ?? []).filter((criterion) => allowed.has(acceptanceCriterionProofStage(criterion)));
}

export function implementationProofCriteria(criteria) {
  return criteriaForProofStages(criteria, ["implementation"]);
}

export function qaProofCriteria(criteria) {
  return criteriaForProofStages(criteria, ["implementation", "quality-assurance"]);
}

export function databaseReadinessProofCriteria(criteria) {
  return criteriaForProofStages(criteria, ["database-readiness"]);
}

export function infrastructureReadinessProofCriteria(criteria) {
  return criteriaForProofStages(criteria, ["infrastructure-readiness"]);
}

export function aiReadinessProofCriteria(criteria) {
  return criteriaForProofStages(criteria, ["ai-readiness"]);
}

export function nonAcceptanceProofCriteria(criteria) {
  return (criteria ?? []).filter((criterion) => acceptanceCriterionProofStage(criterion) !== "product-acceptance");
}
