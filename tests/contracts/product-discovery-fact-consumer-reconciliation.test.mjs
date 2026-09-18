import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentCatalog } from "../../.agents/runtime/agent-catalog.mjs";
import { capabilityCatalogFromRegistry } from "../../.agents/runtime/bootstrap-capabilities.mjs";
import { reconcileProductDiscoveryBootstrapAssessmentEnvelope } from "../../.agents/runtime/product-discovery-bootstrap-assessment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("authoritative canonical-identity consumer echo is canonicalized as safe review fan-out", async () => {
  const registry = await loadAgentCatalog(root);
  const catalog = capabilityCatalogFromRegistry(registry);
  const expectedCapabilities = catalog.capabilities.map((capability) => capability.capabilityId);

  const repaired = reconcileProductDiscoveryBootstrapAssessmentEnvelope({
    contractVersion: "bootstrap-review-assessment/v1",
    requiredCapabilities: ["review.architecture"],
    factRequirements: [{
      factId: "canonical-identity",
      consumerCapabilityId: "canonical-identity",
      resolution: "authoritative-context",
      providerCapabilityId: null,
      source: "product-discovery",
      evidence: "ADR/Product Discovery already fixes canonical identity.",
      rationale: "The frozen identity decision is relevant to downstream reviews.",
    }],
    evidence: "The model echoed a fact label instead of a review capability ID.",
  }, registry);

  assert.deepEqual(repaired.requiredCapabilities, expectedCapabilities);
  assert.deepEqual(
    repaired.factRequirements.map((requirement) => requirement.consumerCapabilityId),
    expectedCapabilities,
  );
  assert.ok(repaired.factRequirements.every((requirement) =>
    requirement.factId === "decision.canonical-identity"
    && requirement.resolution === "authoritative-context"
    && requirement.providerCapabilityId === null));
});

test("decision-prefixed fact label echo is also recognized", async () => {
  const registry = await loadAgentCatalog(root);
  const catalog = capabilityCatalogFromRegistry(registry);

  const repaired = reconcileProductDiscoveryBootstrapAssessmentEnvelope({
    contractVersion: "bootstrap-review-assessment/v1",
    requiredCapabilities: ["review.architecture"],
    factRequirements: [{
      factId: "decision.canonical-identity",
      consumerCapabilityId: "canonical-identity",
      resolution: "authoritative-context",
      providerCapabilityId: null,
      source: "frozen-adr",
      evidence: "Frozen ADR fixes canonical identity.",
      rationale: "Consumer field contains the compact fact label.",
    }],
    evidence: "Deterministic field-confusion repair.",
  }, registry);

  assert.equal(repaired.factRequirements.length, catalog.capabilities.length);
});

test("arbitrary unknown authoritative consumer remains fail-closed", async () => {
  const registry = await loadAgentCatalog(root);
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
        evidence: "Unknown consumer is not the fact label.",
        rationale: "Runtime must not broaden arbitrary unknown consumers.",
      }],
      evidence: "Strict negative control.",
    }, registry),
    /bootstrap_fact_consumer_capability_unknown:product/u,
  );
});

test("review-resolved unknown consumer remains fail-closed", async () => {
  const registry = await loadAgentCatalog(root);
  assert.throws(
    () => reconcileProductDiscoveryBootstrapAssessmentEnvelope({
      contractVersion: "bootstrap-review-assessment/v1",
      requiredCapabilities: ["review.architecture"],
      factRequirements: [{
        factId: "canonical-identity",
        consumerCapabilityId: "canonical-identity",
        resolution: "review",
        providerCapabilityId: "review.architecture",
        source: "product-discovery",
        evidence: "No real consumer review was identified.",
        rationale: "A review dependency requires an exact consumer.",
      }],
      evidence: "Review dependency stays fail-closed.",
    }, registry),
    /bootstrap_fact_consumer_capability_unknown:canonical-identity/u,
  );
});

test("objective stage and agent aliases canonicalize inside factRequirements", async () => {
  const registry = await loadAgentCatalog(root);
  const repaired = reconcileProductDiscoveryBootstrapAssessmentEnvelope({
    contractVersion: "bootstrap-review-assessment/v1",
    requiredCapabilities: ["review.architecture", "review.database"],
    factRequirements: [{
      factId: "decision.state-authority",
      consumerCapabilityId: "database-review",
      resolution: "review",
      providerCapabilityId: "architecture-governance",
      source: "product-discovery",
      evidence: "Architecture provides state authority to Database.",
      rationale: "Stage/agent names have unique objective catalog mappings.",
    }],
    evidence: "Alias reconciliation.",
  }, registry);

  assert.equal(repaired.factRequirements[0].consumerCapabilityId, "review.database");
  assert.equal(repaired.factRequirements[0].providerCapabilityId, "review.architecture");
});
