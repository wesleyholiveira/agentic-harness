import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("SDD workflow derives implementation dependencies at runtime", () => {
  const workflow = JSON.parse(readFileSync(resolve(root, ".agents/workflow.json"), "utf8"));
  assert.equal(workflow.method, "spec-driven-development");
  assert.equal(workflow.compiledDag.graphVersion, "dynamic-dag-v2");
  assert.equal(workflow.compiledDag.source, "technical-refinement.implementationPlan");
  assert.equal(workflow.bootstrap.dependencyPolicy.default, "independent");
  assert.ok(workflow.bootstrap.reviewCapabilities.some((review) => review.capabilityId === "review.security"));
});
