import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentCatalog } from "../../.agents/runtime/agent-catalog.mjs";
import { capabilityCatalogFromRegistry } from "../../.agents/runtime/bootstrap-capabilities.mjs";
import { reconcileProductDiscoveryBootstrapAssessmentEnvelope } from "../../.agents/runtime/product-discovery-bootstrap-assessment.mjs";
import { deriveRetryBudgetState, evaluateRetryBudget } from "../../.agents/runtime/retry-efficiency.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("authoritative context repairs implementation-agent consumer", async () => {
  const registry = await loadAgentCatalog(root);
  const catalog = capabilityCatalogFromRegistry(registry);
  const expected = catalog.capabilities.map((capability) => capability.capabilityId);
  const repaired = reconcileProductDiscoveryBootstrapAssessmentEnvelope({
    contractVersion: "bootstrap-review-assessment/v1",
    requiredCapabilities: ["review.architecture"],
    factRequirements: [{
      factId: "decision.backend-contract",
      consumerCapabilityId: "backend-specialist",
      resolution: "authoritative-context",
      providerCapabilityId: null,
      source: "product-discovery",
      evidence: "Product Discovery already fixes the backend contract.",
      rationale: "Implementation-agent consumer is a projection error.",
    }],
    evidence: "Regression control.",
  }, registry);

  assert.deepEqual(repaired.requiredCapabilities, expected);
  assert.deepEqual(repaired.factRequirements.map((item) => item.consumerCapabilityId), expected);
  assert.ok(repaired.factRequirements.every((item) => item.providerCapabilityId === null));
});

test("review resolution rejects implementation-agent consumer", async () => {
  const registry = await loadAgentCatalog(root);
  assert.throws(() => reconcileProductDiscoveryBootstrapAssessmentEnvelope({
    contractVersion: "bootstrap-review-assessment/v1",
    requiredCapabilities: ["review.architecture"],
    factRequirements: [{
      factId: "decision.backend-contract",
      consumerCapabilityId: "backend-specialist",
      resolution: "review",
      providerCapabilityId: "review.architecture",
      source: "product-discovery",
      evidence: "Review dependency requires a review consumer.",
      rationale: "Fail closed.",
    }],
    evidence: "Negative control.",
  }, registry), /bootstrap_fact_consumer_capability_unknown:backend-specialist/u);
});

test("task retry budget ignores run-level and sibling-task events", () => {
  const taskId = "run-test:technical-refinement";
  const taskStartedAt = Date.parse("2026-09-18T03:06:00.000Z");
  const nowMs = Date.parse("2026-09-18T03:16:07.000Z");
  const events = [
    { task_id: null, event_type: "run.started", created_at: "2026-09-18T02:55:54.000Z", payload_json: "{}" },
    { task_id: "run-test:product-discovery", event_type: "retry.backoff_applied", created_at: "2026-09-18T02:59:30.000Z", payload_json: JSON.stringify({ retryAfterMs: 120000 }) },
    { task_id: taskId, event_type: "task.running", created_at: new Date(taskStartedAt).toISOString(), payload_json: "{}" },
    { task_id: taskId, event_type: "retry.backoff_applied", created_at: "2026-09-18T03:11:00.000Z", payload_json: JSON.stringify({ retryAfterMs: 10000 }) },
  ];

  const state = deriveRetryBudgetState(events, { taskId, startedAtMs: taskStartedAt, nowMs });
  assert.equal(state.elapsedMs, nowMs - taskStartedAt);
  assert.equal(state.cumulativeBackoffMs, 10000);
  assert.equal(evaluateRetryBudget({
    budgetState: state,
    retryAfterMs: 0,
    limits: { maxElapsedMs: 900000, maxCumulativeBackoffMs: 300000 },
  }).allowed, true);
});
