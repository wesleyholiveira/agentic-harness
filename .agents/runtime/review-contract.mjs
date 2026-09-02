import { isBootstrapReviewStage } from "./bootstrap-capabilities.mjs";

const FIXED_REVIEW_STAGES = new Set([
  "technical-refinement", "quality-assurance", "operational-readiness", "product-acceptance",
]);

export function isSddReviewStage(stage) {
  const normalized = String(stage ?? "").trim();
  return isBootstrapReviewStage(normalized) || FIXED_REVIEW_STAGES.has(normalized);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : null;
}

function criterionRevision(criteria) {
  const revisions = [];
  for (const criterion of criteria ?? []) {
    const source = String(criterion?.source ?? "");
    for (const match of source.matchAll(/(?:^|[^a-z0-9])(?:prd[-_ ]*)?(?:rev(?:ision)?|r)[-_ ]?(\d+)(?:$|[^0-9])/gi)) {
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

function artifactStage(artifact) {
  const explicit = String(artifact?.content?.sddReview?.stage ?? "").trim();
  if (explicit) return explicit;
  const producer = String(artifact?.producer ?? "").trim();
  if (!producer) return null;
  const suffix = producer.includes(":") ? producer.slice(producer.lastIndexOf(":") + 1) : producer;
  return suffix || null;
}

function isProductAuthorityArtifact(artifact) {
  // Authority must come from provenance/stage, never from payload shape. Many
  // downstream handoffs legitimately carry acceptance criteria forward as
  // verification context; treating every such artifact as Product authority
  // collapses Product rN and implementation-plan rM into one numeric namespace.
  return artifactStage(artifact) === "product-discovery";
}

export function authoritativeReviewRevisionFromContext({ stage, contextPacket }) {
  if (!isSddReviewStage(stage)) return 1;
  const artifacts = contextPacket?.upstreamArtifacts ?? [];
  const productArtifacts = artifacts.filter(isProductAuthorityArtifact);
  // Product authority is explicit when Product Discovery emitted sddReview.reviewedRevision.
  // acceptanceCriteria[].source is free-form provenance and may legitimately carry
  // an immutable document revision such as PRD-r5 while the Runtime semantic review
  // lineage remains r1. Never merge those namespaces. Criterion-source parsing is
  // retained only as a legacy fallback when no Product artifact has an explicit
  // reviewedRevision at all.
  const explicitProductRevision = uniqueRevision(
    productArtifacts.map((artifact) => artifact?.content?.sddReview?.reviewedRevision),
    "product",
  );
  const productRevision = explicitProductRevision ?? uniqueRevision(
    productArtifacts.map((artifact) => criterionRevision(artifact?.content?.acceptanceCriteria ?? [])),
    "product",
  );

  if (isBootstrapReviewStage(stage) || stage === "technical-refinement") {
    return productRevision ?? 1;
  }

  const implementationPlanRevision = uniqueRevision(
    artifacts.map((artifact) => artifact?.content?.implementationPlan?.revision),
    "implementation-plan",
  );
  // Review revisions are scoped to the authority they attest. Bootstrap reviews
  // attest the Product/requirements revision, while QA/readiness attest the
  // compiled implementation-plan revision. Comparing those numeric values as a
  // single namespace creates false ambiguity (for example Product r2 + Plan r1).
  const reviewArtifacts = artifacts.filter((artifact) => !productArtifacts.includes(artifact));
  const reviewRevisionForStages = (stages, label) => uniqueRevision(
    reviewArtifacts
      .filter((artifact) => stages.has(String(artifact?.content?.sddReview?.stage ?? "").trim()))
      .map((artifact) => artifact?.content?.sddReview?.reviewedRevision),
    label,
  );

  if (stage === "operational-readiness") {
    const qaRevision = reviewRevisionForStages(new Set(["quality-assurance"]), "verification-lineage");
    const verificationRevision = uniqueRevision([implementationPlanRevision, qaRevision], "verification-lineage");
    return verificationRevision ?? productRevision ?? 1;
  }

  if (stage === "product-acceptance") {
    const directVerificationRevision = reviewRevisionForStages(
      new Set(["quality-assurance", "operational-readiness"]),
      "verification-lineage",
    );
    const verificationRevision = uniqueRevision([implementationPlanRevision, directVerificationRevision], "verification-lineage");
    return verificationRevision ?? productRevision ?? 1;
  }

  if (implementationPlanRevision !== null) return implementationPlanRevision;

  const downstreamRevision = uniqueRevision(
    reviewArtifacts.map((artifact) => artifact?.content?.sddReview?.reviewedRevision),
    "downstream-reviews",
  );
  return downstreamRevision ?? productRevision ?? 1;
}

export function requiredReviewDecision(stage) {
  return stage === "product-acceptance" ? "accepted" : "approved";
}

export function validateSddReviewContract({ brief, handoff }) {
  const stage = brief?.sdd?.stage ?? "implementation";
  if (!isSddReviewStage(stage) || handoff?.status !== "complete") return { valid: true, code: null, message: null };
  const review = handoff?.sddReview;
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return { valid: false, code: "review_missing", message: `Stage ${stage} requires sddReview` };
  }
  const expectedRole = String(brief?.sdd?.role ?? brief?.agentId ?? "");
  const expectedRevision = positiveInteger(brief?.sdd?.reviewedRevision) ?? 1;
  if (review.role !== expectedRole) return { valid: false, code: "review_role_mismatch", message: `sddReview.role expected=${expectedRole} actual=${review.role ?? "missing"}` };
  if (review.stage !== stage) return { valid: false, code: "review_stage_mismatch", message: `sddReview.stage expected=${stage} actual=${review.stage ?? "missing"}` };
  if (review.reviewedRevision !== expectedRevision) return { valid: false, code: "review_revision_mismatch", message: `sddReview.reviewedRevision expected=${expectedRevision} actual=${review.reviewedRevision ?? "missing"}` };

  const requiredDecision = requiredReviewDecision(stage);
  if (review.decision === requiredDecision) {
    if (!Array.isArray(review.requiredDeltas) || review.requiredDeltas.length !== 0) return { valid: false, code: "review_approved_with_deltas", message: `${requiredDecision} requires requiredDeltas=[]` };
    // nextRole is routing/handoff metadata, not evidence of an unresolved delta.
    // Historical SDD artifacts intentionally route approved reviews to the next
    // logical role (for example solution-architect -> devops-engineer).
    if (review.nextRole !== null && (typeof review.nextRole !== "string" || !review.nextRole.trim())) {
      return { valid: false, code: "review_approved_next_role_invalid", message: `${requiredDecision} nextRole must be null or a non-empty string` };
    }
    return { valid: true, code: null, message: null };
  }
  if (["changes_requested", "blocked"].includes(review.decision)) {
    if (!Array.isArray(review.requiredDeltas) || review.requiredDeltas.length === 0) return { valid: false, code: "review_negative_without_deltas", message: `${review.decision} requires non-empty requiredDeltas` };
    if (typeof review.nextRole !== "string" || !review.nextRole.trim()) return { valid: false, code: "review_negative_without_next_role", message: `${review.decision} requires non-empty nextRole` };
    return { valid: true, code: null, message: null };
  }
  return { valid: false, code: "review_decision_invalid", message: `Invalid review decision for ${stage}: ${review.decision ?? "missing"}` };
}

export const REVIEW_STAGES = FIXED_REVIEW_STAGES;
