import { assertSchema, validateAgainstSchema } from "./schema-validator.mjs";
import { evaluateCompletion } from "./completion-gate.mjs";
import { runOpenCodeStructuredOutput } from "./opencode-structured-output.mjs";
import { auxiliaryInvocationFromStructuredResult } from "./auxiliary-telemetry.mjs";
import { authoritativeReviewRevisionFromContext, isSddReviewStage, requiredReviewDecision, validateSddReviewContract } from "./review-contract.mjs";


const TERMINAL_REVIEW_DECISIONS = new Set(["changes_requested", "blocked"]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : null;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function allowedReviewDecisions(stage) {
  return stage === "product-acceptance"
    ? ["accepted", "changes_requested", "blocked"]
    : ["approved", "changes_requested", "blocked"];
}

function criterionRevision(criteria) {
  const revisions = [];
  for (const criterion of criteria ?? []) {
    const source = String(criterion?.source ?? "");
    const matches = [
      ...source.matchAll(/(?:^|[^a-z0-9])(?:prd[-_ ]*)?(?:rev(?:ision)?|r)[-_ ]?(\d+)(?:$|[^0-9])/gi),
    ];
    for (const match of matches) {
      const revision = positiveInteger(match[1]);
      if (revision !== null) revisions.push(revision);
    }
  }
  const unique = [...new Set(revisions)];
  if (unique.length > 1) throw new Error(`handoff_review_revision_ambiguous:criterion_sources:${unique.join(",")}`);
  return unique[0] ?? null;
}

function uniqueRevision(values, label) {
  const unique = [...new Set(values.map(positiveInteger).filter((value) => value !== null))];
  if (unique.length > 1) throw new Error(`handoff_review_revision_ambiguous:${label}:${unique.join(",")}`);
  return unique[0] ?? null;
}

/**
 * Resolve the semantic revision reviewed by this stage. Never derive it from an
 * artifactVersion/attempt number: retries by an unrelated specialist must not
 * advance the Product/implementation revision under review.
 */
export function authoritativeReviewRevision({ brief, contextPacket }) {
  return positiveInteger(brief?.sdd?.reviewedRevision)
    ?? authoritativeReviewRevisionFromContext({ stage: brief?.sdd?.stage ?? "implementation", contextPacket });
}

function reviewIsStructurallyValid(handoff, handoffSchema) {
  if (!handoff?.sddReview) return false;
  const schema = handoffSchema?.properties?.sddReview;
  return schema ? validateAgainstSchema(handoff.sddReview, schema, "sddReview").valid : false;
}

function completionEvidenceAllowsApproval({ brief, handoff }) {
  const candidate = clone(handoff);
  delete candidate.sddReview;
  const completion = evaluateCompletion({ taskBrief: brief, handoff: candidate });
  if (!completion.accepted) return { allowed: false, violations: completion.violations };
  const stage = brief.sdd?.stage ?? "implementation";
  if (stage === "technical-refinement" && (!candidate.implementationPlan || typeof candidate.implementationPlan !== "object" || Array.isArray(candidate.implementationPlan))) {
    return { allowed: false, violations: ["implementation_plan_missing"] };
  }
  return { allowed: true, violations: [] };
}

function reviewProjectionIsConsistent({ brief, handoff, review }) {
  const stage = brief.sdd?.stage ?? "implementation";
  const requiredDecision = requiredReviewDecision(stage);
  if (review.decision === requiredDecision) {
    const eligibility = completionEvidenceAllowsApproval({ brief, handoff });
    if (!eligibility.allowed) return `review_approval_not_proven:${eligibility.violations.join(",")}`;
    if ((review.requiredDeltas ?? []).length > 0) return "review_approval_has_required_deltas";
    if (review.nextRole !== null && review.nextRole !== undefined && !nonEmptyString(review.nextRole)) return "review_approval_next_role_invalid";
    return null;
  }
  if (TERMINAL_REVIEW_DECISIONS.has(review.decision)) {
    if (!nonEmptyString(review.nextRole)) return `review_${review.decision}_next_role_missing`;
    if (!Array.isArray(review.requiredDeltas) || review.requiredDeltas.length === 0) return `review_${review.decision}_required_deltas_missing`;
    return null;
  }
  return `review_decision_invalid_for_stage:${stage}:${review.decision ?? "missing"}`;
}

function reviewNeedsProjection({ brief, handoff, handoffSchema }) {
  if (!reviewIsStructurallyValid(handoff, handoffSchema)) return true;
  const contract = validateSddReviewContract({ brief, handoff });
  if (!contract.valid) return true;
  return reviewProjectionIsConsistent({ brief, handoff, review: handoff.sddReview }) !== null;
}

export function requiresStructuredHandoffFinalization({ brief, handoff, handoffSchema, contextPacket = null }) {
  const stage = brief.sdd?.stage ?? "implementation";
  if (!isSddReviewStage(stage) || handoff?.status !== "complete") return false;
  return reviewNeedsProjection({ brief, handoff, handoffSchema });
}

/**
 * The model returns only a small sddReview projection. The task-authored Handoff
 * body is never re-emitted by the model and therefore cannot be silently
 * rewritten during semantic finalization.
 */
export function buildHandoffFinalizationSchema({ handoffSchema, brief, handoff, contextPacket }) {
  const stage = brief.sdd?.stage ?? "implementation";
  const reviewSchema = clone(handoffSchema.properties.sddReview);
  reviewSchema.required = [...new Set([...(reviewSchema.required ?? []), "nextRole"])];
  reviewSchema.properties.role = { const: String(brief.sdd?.role ?? brief.agentId) };
  reviewSchema.properties.stage = { const: String(stage) };
  reviewSchema.properties.reviewedRevision = { const: authoritativeReviewRevision({ brief, contextPacket, handoff }) };
  const sourceNextRole = handoff?.sddReview?.nextRole;
  if (sourceNextRole === null || nonEmptyString(sourceNextRole)) {
    reviewSchema.properties.nextRole = { const: sourceNextRole };
  }

  const explicitDecision = handoff?.sddReview?.decision;
  const requiredDecision = requiredReviewDecision(stage);
  const eligibility = completionEvidenceAllowsApproval({ brief, handoff });
  if (TERMINAL_REVIEW_DECISIONS.has(explicitDecision)) {
    // Preserve an explicit negative semantic decision even when the rest of the
    // envelope is malformed. It may never be upgraded by a repair pass.
    reviewSchema.properties.decision = { const: explicitDecision };
  } else if (explicitDecision === requiredDecision && eligibility.allowed) {
    // A positive decision is retained only after deterministic evidence gates
    // prove that this stage is actually eligible for approval/acceptance.
    reviewSchema.properties.decision = { const: requiredDecision };
  } else if (nonEmptyString(explicitDecision)) {
    // Unsupported decisions and unproven positive decisions are semantic
    // contract defects. The bounded projection may only fail closed.
    reviewSchema.properties.decision = { enum: ["changes_requested", "blocked"] };
  } else {
    reviewSchema.properties.decision = {
      enum: eligibility.allowed
        ? allowedReviewDecisions(stage)
        : ["changes_requested", "blocked"],
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["sddReview"],
    properties: { sddReview: reviewSchema },
  };
}

function compactUpstreamEvidence(contextPacket, brief) {
  return (contextPacket?.upstreamArtifacts ?? []).map((artifact) => ({
    producer: artifact.producer ?? null,
    kind: artifact.kind ?? null,
    sddReview: artifact.content?.sddReview ?? null,
    acceptanceCriteria: artifact.content?.acceptanceCriteria ?? (brief?.sdd?.stage === "technical-refinement" ? brief?.upstreamAcceptanceCriteria ?? [] : []),
    implementationPlanRevision: artifact.content?.implementationPlan?.revision ?? null,
    changedPaths: artifact.content?.changedPaths ?? [],
    reusedPaths: artifact.content?.reusedPaths ?? [],
  }));
}

export function buildHandoffFinalizationPrompt({ brief, handoff, contextPacket }) {
  const stage = brief.sdd?.stage ?? "implementation";
  const requiredDecision = requiredReviewDecision(stage);
  const payload = {
    stage,
    role: brief.sdd?.role ?? brief.agentId,
    reviewedRevision: authoritativeReviewRevision({ brief, contextPacket, handoff }),
    objective: brief.objective,
    blockingCriteria: (brief.acceptanceCriteria ?? []).filter((criterion) => criterion.blocking !== false),
    requiredValidation: brief.validation ?? [],
    sourceHandoff: handoff,
    upstreamEvidence: compactUpstreamEvidence(contextPacket, brief),
  };
  return `Project only the sddReview envelope for an already-produced Agentic Harness Handoff Result v2.

This is a bounded semantic decision. Return ONLY the JSON projection requested by the supplied schema. Do not execute tools, edit files, restate or rewrite the Handoff body, redesign the implementation plan, or invent evidence.

Rules:
- The runtime owns role, stage and reviewedRevision.
- Preserve explicit changes_requested or blocked. Retain an explicit positive decision only when deterministic completion evidence proves it; otherwise fail closed.
- Decide from sourceHandoff, blockingCriteria, requiredValidation and upstreamEvidence only.
- ${requiredDecision} is allowed only when every blocking criterion has a passed result with evidence, every required final validation passed with evidence, no blocking residual risk/required follow-up/open required delta exists, and the stage-specific output exists. Technical Refinement requires an implementationPlan. Proven database_impact=none is a valid Database Review outcome.
- Use changes_requested when the same workflow can correct the result; include concrete requiredDeltas and a non-empty nextRole.
- Use blocked only for a genuine external blocker; include concrete requiredDeltas and a non-empty nextRole.
- On ${requiredDecision}, requiredDeltas must be []. nextRole is routing metadata and may be null or a non-empty next logical role; it does not represent an unresolved delta.

INPUT:
${JSON.stringify(payload, null, 2)}`;
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

export async function finalizeHandoffStructured({
  workspace,
  model,
  brief,
  contextPacket,
  handoff,
  handoffSchema,
  structuredRunner = runOpenCodeStructuredOutput,
}) {
  const schema = buildHandoffFinalizationSchema({ handoffSchema, brief, handoff, contextPacket });
  const result = await structuredRunner({
    workspace,
    model,
    agentId: brief.agentId,
    schema,
    prompt: buildHandoffFinalizationPrompt({ brief, handoff, contextPacket }),
    title: `${brief.taskId} handoff review projection`,
  });
  assertSchema(result.value, schema, "handoffStructuredFinalization");
  const next = clone(handoff);
  next.sddReview = clone(result.value.sddReview);
  const consistencyFailure = reviewProjectionIsConsistent({ brief, handoff: next, review: next.sddReview });
  if (consistencyFailure) throw new Error(`handoff_review_projection_unproven:${consistencyFailure}`);
  assertSchema(next, handoffSchema, "handoffResult");

  const usage = usageFromInfo(result.info);
  next.findings = [
    ...(Array.isArray(handoff.findings) ? handoff.findings : []),
    {
      type: "handoff_structured_finalization",
      status: "succeeded",
      modelId: model,
      sessionId: result.sessionId ?? null,
      authority: "bounded-sdd-review-projection",
      reviewedRevision: next.sddReview.reviewedRevision,
      decision: next.sddReview.decision,
      attempts: Number(result.attempts ?? 1),
      recoveredFailures: Array.isArray(result.failures) ? clone(result.failures) : [],
    },
  ];
  next.auxiliaryInvocations = [
    ...(handoff.auxiliaryInvocations ?? []),
    auxiliaryInvocationFromStructuredResult({ purpose: "handoff-review-projection", model, result }),
  ];
  next.metrics = {
    ...(handoff.metrics ?? {}),
    inputTokens: Number(handoff.metrics?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: Number(handoff.metrics?.outputTokens ?? 0) + usage.outputTokens,
    cachedInputTokens: Number(handoff.metrics?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
    costUsd: Number(handoff.metrics?.costUsd ?? 0) + usage.costUsd,
  };
  return { handoff: next, attempted: true, model, sessionId: result.sessionId ?? null, usage };
}

