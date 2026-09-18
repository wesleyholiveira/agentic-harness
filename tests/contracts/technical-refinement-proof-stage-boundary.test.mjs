import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHandoffFinalizationPrompt,
  finalizeHandoffStructured,
  requiresStructuredHandoffFinalization,
  technicalRefinementOutOfStageCoverageDeltas,
} from "../../.agents/runtime/handoff-structured-finalization.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const handoffSchema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/handoff-result.schema.json"), "utf8"));

function fixture() {
  const upstreamAcceptanceCriteria = [
    { id: "CLV2-01", source: "modernization/04-ACCEPTANCE.md", statement: "Transactional materialization.", blocking: true, verification: "npm run test:product-contracts", proofStage: "implementation" },
    { id: "CLV2-05", source: "modernization/04-ACCEPTANCE.md", statement: "Independent leakage verification.", blocking: true, verification: "QA split verification.", proofStage: "quality-assurance" },
    { id: "CLV2-07", source: "modernization/04-ACCEPTANCE.md", statement: "Promotion database readiness.", blocking: true, verification: "Database readiness.", proofStage: "database-readiness" },
    { id: "CLV2-11", source: "modernization/04-ACCEPTANCE.md", statement: "Worker operational readiness.", blocking: true, verification: "Infrastructure readiness.", proofStage: "infrastructure-readiness" },
    { id: "CLV2-14", source: "modernization/04-ACCEPTANCE.md", statement: "Studio product acceptance.", blocking: true, verification: "Product acceptance.", proofStage: "product-acceptance" },
  ];
  const acceptanceCriteria = [
    { id: "PROC-TL-1", source: "runtime", statement: "coverage", blocking: true, verification: "plan coverage" },
    { id: "PROC-TL-2", source: "runtime", statement: "bounded work", blocking: true, verification: "plan schema" },
    { id: "PROC-TL-3", source: "runtime", statement: "acyclic", blocking: true, verification: "dag compiler" },
  ];
  const brief = {
    schemaVersion: 2,
    runId: "run-proof-stage",
    taskId: "run-proof-stage:technical-refinement",
    agentId: "technical-lead",
    objective: "Compile the Clip Compass V2 implementation plan.",
    acceptanceCriteria,
    upstreamAcceptanceCriteria,
    validation: [],
    sdd: { role: "technical-lead", stage: "technical-refinement", reviewedRevision: 1 },
  };
  const handoff = {
    schemaVersion: 2,
    runId: brief.runId,
    taskId: brief.taskId,
    agentId: brief.agentId,
    status: "complete",
    artifactVersion: "technical-refinement-r1",
    changedPaths: [],
    reusedPaths: [],
    contractChanges: [],
    assumptions: [],
    criterionResults: acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      result: "passed",
      evidence: `proved ${criterion.id}`,
    })),
    validation: [],
    residualRisks: [],
    followUps: [],
    implementationPlan: {
      schemaVersion: 1,
      revision: 1,
      acceptanceCriteria: upstreamAcceptanceCriteria,
      workItems: [{
        id: "W01",
        ownerAgentId: "coding-pro",
        objective: "Implement transactional materialization.",
        dependencies: [],
        ownedPaths: ["src/materialization.mjs"],
        acceptanceCriteria: ["CLV2-01"],
        validation: ["npm run test:product-contracts"],
        validationExecutionScope: "workspace",
        complexity: "medium",
        estimatedFiles: 1,
        contractChange: false,
        migration: false,
      }],
    },
  };
  return { brief, handoff, contextPacket: { upstreamArtifacts: [] } };
}

const impossibleReview = {
  role: "technical-lead",
  stage: "technical-refinement",
  decision: "changes_requested",
  reviewedRevision: 1,
  nextRole: "technical-lead",
  requiredDeltas: [
    "Correct the implementationPlan acceptance mapping so every blocking criterion CLV2-01 through CLV2-14 is explicitly assigned to one or more concrete work items; the current plan omits explicit mappings for CLV2-05, CLV2-07, CLV2-11, and CLV2-14.",
    "Update W13 and W14 acceptanceCriteria and validation scope to cover and audit all blocking CLV2 criteria.",
  ],
};

test("Technical Refinement detects downstream proof-stage coverage deltas as out of stage", () => {
  const { brief } = fixture();
  assert.deepEqual(
    technicalRefinementOutOfStageCoverageDeltas({ brief, review: impossibleReview }),
    impossibleReview.requiredDeltas,
  );

  const validReview = {
    ...impossibleReview,
    requiredDeltas: ["Assign CLV2-01 to the implementation work item that materially proves it."],
  };
  assert.deepEqual(technicalRefinementOutOfStageCoverageDeltas({ brief, review: validReview }), []);
});

test("invalid downstream coverage review is reprojected and canonicalized instead of repairing the plan", async () => {
  const { brief, handoff, contextPacket } = fixture();
  handoff.sddReview = structuredClone(impossibleReview);

  assert.equal(
    requiresStructuredHandoffFinalization({ brief, handoff, handoffSchema, contextPacket }),
    true,
  );

  const structuredRunner = async () => ({
    value: { sddReview: structuredClone(impossibleReview) },
    info: { tokens: { input: 10, output: 4 } },
    sessionId: "ses-proof-stage-boundary",
    attempts: 1,
    failures: [],
  });

  const finalized = await finalizeHandoffStructured({
    workspace: root,
    model: "openai/gpt-5.6-luna",
    brief,
    contextPacket,
    handoff,
    handoffSchema,
    structuredRunner,
  });

  assert.equal(finalized.handoff.sddReview.decision, "approved");
  assert.deepEqual(finalized.handoff.sddReview.requiredDeltas, []);
  assert.equal(finalized.handoff.sddReview.nextRole, "implementation");
  assert.deepEqual(
    finalized.handoff.implementationPlan.workItems[0].acceptanceCriteria,
    ["CLV2-01"],
    "stage-boundary reconciliation must not mutate implementationPlan coverage",
  );
});

test("Technical Refinement prompt exposes an explicit proof-stage partition", () => {
  const { brief, handoff, contextPacket } = fixture();
  const prompt = buildHandoffFinalizationPrompt({ brief, handoff, contextPacket });
  assert.match(prompt, /proofStagePartition/);
  assert.match(prompt, /implementationCriterionIds/);
  assert.match(prompt, /downstreamCriteria/);
  assert.match(prompt, /MUST NOT be demanded as implementation work-item coverage/);
});
