import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentCatalog } from "../../.agents/runtime/agent-catalog.mjs";
import { loadSchemas, validateAgainstSchema } from "../../.agents/runtime/schema-validator.mjs";
import { createExecutionPlan } from "../../.agents/runtime/planner.mjs";
import { provisionalizeBootstrapPlan } from "../../.agents/runtime/bootstrap-topology-refiner.mjs";
import { collectImplementationPlanValidationIssues } from "../../.agents/runtime/dag-compiler.mjs";
import { projectOwnershipRegistry } from "../../.agents/runtime/agent-input-manifest.mjs";
import { productDiscoveryAcceptanceCriteriaIssue } from "../../.agents/runtime/product-discovery-acceptance-criteria.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("SDD workflow derives implementation dependencies at runtime", () => {
  const workflow = JSON.parse(readFileSync(resolve(root, ".agents/workflow.json"), "utf8"));
  assert.equal(workflow.method, "spec-driven-development");
  assert.equal(workflow.compiledDag.graphVersion, "dynamic-dag-v2");
  assert.equal(workflow.compiledDag.source, "technical-refinement.implementationPlan");
  assert.equal(workflow.bootstrap.dependencyPolicy.default, "independent");
  assert.ok(workflow.bootstrap.reviewCapabilities.some((review) => review.capabilityId === "review.security"));
});


test("execution-plan schema accepts Security Review workflow projection", async () => {
  const [registry, schemas] = await Promise.all([loadAgentCatalog(root), loadSchemas(root)]);
  const plan = createExecutionPlan({
    registry,
    schemas,
    request: "Implement authentication authorization and security validation for the consumer API",
  });
  assert.equal(plan.workflow.requiresSecurity, true);
  assert.equal(validateAgainstSchema(plan, schemas.executionPlan, "executionPlan").valid, true);

  const provisional = provisionalizeBootstrapPlan(plan, schemas);
  assert.equal(provisional.workflow.requiresSecurity, false);
  assert.equal(validateAgainstSchema(provisional, schemas.executionPlan, "executionPlan").valid, true);
});

test("execution-plan schema requires requiresSecurity alongside other workflow review projections", () => {
  const schema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/execution-plan.schema.json"), "utf8"));
  assert.ok(schema.properties.workflow.required.includes("requiresSecurity"));
  assert.deepEqual(schema.properties.workflow.properties.requiresSecurity, { type: "boolean" });
});


test("Task Brief workflowSkill emitted by context builder matches schema authority", () => {
  const schema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/task-brief.schema.json"), "utf8"));
  const expectedWorkflowSkill = schema.properties.sdd.properties.workflowSkill.const;
  const contextBuilderSource = readFileSync(resolve(root, ".agents/runtime/context-builder.mjs"), "utf8");
  const emitted = contextBuilderSource.match(/workflowSkill:\s*"([^"]+)"/);
  assert.ok(emitted, "context-builder must emit Task Brief sdd.workflowSkill");
  assert.equal(emitted[1], expectedWorkflowSkill);
  assert.equal(expectedWorkflowSkill, "agent-harness-sdd-workflow");
  assert.equal(contextBuilderSource.includes("agentic-harness-sdd-workflow"), false);
});

test("generic coding fallback owns consumer paths only when no domain primary owner exists", async () => {
  const registry = await loadAgentCatalog(root);
  const criterion = {
    id: "AC-IMPL-1",
    source: "qualification-prd",
    statement: "The scoped implementation behaves as specified.",
    blocking: true,
    verification: "npm test",
    proofStage: "implementation",
  };
  const plan = {
    schemaVersion: 1,
    revision: 1,
    acceptanceCriteria: [criterion],
    workItems: [{
      id: "format-name-implementation",
      ownerAgentId: "coding-pro",
      objective: "Implement and test the generic consumer helper.",
      dependencies: [],
      ownedPaths: ["src/format-name.mjs", "test/format-name.test.mjs"],
      acceptanceCriteria: [criterion.id],
      validation: ["npm test"],
      validationExecutionScope: "workspace",
      complexity: "low",
      estimatedFiles: 2,
      contractChange: false,
      migration: false,
    }],
  };
  assert.deepEqual(collectImplementationPlanValidationIssues(plan, registry), []);

  const domainOwned = structuredClone(plan);
  domainOwned.workItems[0].ownedPaths = ["src/server/users.mjs"];
  assert.deepEqual(
    collectImplementationPlanValidationIssues(domainOwned, registry),
    ["implementation_plan_path_outside_agent_ownership:format-name-implementation:coding-pro:src/server/users.mjs"],
  );
});

test("ownership projection exposes explicit fallback mode for generic coding agents", async () => {
  const registry = await loadAgentCatalog(root);
  const projection = projectOwnershipRegistry(registry);
  const codingPro = projection.owners.find((owner) => owner.agentId === "coding-pro");
  const codingFast = projection.owners.find((owner) => owner.agentId === "coding-fast");
  assert.equal(codingPro?.ownershipMode, "fallback-unclaimed-primary");
  assert.equal(codingFast?.ownershipMode, "fallback-unclaimed-primary");
  assert.deepEqual(codingPro?.matchingRules, []);
  assert.deepEqual(codingFast?.matchingRules, []);
});

test("Product Discovery cannot complete without an implementation-proof product criterion", () => {
  const issue = productDiscoveryAcceptanceCriteriaIssue({
    brief: {
      sdd: { stage: "product-discovery" },
      acceptanceCriteria: [{ id: "PROC-PO-1" }],
    },
    handoff: {
      status: "complete",
      acceptanceCriteria: [{
        id: "AC-1",
        source: "docs/specs/example/PRD.md",
        statement: "Blank display names are rendered as Anonymous.",
        blocking: true,
        verification: "npm test",
        proofStage: "quality-assurance",
      }],
    },
    requireComplete: true,
  });
  assert.equal(issue?.code, "product_acceptance_implementation_proof_missing");
});
