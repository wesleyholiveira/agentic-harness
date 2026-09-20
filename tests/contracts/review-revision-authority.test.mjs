import test from "node:test";
import assert from "node:assert/strict";
import { authoritativeReviewRevisionFromContext } from "../../.agents/runtime/review-contract.mjs";

function artifact({ producer, stage = null, reviewedRevision = null, implementationPlanRevision = null }) {
  return {
    producer,
    content: {
      ...(stage || reviewedRevision !== null ? {
        sddReview: {
          role: stage === "technical-refinement" ? "technical-lead" : "verification-evidence",
          stage,
          decision: "approved",
          reviewedRevision,
          nextRole: null,
          requiredDeltas: [],
        },
      } : {}),
      ...(implementationPlanRevision !== null ? {
        implementationPlan: { revision: implementationPlanRevision },
      } : {}),
    },
  };
}

test("QA takes implementation-plan revision authority only from Technical Refinement", () => {
  const contextPacket = {
    upstreamArtifacts: [
      artifact({
        producer: "run-fixture:product-discovery",
        stage: "product-discovery",
        reviewedRevision: 1,
      }),
      artifact({
        producer: "run-fixture:technical-refinement",
        stage: "technical-refinement",
        reviewedRevision: 1,
        implementationPlanRevision: 2,
      }),
      artifact({
        producer: "run-fixture:implementation:r9-format-initials",
        implementationPlanRevision: 1,
      }),
    ],
  };

  assert.equal(
    authoritativeReviewRevisionFromContext({ stage: "quality-assurance", contextPacket }),
    2,
  );
});

test("a downstream verification handoff cannot redefine implementation-plan revision by payload shape", () => {
  const contextPacket = {
    upstreamArtifacts: [
      artifact({
        producer: "run-fixture:technical-refinement",
        stage: "technical-refinement",
        reviewedRevision: 1,
        implementationPlanRevision: 3,
      }),
      artifact({
        producer: "run-fixture:quality-assurance",
        stage: "quality-assurance",
        reviewedRevision: 3,
        implementationPlanRevision: 1,
      }),
    ],
  };

  assert.equal(
    authoritativeReviewRevisionFromContext({ stage: "product-acceptance", contextPacket }),
    3,
  );
});

test("conflicting Technical Refinement implementation-plan revisions still fail closed", () => {
  const contextPacket = {
    upstreamArtifacts: [
      artifact({
        producer: "run-fixture:technical-refinement",
        stage: "technical-refinement",
        reviewedRevision: 1,
        implementationPlanRevision: 1,
      }),
      artifact({
        producer: "run-fixture:technical-refinement",
        stage: "technical-refinement",
        reviewedRevision: 1,
        implementationPlanRevision: 2,
      }),
    ],
  };

  assert.throws(
    () => authoritativeReviewRevisionFromContext({ stage: "quality-assurance", contextPacket }),
    /handoff_review_revision_ambiguous:implementation-plan:1,2/u,
  );
});
