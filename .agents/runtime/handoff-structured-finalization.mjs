import { assertSchema, validateAgainstSchema } from "./schema-validator.mjs";
import { evaluateCompletion } from "./completion-gate.mjs";
import { runOpenCodeStructuredOutput } from "./opencode-structured-output.mjs";
import { auxiliaryInvocationFromStructuredResult } from "./auxiliary-telemetry.mjs";
import { authoritativeReviewRevisionFromContext, isSddReviewStage, requiredReviewDecision, validateSddReviewContract } from "./review-contract.mjs";


const TERMINAL_REVIEW_DECISIONS = new Set(["changes_requested", "blocked"]);
const EVIDENCE_DERIVED_REVIEW_STAGES = new Set(["quality-assurance"]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : null;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedStringSet(values) {
  return [...new Set((values ?? [])
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim()))];
}

function technicalRepairClosureCandidates(handoff) {
  return {
    residualRisks: normalizedStringSet((handoff?.residualRisks ?? []).filter((value) => /^blocking:/i.test(String(value).trim()))),
    followUps: normalizedStringSet((handoff?.followUps ?? []).filter((value) => /^required:/i.test(String(value).trim()))),
  };
}

function enumSubsetArraySchema(values) {
  const normalized = normalizedStringSet(values);
  if (normalized.length === 0) return { const: [] };
  return {
    type: "array",
    items: { type: "string", enum: normalized },
  };
}

function applyTechnicalRepairClosure(handoff, closure) {
  const resolvedRisks = new Set(normalizedStringSet(closure?.resolvedResidualRisks));
  const resolvedFollowUps = new Set(normalizedStringSet(closure?.resolvedFollowUps));
  const next = clone(handoff);
  next.residualRisks = (next.residualRisks ?? []).filter((value) => !resolvedRisks.has(String(value).trim()));
  next.followUps = (next.followUps ?? []).filter((value) => !resolvedFollowUps.has(String(value).trim()));
  return next;
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
  const eligibility = completionEvidenceAllowsApproval({ brief, handoff });
  if (review.decision === requiredDecision) {
    if (!eligibility.allowed) return `review_approval_not_proven:${eligibility.violations.join(",")}`;
    if ((review.requiredDeltas ?? []).length > 0) return "review_approval_has_required_deltas";
    if (review.nextRole !== null && review.nextRole !== undefined && !nonEmptyString(review.nextRole)) return "review_approval_next_role_invalid";
    return null;
  }
  if (TERMINAL_REVIEW_DECISIONS.has(review.decision)) {
    if (EVIDENCE_DERIVED_REVIEW_STAGES.has(stage) && eligibility.allowed) {
      return `review_negative_contradicts_proven_evidence:${stage}`;
    }
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
  if (EVIDENCE_DERIVED_REVIEW_STAGES.has(stage) && eligibility.allowed) {
    // QA is an evidence stage. Once every assigned criterion, Runtime validation
    // receipt, blocking residual-risk gate and required-follow-up gate proves
    // completion, an isolated negative review echo is contradictory rather than
    // a second independent veto. Canonicalize only the review projection; the
    // evidence body remains untouched and fail-closed.
    reviewSchema.properties.decision = { const: requiredDecision };
    reviewSchema.properties.requiredDeltas = { const: [] };
  } else if (TERMINAL_REVIEW_DECISIONS.has(explicitDecision)) {
    // Preserve an explicit negative semantic decision when evidence does not
    // independently prove an evidence-derived stage, or for genuinely semantic
    // review stages. It may never be upgraded by a repair pass.
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
  const technicalRefinementBoundary = stage === "technical-refinement"
    ? "- Technical Refinement approves implementationPlan readiness, not completed implementation. Do NOT require implementation files to already exist/change, npm test or another work-item validation command to have already run, byte-identical post-state hashes, final diff-isolation evidence, QA receipts, readiness receipts, or Product Acceptance receipts. Future proof is sufficient at this stage when the plan assigns the correct implementation-proof criteria, owned paths/invariants, and exact executable validation commands; later stages own execution receipts."
    : "";
  const qaEvidenceBoundary = stage === "quality-assurance"
    ? "- Quality Assurance sddReview is an evidence summary, not an independent veto. criterionResults, Runtime validation receipts, blocking residualRisks and required followUps are the semantic authority. If those fields prove every current-stage gate, decision MUST be approved and requiredDeltas MUST be []; do not invent an ungrounded negative review. If a real QA blocker exists, represent it in the corresponding criterion result, validation receipt, blocking: residual risk, or required: follow-up before returning changes_requested/blocked."
    : "";
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
${technicalRefinementBoundary}
${qaEvidenceBoundary}
- ${requiredDecision} is allowed only when every blocking criterion has a passed result with evidence, every required current-stage validation passed with evidence, no blocking residual risk/required follow-up/open required delta exists, and the stage-specific output exists. Technical Refinement requires an implementationPlan; work-item validation declared inside that future plan is not current-stage validation evidence. Proven database_impact=none is a valid Database Review outcome.
- Use changes_requested when the same workflow can correct the current-stage result; include concrete requiredDeltas and a non-empty nextRole. Never express downstream execution/QA evidence as a Technical Refinement requiredDelta.
- Use blocked only for a genuine external blocker; include concrete requiredDeltas and a non-empty nextRole.
- On ${requiredDecision}, requiredDeltas must be []. nextRole is routing metadata and may be null or a non-empty next logical role; it does not represent an unresolved delta.

INPUT:
${JSON.stringify(payload, null, 2)}`;
}

/**
 * A Technical Refinement same-attempt repair is a closed semantic loop. The
 * initial negative review owns the repair scope; the bounded re-review may
 * approve the repaired plan or retain only unresolved members of that exact
 * requiredDelta set. It must never discover a fresh review scope inside the
 * same attempt.
 *
 * Historical blocking:/required: strings are carried by the original Handoff
 * body. They are not silently deleted by plan synthesis. The re-review can
 * explicitly close only exact pre-repair markers that the repaired plan has
 * actually resolved; any marker it does not close remains fail-closed completion
 * evidence.
 */
export function buildTechnicalReviewRepairProjectionSchema({ handoffSchema, brief, handoff, contextPacket, requiredDeltas }) {
  const stage = brief.sdd?.stage ?? "implementation";
  if (stage !== "technical-refinement") throw new Error(`technical_review_repair_projection_stage_invalid:${stage}`);
  const deltaScope = normalizedStringSet(requiredDeltas);
  if (deltaScope.length === 0) throw new Error("technical_review_repair_projection_required_deltas_missing");

  const closureCandidates = technicalRepairClosureCandidates(handoff);
  const hypotheticalClosed = applyTechnicalRepairClosure(handoff, {
    resolvedResidualRisks: closureCandidates.residualRisks,
    resolvedFollowUps: closureCandidates.followUps,
  });
  const eligibility = completionEvidenceAllowsApproval({ brief, handoff: hypotheticalClosed });
  const reviewSchema = clone(handoffSchema.properties.sddReview);
  reviewSchema.required = [...new Set([...(reviewSchema.required ?? []), "nextRole"])];
  reviewSchema.properties.role = { const: String(brief.sdd?.role ?? brief.agentId) };
  reviewSchema.properties.stage = { const: "technical-refinement" };
  reviewSchema.properties.reviewedRevision = { const: authoritativeReviewRevision({ brief, contextPacket, handoff }) };
  reviewSchema.properties.decision = { enum: eligibility.allowed ? ["approved", "changes_requested"] : ["changes_requested"] };
  reviewSchema.properties.requiredDeltas = enumSubsetArraySchema(deltaScope);

  return {
    type: "object",
    additionalProperties: false,
    required: ["sddReview", "repairClosure"],
    properties: {
      sddReview: reviewSchema,
      repairClosure: {
        type: "object",
        additionalProperties: false,
        required: ["resolvedResidualRisks", "resolvedFollowUps"],
        properties: {
          resolvedResidualRisks: enumSubsetArraySchema(closureCandidates.residualRisks),
          resolvedFollowUps: enumSubsetArraySchema(closureCandidates.followUps),
        },
      },
    },
  };
}

export function buildTechnicalReviewRepairProjectionPrompt({ brief, handoff, contextPacket, requiredDeltas }) {
  const deltaScope = normalizedStringSet(requiredDeltas);
  const closureCandidates = technicalRepairClosureCandidates(handoff);
  const payload = {
    stage: "technical-refinement",
    role: brief.sdd?.role ?? brief.agentId,
    reviewedRevision: authoritativeReviewRevision({ brief, contextPacket, handoff }),
    objective: brief.objective,
    originalRequiredDeltas: deltaScope,
    repairedImplementationPlan: handoff.implementationPlan,
    blockingTaskCriteria: (brief.acceptanceCriteria ?? []).filter((criterion) => criterion.blocking !== false),
    criterionResults: handoff.criterionResults ?? [],
    requiredValidation: brief.validation ?? [],
    validationEvidence: handoff.validation ?? [],
    productAcceptanceCriteria: brief.upstreamAcceptanceCriteria ?? [],
    upstreamEvidence: compactUpstreamEvidence(contextPacket, brief),
    repairClosureCandidates: closureCandidates,
  };

  return `Re-review a SAME-TASK-ATTEMPT Technical Refinement implementationPlan repair.

Return ONLY the JSON projection requested by the supplied schema. This is a closed repair review, not a new architecture/design/review pass. Do not execute tools, edit files, ask a human, rewrite the implementationPlan, invent product requirements, or expand review scope.

Rules:
- originalRequiredDeltas is the complete and immutable semantic review scope for this repair pass.
- The repaired implementationPlan has already passed deterministic schema, ownership, Product acceptance-criteria, dependency and executable-validation checks before this re-review.
- Technical Refinement approves implementationPlan readiness, not completed implementation. A delta that only asks for future implementation files to already exist/change, npm test or another work-item validation command to have already run, byte-identical post-state hashes, final diff-isolation evidence, QA/readiness receipts, or Product Acceptance receipts is outside this stage and MUST NOT remain as a blocking Technical Refinement delta. Treat the future proof as resolved at this stage when repairedImplementationPlan schedules the relevant owned paths/invariant and exact executable validation; later stages own the execution receipt.
- Evaluate each originalRequiredDelta against repairedImplementationPlan plus the supplied authoritative evidence, using that stage boundary.
- decision=approved only when every in-stage originalRequiredDelta is resolved and no originalRequiredDelta remains a valid Technical Refinement blocker. Then requiredDeltas must be [].
- decision=changes_requested only when one or more originalRequiredDeltas remain unresolved. requiredDeltas must contain only the exact unresolved subset of originalRequiredDeltas. Never add a new delta.
- blocked is not a valid outcome for this bounded re-review because the source review classified the issue as changes_requested. A genuinely new blocker belongs to a fresh full task attempt, not this closed repair pass.
- repairClosureCandidates are exact blocking:/required: strings carried from the PRE-REPAIR Handoff. They are historical text, not independent post-repair proof. Include a candidate in repairClosure only when the repaired plan directly resolves it. Do not resolve unrelated or still-open markers.
- Any blocking residual risk or required follow-up not explicitly closed remains fail-closed and prevents approval.
- role, stage and reviewedRevision are Runtime authority. nextRole is routing metadata only.

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

export async function finalizeTechnicalReviewRepair({
  workspace,
  model,
  brief,
  contextPacket,
  handoff,
  handoffSchema,
  requiredDeltas,
  structuredRunner = runOpenCodeStructuredOutput,
}) {
  const deltaScope = normalizedStringSet(requiredDeltas);
  const schema = buildTechnicalReviewRepairProjectionSchema({ handoffSchema, brief, handoff, contextPacket, requiredDeltas: deltaScope });
  const result = await structuredRunner({
    workspace,
    model,
    agentId: brief.agentId,
    schema,
    prompt: buildTechnicalReviewRepairProjectionPrompt({ brief, handoff, contextPacket, requiredDeltas: deltaScope }),
    title: `${brief.taskId} technical review repair projection`,
  });
  assertSchema(result.value, schema, "technicalReviewRepairProjection");

  let next = applyTechnicalRepairClosure(handoff, result.value.repairClosure);
  next.sddReview = clone(result.value.sddReview);
  const returnedDeltas = normalizedStringSet(next.sddReview.requiredDeltas);
  const allowedDeltas = new Set(deltaScope);
  if (returnedDeltas.some((delta) => !allowedDeltas.has(delta))) {
    throw new Error(`technical_review_repair_scope_expanded:${returnedDeltas.filter((delta) => !allowedDeltas.has(delta)).join(" | ")}`);
  }
  const consistencyFailure = reviewProjectionIsConsistent({ brief, handoff: next, review: next.sddReview });
  if (consistencyFailure) throw new Error(`technical_review_repair_projection_unproven:${consistencyFailure}`);
  assertSchema(next, handoffSchema, "handoffResult");

  const usage = usageFromInfo(result.info);
  next.findings = [
    ...(Array.isArray(handoff.findings) ? handoff.findings : []),
    {
      type: "handoff_structured_finalization",
      status: "succeeded",
      modelId: model,
      sessionId: result.sessionId ?? null,
      authority: "closed-technical-review-repair-projection",
      reviewedRevision: next.sddReview.reviewedRevision,
      decision: next.sddReview.decision,
      reviewScope: deltaScope,
      remainingRequiredDeltas: returnedDeltas,
      resolvedResidualRisks: normalizedStringSet(result.value.repairClosure?.resolvedResidualRisks),
      resolvedFollowUps: normalizedStringSet(result.value.repairClosure?.resolvedFollowUps),
      attempts: Number(result.attempts ?? 1),
      recoveredFailures: Array.isArray(result.failures) ? clone(result.failures) : [],
    },
  ];
  next.auxiliaryInvocations = [
    ...(handoff.auxiliaryInvocations ?? []),
    auxiliaryInvocationFromStructuredResult({ purpose: "technical-review-repair-projection", model, result }),
  ];
  next.metrics = {
    ...(handoff.metrics ?? {}),
    inputTokens: Number(handoff.metrics?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: Number(handoff.metrics?.outputTokens ?? 0) + usage.outputTokens,
    cachedInputTokens: Number(handoff.metrics?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
    costUsd: Number(handoff.metrics?.costUsd ?? 0) + usage.costUsd,
  };
  return {
    handoff: next,
    attempted: true,
    model,
    sessionId: result.sessionId ?? null,
    usage,
    reviewScope: deltaScope,
    remainingRequiredDeltas: returnedDeltas,
  };
}

