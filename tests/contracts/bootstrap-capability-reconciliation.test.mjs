import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentCatalog } from "../../.agents/runtime/agent-catalog.mjs";
import { capabilityCatalogFromRegistry } from "../../.agents/runtime/bootstrap-capabilities.mjs";
import {
  canonicalizeProductDiscoveryRequiredCapabilities,
  normalizeProductDiscoveryReviewAssessment,
} from "../../.agents/runtime/bootstrap-topology-refiner.mjs";
import { reconcileProductDiscoveryBootstrapAssessmentEnvelope } from "../../.agents/runtime/product-discovery-bootstrap-assessment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("Product Discovery canonicalizes stage and review-agent aliases", async () => {
  const registry = await loadAgentCatalog(root);
  const catalog = capabilityCatalogFromRegistry(registry);
  assert.deepEqual(
    canonicalizeProductDiscoveryRequiredCapabilities(
      ["architecture-governance", "database-review"],
      catalog,
    ),
    ["review.architecture", "review.database"],
  );
});

test("unknown requiredCapabilities labels fail safe to every registered review", async () => {
  const registry = await loadAgentCatalog(root);
  const catalog = capabilityCatalogFromRegistry(registry);
  const expected = catalog.capabilities.map((capability) => capability.capabilityId);
  for (const label of ["async-control-plane", "product"]) {
    assert.deepEqual(
      canonicalizeProductDiscoveryRequiredCapabilities([label], catalog),
      expected,
    );
  }
});

test("factRequirements capability IDs remain strict while the redundant envelope is repairable", async () => {
  const registry = await loadAgentCatalog(root);
  const normalized = normalizeProductDiscoveryReviewAssessment({
    bootstrapReviewAssessment: {
      contractVersion: "bootstrap-review-assessment/v1",
      requiredCapabilities: ["architecture-governance"],
      factRequirements: [],
      evidence: "Architecture review is required.",
    },
  }, registry);
  assert.deepEqual(normalized.requiredCapabilities, ["review.architecture"]);

  assert.throws(
    () => reconcileProductDiscoveryBootstrapAssessmentEnvelope({
      contractVersion: "bootstrap-review-assessment/v1",
      requiredCapabilities: ["review.architecture"],
      factRequirements: [{
        factId: "decision.state-authority",
        consumerCapabilityId: "product",
        resolution: "authoritative-context",
        providerCapabilityId: null,
        source: "product-discovery",
        evidence: "Scoped evidence.",
        rationale: "Fact IDs remain authoritative.",
      }],
      evidence: "Invalid fact capability stays fail-closed.",
    }, registry),
    /bootstrap_fact_consumer_capability_unknown:product/u,
  );
});
