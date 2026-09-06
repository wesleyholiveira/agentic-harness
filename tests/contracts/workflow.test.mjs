import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentCatalog } from "../../.agents/runtime/agent-catalog.mjs";
import { loadSchemas, validateAgainstSchema } from "../../.agents/runtime/schema-validator.mjs";
import { createExecutionPlan } from "../../.agents/runtime/planner.mjs";
import { provisionalizeBootstrapPlan } from "../../.agents/runtime/bootstrap-topology-refiner.mjs";

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
