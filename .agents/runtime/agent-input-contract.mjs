export function buildConciseExecutorContract({ brief }) {
  const stage = brief?.sdd?.stage ?? "implementation";
  const blockingIds = (brief?.acceptanceCriteria ?? []).filter((item) => item.blocking !== false).map((item) => item.id);
  const lines = [
    "# Runtime V2 executor contract / R16",
    "",
    "Task Brief is the exact execution authority. Do not reinterpret, duplicate, or weaken it.",
    "Context Packet is retrieved supporting context only; upstream-evidence and governance projections are separate manifest entries.",
    "Return exactly one JSON object matching handoff-result.schema.json. Do not wrap it in markdown.",
    "The executor is non-interactive; do not invoke question or wait for human input.",
    "changedPaths contains only paths modified by this attempt; reusedPaths contains byte-identical owned outputs accepted without modification; usedContextPaths is read-only supporting context.",
    `Stage: ${stage}.`,
    `Blocking Task Brief criterion IDs: ${blockingIds.join(", ") || "none"}. criterionResults must contain each ID exactly once before status=complete.`,
  ];
  if (stage === "product-discovery") lines.push(
    "Product Discovery: PROC-PO-* are process gates and belong only in criterionResults. acceptanceCriteria is product-only and every item requires proofStage. Emit bootstrapReviewAssessment/v1.",
  );
  if (["architecture-review", "database-review", "infrastructure-review", "ai-llmops-review"].includes(stage)) lines.push(
    "Bootstrap review: review only current Product Discovery scope and required facts; future Technical Refinement/implementation/QA evidence is downstream and cannot block this review.",
  );
  if (stage === "database-review") lines.push(
    "Database review: impact=none is a valid approved outcome when schema/migrations/queries/indexes/transactions/persistence/backfills are unchanged.",
  );
  if (stage === "technical-refinement") lines.push(
    "Technical Refinement: use ownership-projection.json for planning; full distributed agent catalog remains private Runtime compiler authority. Emit implementationPlan matching implementation-plan.schema.json and preserve upstreamAcceptanceCriteria exactly.",
  );
  if (stage === "implementation") lines.push(
    "Implementation: implement only the assigned work item. Task Brief.validation is the complete blocking command authority for this task.",
  );
  if (stage === "quality-assurance") lines.push(
    "Quality Assurance: independently prove assigned criteria; use Task Brief.changeProvenance rather than raw working-tree status for attribution. Direct bootstrap/implementation dependency projections in this manifest are the upstream evidence authority; do not block on outer-controller R-0/post-cleanup evidence or unlisted run-wide artifacts.",
  );
  if (stage === "operational-readiness") lines.push(
    "Operational readiness: verify only assigned specialist-domain criteria and Task Brief.validation; proven no-impact evidence is a valid PASS.",
  );
  if (stage === "product-acceptance") lines.push(
    "Product Acceptance: use sddReview.decision=accepted only when every assigned criterion is proven.",
  );
  lines.push(
    "If more detail is required from an upstream full artifact, use the Context Engine artifact expansion tool with the current runId/taskId/attempt/manifestFingerprint and a manifest-listed artifactRef.",
    "Runtime-owned metrics/executionTelemetry are populated by the Runtime; do not invent provider token or byte counters.",
  );
  return `${lines.join("\n")}\n`;
}
