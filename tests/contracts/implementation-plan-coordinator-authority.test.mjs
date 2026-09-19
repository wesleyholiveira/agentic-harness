import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTechnicalPlanStructuredSchema,
  buildTechnicalPlanSynthesisPrompt,
  buildTechnicalReviewRepairPrompt,
  classifyTechnicalPlanRepairScope,
  repairImplementationPlanFromReview,
  technicalPlanRepairIssues,
} from "../../.agents/runtime/technical-plan-synthesis.mjs";
import {
  buildHandoffFinalizationPrompt,
  buildTechnicalReviewRepairProjectionPrompt,
} from "../../.agents/runtime/handoff-structured-finalization.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const implementationPlanSchema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/implementation-plan.schema.json"), "utf8"));

const criteria = [{
  id: "AC-1",
  source: "spec",
  statement: "Transactional materialization is implemented.",
  blocking: true,
  verification: "npm run harness:test",
  proofStage: "implementation",
}];

function registryFixture() {
  const agents = [
    {
      id: "main-orchestrator",
      role: "delivery-orchestrator",
      kind: "orchestrator",
      executionRole: "contract",
      orchestrationRole: "orchestrator",
      skills: ["orchestrate-multi-agent-work", "operate-multi-agent-runtime"],
      primaryPaths: [], sharedPaths: [], collaborativePaths: [],
    },
    {
      id: "agent-runtime-engineering",
      role: "agent-runtime-engineer",
      kind: "runtime",
      executionRole: "implementation",
      orchestrationRole: "specialist",
      skills: ["operate-multi-agent-runtime"],
      primaryPaths: [".agents/runtime/**"], sharedPaths: [], collaborativePaths: [],
    },
    {
      id: "coding-pro",
      role: "coding-pro",
      kind: "implementation",
      executionRole: "implementation",
      orchestrationRole: "specialist",
      ownershipMode: "fallback-unclaimed-primary",
      skills: [],
      primaryPaths: [], sharedPaths: [], collaborativePaths: [],
    },
    {
      id: "ai-llmops",
      role: "ai-llmops-engineer",
      kind: "ai-operations",
      executionRole: "contract",
      orchestrationRole: "specialist",
      skills: [],
      primaryPaths: ["docs/ai-operations/**"], sharedPaths: [], collaborativePaths: [],
    },
    {
      id: "systems-performance",
      role: "systems-performance-reviewer",
      kind: "reviewer",
      executionRole: "verification",
      orchestrationRole: "specialist",
      skills: [],
      primaryPaths: ["docs/performance/**"], sharedPaths: ["apps/**"], collaborativePaths: [],
    },
  ];
  return {
    agents,
    orchestrator: "main-orchestrator",
    byId: new Map(agents.map((agent) => [agent.id, agent])),
  };
}

function validPlan() {
  return {
    schemaVersion: 1,
    revision: 1,
    coordinatorAgentId: "main-orchestrator",
    acceptanceCriteria: structuredClone(criteria),
    workItems: [{
      id: "W01",
      ownerAgentId: "coding-pro",
      objective: "Implement transactional materialization.",
      dependencies: [],
      ownedPaths: ["src/materialization.mjs"],
      acceptanceCriteria: ["AC-1"],
      validation: ["npm run harness:test"],
      validationExecutionScope: "workspace",
      complexity: "medium",
      estimatedFiles: 1,
      contractChange: false,
      migration: false,
    }],
  };
}

function briefFixture() {
  return {
    schemaVersion: 2,
    runId: "run-coordinator-authority",
    taskId: "run-coordinator-authority:technical-refinement",
    agentId: "technical-lead",
    objective: "Compile an implementation plan with coordinatorAgentId distinct from every ownerAgentId; review-only agents must not own implementation work.",
    acceptanceCriteria: [
      { id: "PROC-TL-1", source: "runtime", statement: "coverage", blocking: true, verification: "coverage" },
      { id: "PROC-TL-2", source: "runtime", statement: "routing", blocking: true, verification: "schema" },
      { id: "PROC-TL-3", source: "runtime", statement: "acyclic", blocking: true, verification: "dag" },
    ],
    upstreamAcceptanceCriteria: structuredClone(criteria),
    validation: [],
    sdd: { role: "technical-lead", stage: "technical-refinement", reviewedRevision: 1 },
    modelRouting: { attempt: 1 },
  };
}

test("structured Technical Refinement schema requires a coordinator from runtime authority and keeps review-only agents out of implementation owner enum", () => {
  const registry = registryFixture();
  const schema = buildTechnicalPlanStructuredSchema({ implementationPlanSchema, requiredAcceptanceCriteria: criteria, registry });

  assert.ok(schema.required.includes("coordinatorAgentId"));
  assert.deepEqual(schema.properties.coordinatorAgentId.enum, ["agent-runtime-engineering", "main-orchestrator"]);

  const owners = schema.properties.workItems.items.properties.ownerAgentId.enum;
  assert.ok(owners.includes("agent-runtime-engineering"));
  assert.ok(owners.includes("coding-pro"));
  assert.ok(!owners.includes("ai-llmops"));
  assert.ok(!owners.includes("systems-performance"));
});

test("deterministic Technical Refinement preflight rejects missing, unknown, non-capable, and owner-equal coordinators", () => {
  const registry = registryFixture();

  assert.deepEqual(technicalPlanRepairIssues({
    implementationPlan: validPlan(), implementationPlanSchema, requiredAcceptanceCriteria: criteria, registry,
  }), []);

  const missing = validPlan();
  delete missing.coordinatorAgentId;
  assert.ok(technicalPlanRepairIssues({ implementationPlan: missing, implementationPlanSchema, requiredAcceptanceCriteria: criteria, registry })
    .includes("implementation_plan_coordinator_missing"));

  const unknown = validPlan();
  unknown.coordinatorAgentId = "ghost-coordinator";
  assert.ok(technicalPlanRepairIssues({ implementationPlan: unknown, implementationPlanSchema, requiredAcceptanceCriteria: criteria, registry })
    .includes("implementation_plan_coordinator_unknown:ghost-coordinator"));

  const reviewOnly = validPlan();
  reviewOnly.coordinatorAgentId = "ai-llmops";
  assert.ok(technicalPlanRepairIssues({ implementationPlan: reviewOnly, implementationPlanSchema, requiredAcceptanceCriteria: criteria, registry })
    .includes("implementation_plan_coordinator_not_capable:ai-llmops"));

  const ownerEqual = validPlan();
  ownerEqual.coordinatorAgentId = "agent-runtime-engineering";
  ownerEqual.workItems[0].ownerAgentId = "agent-runtime-engineering";
  ownerEqual.workItems[0].ownedPaths = [".agents/runtime/example.mjs"];
  const ownerIssues = technicalPlanRepairIssues({ implementationPlan: ownerEqual, implementationPlanSchema, requiredAcceptanceCriteria: criteria, registry });
  assert.ok(ownerIssues.includes("implementation_plan_coordinator_is_owner:agent-runtime-engineering"));
});

test("coordination-only deterministic issue is classified separately", () => {
  assert.equal(
    classifyTechnicalPlanRepairScope(["implementation_plan_coordinator_missing"]).scope,
    "coordination-only",
  );
});

test("semantic repair can materialize coordinatorAgentId and records top-level mutation evidence", async () => {
  const registry = registryFixture();
  const brief = briefFixture();
  const sourcePlan = validPlan();
  delete sourcePlan.coordinatorAgentId;
  const handoff = {
    status: "complete",
    implementationPlan: sourcePlan,
    findings: [],
    auxiliaryInvocations: [],
    metrics: {},
    sddReview: {
      role: "technical-lead",
      stage: "technical-refinement",
      decision: "changes_requested",
      reviewedRevision: 1,
      nextRole: "technical-lead",
      requiredDeltas: ["Make routing explicit by providing coordinatorAgentId distinct from every ownerAgentId; review-only agents must not be implementation owners."],
    },
  };

  const repairedValue = validPlan();
  repairedValue.revision = 2;
  const repaired = await repairImplementationPlanFromReview({
    workspace: root,
    brief,
    handoff,
    implementationPlanSchema,
    registry,
    repairPass: 1,
    structuredRunner: async () => ({
      value: repairedValue,
      info: { tokens: { input: 5, output: 3 } },
      sessionId: "ses-coordinator-repair",
      attempts: 1,
      failures: [],
    }),
  });

  assert.equal(repaired.handoff.implementationPlan.coordinatorAgentId, "main-orchestrator");
  assert.ok(repaired.repairEvidence.includes("implementation-plan-updated:coordinatorAgentId"));
  assert.equal(repaired.repairMutationScope, "coordination-only");
});

test("Technical Refinement prompts make coordinator authority and review-role separation explicit", () => {
  const registry = registryFixture();
  const brief = briefFixture();
  const plan = validPlan();
  const handoff = { status: "complete", implementationPlan: plan, assumptions: [], contractChanges: [], residualRisks: [], followUps: [], findings: [], changedPaths: [], reusedPaths: [] };

  const synthesis = buildTechnicalPlanSynthesisPrompt({ brief, handoff, registry, evidence: [] });
  assert.match(synthesis, /coordinatorAgentId/);
  assert.match(synthesis, /MUST NOT equal any workItems\[\*\]\.ownerAgentId/);
  assert.match(synthesis, /review-only agents are Runtime\/bootstrap review authority/i);

  const repair = buildTechnicalReviewRepairPrompt({ brief, handoff, registry, evidence: [], requiredDeltas: ["routing"], repairPass: 1, sourceRevision: 1 });
  assert.match(repair, /coordinatorAgentId/);
  assert.match(repair, /review-only agents are Runtime\/bootstrap review authority/i);

  const finalization = buildHandoffFinalizationPrompt({ brief, handoff, contextPacket: { upstreamArtifacts: [] } });
  assert.match(finalization, /coordinatorAgentId/);
  assert.match(finalization, /review-only roles are bootstrap\/Runtime authority/i);

  const rereview = buildTechnicalReviewRepairProjectionPrompt({
    brief,
    handoff,
    contextPacket: { upstreamArtifacts: [] },
    requiredDeltas: ["Make coordinatorAgentId distinct from every ownerAgentId."],
  });
  assert.match(rereview, /coordinatorAgentId/);
  assert.match(rereview, /must not be duplicated as implementationPlan review-role fields/i);
});
