import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { ACCEPTANCE_PROOF_STAGES } from "./acceptance-criteria.mjs";
import { auxiliaryInvocationFromStructuredResult } from "./auxiliary-telemetry.mjs";
import { runOpenCodeStructuredOutput } from "./opencode-structured-output.mjs";
import { assertSchema } from "./schema-validator.mjs";
import { exists } from "./utils.mjs";

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function text(value) { return String(value ?? "").trim(); }
function normalizePath(value) { return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, ""); }

const PRODUCT_CRITERION_FIELDS = Object.freeze(["id", "source", "statement", "blocking", "verification"]);
const PRODUCT_CRITERION_EXTENSIONS = new Set([".md", ".json", ".yaml", ".yml", ".txt"]);

function processCriterionIds(brief) {
  return new Set((brief?.acceptanceCriteria ?? []).map((criterion) => text(criterion?.id)).filter(Boolean));
}

function isProcessCriterion(criterion, brief) {
  const id = text(criterion?.id);
  if (!id) return false;
  return processCriterionIds(brief).has(id) || /^PROC-/i.test(id);
}

function proofStageValid(value) {
  return ACCEPTANCE_PROOF_STAGES.includes(text(value));
}

export function productDiscoveryAcceptanceCriteriaIssue({ brief, handoff, requireComplete = false }) {
  if (brief?.sdd?.stage !== "product-discovery") return null;
  if (requireComplete && handoff?.status !== "complete") return null;
  const criteria = Array.isArray(handoff?.acceptanceCriteria) ? handoff.acceptanceCriteria : [];
  if (criteria.length === 0) {
    return { code: "product_acceptance_criteria_missing", reason: "product_acceptance_criteria_missing" };
  }
  const ids = new Set();
  for (const criterion of criteria) {
    const id = text(criterion?.id);
    if (isProcessCriterion(criterion, brief)) {
      return { code: "product_acceptance_process_criterion_leaked", reason: `process_criterion_leaked:${id || "missing"}`, criterionId: id || null };
    }
    if (!id || !text(criterion?.source) || !text(criterion?.statement) || typeof criterion?.blocking !== "boolean" || !text(criterion?.verification)) {
      return { code: "product_acceptance_criterion_invalid", reason: `product_criterion_invalid:${id || "missing"}`, criterionId: id || null };
    }
    if (!Object.hasOwn(criterion, "proofStage")) {
      return { code: "product_acceptance_proof_stage_missing", reason: `proof_stage_missing:${id}`, criterionId: id };
    }
    if (!proofStageValid(criterion.proofStage)) {
      return { code: "product_acceptance_proof_stage_invalid", reason: `proof_stage_invalid:${id}:${text(criterion.proofStage)}`, criterionId: id };
    }
    if (ids.has(id)) {
      return { code: "product_acceptance_criterion_duplicate", reason: `product_criterion_duplicate:${id}`, criterionId: id };
    }
    ids.add(id);
  }
  return null;
}

function productCriterionSchema({ forbiddenIds = [] } = {}) {
  const idSchema = { type: "string", minLength: 1 };
  if (forbiddenIds.length > 0) idSchema.not = { enum: forbiddenIds };
  return {
    type: "object",
    additionalProperties: false,
    required: [...PRODUCT_CRITERION_FIELDS, "proofStage"],
    properties: {
      id: idSchema,
      source: { type: "string", minLength: 1 },
      statement: { type: "string", minLength: 1 },
      blocking: { type: "boolean" },
      verification: { type: "string", minLength: 1 },
      proofStage: { enum: [...ACCEPTANCE_PROOF_STAGES] },
    },
  };
}

export function buildProductDiscoveryAcceptanceCriteriaProjectionSchema({ brief }) {
  const forbiddenIds = [...processCriterionIds(brief)].sort();
  return {
    type: "object",
    additionalProperties: false,
    required: ["acceptanceCriteria"],
    properties: {
      acceptanceCriteria: {
        type: "array",
        minItems: 1,
        items: productCriterionSchema({ forbiddenIds }),
      },
    },
  };
}

async function productEvidence({ workspace, handoff, maxBytes = 96_000 }) {
  const paths = [...new Set([...(handoff?.changedPaths ?? []), ...(handoff?.reusedPaths ?? [])].map(normalizePath))]
    .filter((path) => /(^|\/)PRD\.(md|json|ya?ml|txt)$/i.test(path) || /^docs\/(product|specs)\//.test(path));
  const evidence = [];
  let used = 0;
  for (const path of paths) {
    const absolute = resolve(workspace, path);
    const rel = relative(resolve(workspace), absolute);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../")) continue;
    if (!PRODUCT_CRITERION_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    if (!(await exists(absolute))) continue;
    let content;
    try { content = await readFile(absolute, "utf8"); } catch { continue; }
    const remaining = maxBytes - used;
    if (remaining <= 0) break;
    const bytes = Buffer.from(content);
    const clipped = bytes.byteLength > remaining ? bytes.subarray(0, remaining).toString("utf8") : content;
    used += Buffer.byteLength(clipped);
    evidence.push({ path, content: clipped, truncated: Buffer.byteLength(content) > Buffer.byteLength(clipped) });
  }
  return evidence;
}

function compactExistingProductCriteria({ brief, handoff }) {
  return (handoff?.acceptanceCriteria ?? [])
    .filter((criterion) => !isProcessCriterion(criterion, brief))
    .map((criterion) => clone(criterion));
}

export function buildProductDiscoveryAcceptanceCriteriaProjectionPrompt({ brief, handoff, evidence, issue }) {
  const processCriteria = (brief?.acceptanceCriteria ?? []).map((criterion) => ({
    id: criterion.id,
    statement: criterion.statement,
    verification: criterion.verification,
  }));
  const existingProductCriteria = compactExistingProductCriteria({ brief, handoff });
  const payload = {
    objective: brief?.objective ?? null,
    issue,
    processCriteria,
    existingProductCriteria,
    productEvidence: evidence,
  };
  return `Project ONLY the Product Discovery product acceptanceCriteria catalog for an already-produced Agentic Harness Handoff Result v2.\n\nThis is a bounded same-attempt semantic projection. Do not call tools, edit files, change status, criterionResults, validation, bootstrapReviewAssessment, sddReview, changedPaths, reusedPaths, or invent product behavior. Return ONLY the acceptanceCriteria envelope requested by the supplied JSON schema.\n\nCritical boundary rules:\n- Task Brief.acceptanceCriteria contains Runtime PROCESS gates (for example PROC-PO-*). Those IDs belong only in handoff.criterionResults and MUST NEVER appear in handoff.acceptanceCriteria.\n- handoff.acceptanceCriteria is exclusively the Product Owner product-behavior catalog consumed by Technical Refinement, QA/readiness and Product Acceptance.\n- Every product criterion MUST emit proofStage explicitly. Never rely on historical text inference.\n- proofStage=implementation only when an implementation work item can prove the criterion; quality-assurance for independent QA proof; product-acceptance only when the Product Owner acceptance gate is the authoritative proof point; use database-readiness/infrastructure-readiness/ai-readiness only for those specialist proof points.\n- Preserve every existing non-process criterion's id/source/statement/blocking/verification byte-for-byte. Repair only its missing/invalid proofStage unless supplied productEvidence proves that the existing catalog itself is incomplete or duplicated.\n- If no usable non-process criteria exist, extract stable product criteria only from supplied productEvidence. Every emitted ID must be grounded in that evidence.\n- If the evidence does not contain at least one stable product criterion, fail rather than fabricate one.\n\nINPUT:\n${JSON.stringify(payload, null, 2)}`;
}

function assertProjectionPreservesExisting({ brief, handoff, projected }) {
  const existing = compactExistingProductCriteria({ brief, handoff });
  const byId = new Map(projected.map((criterion) => [criterion.id, criterion]));
  for (const criterion of existing) {
    const next = byId.get(criterion.id);
    if (!next) throw new Error(`product_discovery_acceptance_criteria_projection_dropped_existing:${criterion.id}`);
    for (const field of PRODUCT_CRITERION_FIELDS) {
      if (JSON.stringify(next[field]) !== JSON.stringify(criterion[field])) {
        throw new Error(`product_discovery_acceptance_criteria_projection_mutated_existing:${criterion.id}:${field}`);
      }
    }
  }
}

function assertProjectionGrounded({ brief, handoff, projected, evidence }) {
  const existingIds = new Set(compactExistingProductCriteria({ brief, handoff }).map((criterion) => criterion.id));
  const evidenceText = evidence.map((item) => item.content).join("\n");
  for (const criterion of projected) {
    if (isProcessCriterion(criterion, brief)) throw new Error(`product_discovery_acceptance_criteria_projection_process_leak:${criterion.id}`);
    if (existingIds.has(criterion.id)) continue;
    if (!evidenceText.includes(String(criterion.id))) {
      throw new Error(`product_discovery_acceptance_criteria_projection_ungrounded_id:${criterion.id}`);
    }
  }
}

function usageFromInfo(info) {
  const tokens = info?.tokens ?? info?.usage?.tokens ?? null;
  return {
    inputTokens: Number(tokens?.input ?? info?.usage?.inputTokens ?? 0),
    outputTokens: Number(tokens?.output ?? info?.usage?.outputTokens ?? 0),
    cachedInputTokens: Number(tokens?.cache?.read ?? info?.usage?.cachedInputTokens ?? 0),
    costUsd: Number(info?.cost ?? info?.usage?.costUsd ?? 0),
  };
}

export async function projectProductDiscoveryAcceptanceCriteria({
  workspace,
  model,
  brief,
  handoff,
  structuredRunner = runOpenCodeStructuredOutput,
}) {
  const issue = productDiscoveryAcceptanceCriteriaIssue({ brief, handoff, requireComplete: true });
  if (!issue) return { handoff, attempted: false, issue: null, model: null, sessionId: null };

  const evidence = await productEvidence({ workspace, handoff });
  const existingProductCriteria = compactExistingProductCriteria({ brief, handoff });
  if (existingProductCriteria.length === 0 && evidence.length === 0) {
    throw new Error(`product_discovery_acceptance_criteria_projection_evidence_missing:${issue.code}`);
  }

  const schema = buildProductDiscoveryAcceptanceCriteriaProjectionSchema({ brief });
  const result = await structuredRunner({
    workspace,
    model,
    agentId: brief.agentId,
    schema,
    prompt: buildProductDiscoveryAcceptanceCriteriaProjectionPrompt({ brief, handoff, evidence, issue }),
    title: `${brief.taskId} product acceptance criteria projection`,
  });
  assertSchema(result.value, schema, "productDiscoveryAcceptanceCriteriaProjection");
  const projected = clone(result.value.acceptanceCriteria);
  assertProjectionPreservesExisting({ brief, handoff, projected });
  assertProjectionGrounded({ brief, handoff, projected, evidence });

  const next = clone(handoff);
  next.acceptanceCriteria = projected;
  const remainingIssue = productDiscoveryAcceptanceCriteriaIssue({ brief, handoff: next, requireComplete: true });
  if (remainingIssue) throw new Error(`product_discovery_acceptance_criteria_projection_incomplete:${remainingIssue.code}:${remainingIssue.reason}`);

  const usage = usageFromInfo(result.info);
  next.findings = [
    ...(Array.isArray(next.findings) ? next.findings : []),
    {
      type: "product_discovery_acceptance_criteria_projection",
      status: "succeeded",
      reason: issue.reason,
      authority: "bounded-product-discovery-acceptance-criteria-projection",
      modelId: model,
      sessionId: result.sessionId ?? null,
      attempts: Number(result.attempts ?? 1),
      processCriteriaExcluded: (brief.acceptanceCriteria ?? []).map((criterion) => criterion.id),
    },
  ];
  next.auxiliaryInvocations = [
    ...(next.auxiliaryInvocations ?? []),
    auxiliaryInvocationFromStructuredResult({ purpose: "product-discovery-acceptance-criteria", model, result }),
  ];
  next.metrics = {
    ...(next.metrics ?? {}),
    inputTokens: Number(next.metrics?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: Number(next.metrics?.outputTokens ?? 0) + usage.outputTokens,
    cachedInputTokens: Number(next.metrics?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
    costUsd: Number(next.metrics?.costUsd ?? 0) + usage.costUsd,
  };
  return { handoff: next, attempted: true, issue, model, sessionId: result.sessionId ?? null, usage, evidencePaths: evidence.map((item) => item.path) };
}
