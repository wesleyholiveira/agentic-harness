import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentCatalog } from "../../.agents/runtime/agent-catalog.mjs";
import {
  buildProductDiscoveryAssessmentProjectionSchema,
  projectMissingProductDiscoveryBootstrapAssessment,
  reconcileProductDiscoveryBootstrapAssessmentEnvelope,
} from "../../.agents/runtime/product-discovery-bootstrap-assessment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const handoffSchema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/handoff-result.schema.json"), "utf8"));

function requirement(source) {
  return {
    factId: "decision.state-authority",
    consumerCapabilityId: "review.architecture",
    resolution: "authoritative-context",
    providerCapabilityId: null,
    source,
    evidence: "Repository evidence already reviewed for state authority.",
    rationale: "Architecture review consumes the already-authoritative state boundary.",
  };
}

function assessment(source) {
  return {
    contractVersion: "bootstrap-review-assessment/v1",
    requiredCapabilities: ["review.architecture"],
    factRequirements: [requirement(source)],
    evidence: "Product Discovery classified bootstrap review requirements from repository evidence.",
  };
}

test("Product Discovery canonicalizes a semicolon list of authorized repository paths to repository-context", async () => {
  const registry = await loadAgentCatalog(root);
  const repaired = reconcileProductDiscoveryBootstrapAssessmentEnvelope(
    assessment("modernization/02-IMPLEMENTATION-PLAN.md; modernization/03-CONTRACTS.md; docs/product/PRD.md"),
    registry,
    {
      authorizedRepositoryPaths: new Set([
        "modernization/02-IMPLEMENTATION-PLAN.md",
        "modernization/03-CONTRACTS.md",
        "docs/product/PRD.md",
      ]),
    },
  );

  assert.equal(repaired.factRequirements[0].source, "repository-context");
  assert.equal(repaired.factRequirements[0].evidence, "Repository evidence already reviewed for state authority.");
});

test("Product Discovery does not silently canonicalize path anchors as source authority", async () => {
  const registry = await loadAgentCatalog(root);

  assert.throws(
    () => reconcileProductDiscoveryBootstrapAssessmentEnvelope(
      assessment("docs/product/PRD.md#13-Ledger-de-fatos-para-bootstrap-e-cross-review"),
      registry,
      { authorizedRepositoryPaths: new Set(["docs/product/PRD.md"]) },
    ),
    /bootstrap_fact_authoritative_source_invalid:docs\/product\/PRD\.md#13-Ledger-de-fatos-para-bootstrap-e-cross-review/u,
  );
});

test("invalid anchored source is repaired by bounded projection using the closed source enum", async () => {
  const registry = await loadAgentCatalog(root);
  const handoff = {
    status: "complete",
    bootstrapReviewAssessment: assessment("modernization/03-CONTRACTS.md#1"),
    findings: [],
    auxiliaryInvocations: [],
    metrics: {},
  };
  const brief = {
    taskId: "run-fixture:product-discovery",
    agentId: "product-owner",
    objective: "Implement the bounded product increment.",
    acceptanceCriteria: [],
    expectedEvidence: [],
    sdd: { stage: "product-discovery" },
  };
  const contextPacket = {
    references: [
      {
        path: "modernization/03-CONTRACTS.md",
        kind: "canonical-doc",
        included: true,
      },
    ],
    upstreamArtifacts: [],
  };

  let observedPrompt = "";
  const result = await projectMissingProductDiscoveryBootstrapAssessment({
    workspace: root,
    model: "openai/gpt-5.6-luna",
    brief,
    contextPacket,
    handoff,
    handoffSchema,
    registry,
    structuredRunner: async ({ schema, prompt }) => {
      observedPrompt = prompt;
      assert.deepEqual(
        schema.properties.factRequirements.items.properties.source.enum,
        ["product-discovery", "frozen-adr", "project-memory", "repository-context"],
      );
      return {
        value: {
          ...assessment("repository-context"),
          factRequirements: [{
            ...requirement("repository-context"),
            evidence: "modernization/03-CONTRACTS.md contains the repository state-authority contract.",
          }],
        },
        info: { tokens: { input: 10, output: 4 } },
        sessionId: "ses-bootstrap-source-repair",
        attempts: 1,
        failures: [],
      };
    },
  });

  assert.equal(result.attempted, true);
  assert.equal(result.handoff.bootstrapReviewAssessment.factRequirements[0].source, "repository-context");
  assert.match(observedPrompt, /Repository paths\/anchors belong ONLY in evidence/u);
  assert.match(observedPrompt, /NEVER invent a heading\/section anchor/u);
});

test("executor performs Product Discovery bootstrap projection before the handoff schema/completion gates", () => {
  const source = readFileSync(resolve(root, ".agents/runtime/executor.mjs"), "utf8");
  const projectionIndex = source.indexOf("projectMissingProductDiscoveryBootstrapAssessment({");
  const schemaGateIndex = source.indexOf('assertSchema(handoff, schemas.handoffResult, "handoffResult")');
  const completionGateIndex = source.indexOf("const stageFailure = await stageContractFailure");

  assert.ok(projectionIndex >= 0);
  assert.ok(schemaGateIndex >= 0);
  assert.ok(completionGateIndex >= 0);
  assert.ok(projectionIndex < schemaGateIndex, "bootstrap projection must run before the generic handoff schema gate");
  assert.ok(schemaGateIndex < completionGateIndex, "repaired handoff must be schema-valid before stage completion");
  assert.match(source, /product_discovery\.bootstrap_assessment_repaired/u);
});
