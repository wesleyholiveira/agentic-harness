import { assertSchema } from "./schema-validator.mjs";
import { evaluateCompletion } from "./completion-gate.mjs";
import { runOpenCodeStructuredOutput } from "./opencode-structured-output.mjs";
import { auxiliaryInvocationFromStructuredResult } from "./auxiliary-telemetry.mjs";

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function text(value) { return String(value ?? "").trim(); }

const DOWNSTREAM_PENDING = /\b(downstream|architecture|architect(?:ure)?|devops|infrastructure|ai\/?llmops|ai operations|tech(?:nical)? lead|technical refinement|quality assurance|\bqa\b|operational readiness|product acceptance)\b.*\b(pending|remain(?:s|ing)?|not (?:yet )?(?:complete|completed|run)|unexecuted|awaiting)\b/i;
const GENERIC_DOC_VALIDATION = /\b(documentation|docs(?::check)?|doc(?:s)? validation)\b.*\b(unexecuted|not (?:yet )?(?:run|executed|passed)|must pass|pending)\b/i;

export function classifyProductDiscoveryScopeRisk(risk, brief) {
  const value = text(risk);
  if (!value) return "empty";
  if (DOWNSTREAM_PENDING.test(value)) return "downstream-review-not-prerequisite";
  if (GENERIC_DOC_VALIDATION.test(value) && (brief?.validation ?? []).length === 0) return "unscoped-validation-not-authorized";
  return null;
}

function currentTaskEvidenceIsComplete(brief, handoff) {
  const probe = clone(handoff);
  probe.status = "complete";
  probe.residualRisks = [];
  probe.followUps = (probe.followUps ?? []).filter((item) => !/^required:/i.test(String(item ?? "")));
  if (probe.sddReview?.decision === "blocked" || probe.sddReview?.decision === "changes_requested") delete probe.sddReview;
  const result = evaluateCompletion({ taskBrief: brief, handoff: probe });
  if (!result.accepted) return false;
  const criteria = Array.isArray(probe.acceptanceCriteria) ? probe.acceptanceCriteria : [];
  if (criteria.length === 0) return false;
  const ids = new Set();
  for (const criterion of criteria) {
    if (!text(criterion?.id) || !text(criterion?.statement) || !text(criterion?.verification) || !text(criterion?.proofStage)) return false;
    if (ids.has(criterion.id)) return false;
    ids.add(criterion.id);
  }
  return true;
}

export function productDiscoveryScopeRepairReason({ brief, handoff }) {
  if (brief?.sdd?.stage !== "product-discovery" || handoff?.status !== "blocked") return null;
  const risks = (handoff.residualRisks ?? []).map(text).filter(Boolean);
  if (risks.length === 0) return null;
  const classifications = risks.map((risk) => classifyProductDiscoveryScopeRisk(risk, brief));
  if (classifications.some((item) => item === null)) return null;
  if (!currentTaskEvidenceIsComplete(brief, handoff)) return null;
  return `product_discovery_out_of_scope_blocker:${[...new Set(classifications)].join(",")}`;
}

export function buildProductDiscoveryScopeRepairSchema(brief) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "residualRisks", "followUps", "sddReview"],
    properties: {
      status: { enum: ["complete", "failed", "blocked"] },
      residualRisks: { type: "array", items: { type: "string", minLength: 1 } },
      followUps: { type: "array", items: { type: "string", minLength: 1 } },
      sddReview: {
        type: "object",
        additionalProperties: false,
        required: ["role", "stage", "decision", "reviewedRevision", "requiredDeltas", "nextRole"],
        properties: {
          role: { const: String(brief.sdd?.role ?? brief.agentId) },
          stage: { const: "product-discovery" },
          decision: { enum: ["approved", "changes_requested", "blocked"] },
          reviewedRevision: { const: Number(brief.sdd?.reviewedRevision ?? 1) },
          requiredDeltas: { type: "array", items: { type: "string", minLength: 1 } },
          nextRole: { type: ["string", "null"] },
        },
      },
    },
  };
}

export function buildProductDiscoveryScopeRepairPrompt({ brief, handoff }) {
  const payload = {
    objective: brief.objective,
    currentStage: "product-discovery",
    blockingCriteria: (brief.acceptanceCriteria ?? []).filter((criterion) => criterion.blocking !== false),
    blockingValidationAuthority: brief.validation ?? [],
    sourceHandoff: handoff,
  };
  return `Repair ONLY the Product Discovery stage disposition for an already-produced Agentic Harness Handoff Result v2.\n\nThis is a bounded same-attempt semantic repair. Do not call tools, edit files, add evidence, rewrite acceptance criteria, or evaluate downstream stages.\n\nAuthoritative scope rules:\n- Product Discovery is upstream of Architecture, Database, DevOps, AI/LLMOps, Technical Refinement, QA/readiness and Product Acceptance. Their pending state is expected and can NEVER block Product Discovery.\n- Task Brief.validation is the complete blocking executable validation authority for this stage. A generic repository/docs command absent from that array is not a Product Discovery blocker.\n- Decide only whether the current Product Discovery criteria already have sufficient evidence in sourceHandoff. Do not invent evidence.\n- If those current-stage criteria are already proven and every reported blocker is only a downstream-pending or unscoped-validation concern, return status=complete, sddReview.decision=approved, requiredDeltas=[], and remove those invalid blockers.\n- Otherwise remain failed/blocked or changes_requested with only genuine current-stage blockers.\n\nINPUT:\n${JSON.stringify(payload, null, 2)}`;
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

export async function repairProductDiscoveryScopeBlock({
  workspace,
  model,
  brief,
  handoff,
  structuredRunner = runOpenCodeStructuredOutput,
}) {
  const reason = productDiscoveryScopeRepairReason({ brief, handoff });
  if (!reason) return { handoff, attempted: false, reason: null };
  const schema = buildProductDiscoveryScopeRepairSchema(brief);
  const result = await structuredRunner({
    workspace,
    model,
    agentId: brief.agentId,
    schema,
    prompt: buildProductDiscoveryScopeRepairPrompt({ brief, handoff }),
    title: `${brief.taskId} product-discovery scope repair`,
  });
  assertSchema(result.value, schema, "productDiscoveryScopeRepair");
  const next = clone(handoff);
  next.status = result.value.status;
  next.residualRisks = clone(result.value.residualRisks);
  next.followUps = clone(result.value.followUps);
  next.sddReview = clone(result.value.sddReview);
  const usage = usageFromInfo(result.info);
  next.findings = [
    ...(Array.isArray(handoff.findings) ? handoff.findings : []),
    {
      type: "product_discovery_scope_repair",
      status: "succeeded",
      reason,
      modelId: model,
      sessionId: result.sessionId ?? null,
      authority: "bounded-same-model-stage-scope-repair",
      attempts: Number(result.attempts ?? 1),
    },
  ];
  next.auxiliaryInvocations = [
    ...(handoff.auxiliaryInvocations ?? []),
    auxiliaryInvocationFromStructuredResult({ purpose: "product-discovery-scope-repair", model, result }),
  ];
  next.metrics = {
    ...(handoff.metrics ?? {}),
    inputTokens: Number(handoff.metrics?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: Number(handoff.metrics?.outputTokens ?? 0) + usage.outputTokens,
    cachedInputTokens: Number(handoff.metrics?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
    costUsd: Number(handoff.metrics?.costUsd ?? 0) + usage.costUsd,
  };
  return { handoff: next, attempted: true, reason, model, sessionId: result.sessionId ?? null, usage };
}
