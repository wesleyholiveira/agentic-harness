import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isExecutableValidationCommand,
  validationCommandId,
  validationCommandProjectionIssues,
} from "../../.agents/runtime/validation-command.mjs";
import {
  buildTechnicalPlanStructuredSchema,
  buildValidationCommandCatalog,
  normalizeTechnicalPlanMechanics,
  technicalPlanRepairIssues,
} from "../../.agents/runtime/technical-plan-synthesis.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "validation-authority-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    packageManager: "npm@11.0.0",
    scripts: {
      test: "node --test",
      lint: "eslint .",
      start: "node server.js",
    },
  }));
  return root;
}
function criterion() {
  return {
    id: "AC-1",
    source: "product-owner",
    statement: "The implementation passes its focused test.",
    blocking: true,
    verification: "npm test",
    proofStage: "implementation",
  };
}
function registry() {
  const implementer = {
    id: "coding",
    role: "developer",
    executionRole: "implementation",
    orchestrationRole: "specialist",
    primaryPaths: ["src/**"],
    sharedPaths: [],
    collaborativePaths: [],
    ownershipMode: "explicit-patterns",
  };
  const coordinator = {
    id: "main-orchestrator",
    role: "orchestrator",
    kind: "runtime",
    executionRole: "orchestration",
    orchestrationRole: "orchestrator",
    primaryPaths: [],
    sharedPaths: [],
    collaborativePaths: [],
  };
  return {
    agents: [implementer, coordinator],
    byId: new Map([[implementer.id, implementer], [coordinator.id, coordinator]]),
  };
}
function plan(validation = ["npm test"], validationCommandIds = undefined) {
  return {
    schemaVersion: 1,
    revision: 1,
    coordinatorAgentId: "main-orchestrator",
    acceptanceCriteria: [criterion()],
    workItems: [{
      id: "w1",
      ownerAgentId: "coding",
      objective: "Implement the scoped change.",
      dependencies: [],
      ownedPaths: ["src/foo.js"],
      acceptanceCriteria: ["AC-1"],
      validation,
      ...(validationCommandIds ? { validationCommandIds } : {}),
      validationExecutionScope: "workspace",
      executionMode: "agent",
      complexity: "low",
      estimatedFiles: 1,
      contractChange: false,
      migration: false,
    }],
  };
}

test("slash-delimited product prose is not executable validation authority", () => {
  assert.equal(isExecutableValidationCommand("HTTP/BFF/ML identity tests including N06."), false);
  assert.equal(isExecutableValidationCommand("API/BFF tenant isolation verification."), false);
  assert.equal(isExecutableValidationCommand("docs/product/PRD.md evidence review"), false);
});

test("unambiguous repository-relative scripts remain executable validation authority", () => {
  assert.equal(isExecutableValidationCommand("scripts/verify.sh --strict"), true);
  assert.equal(isExecutableValidationCommand("packages/foo/tests/check.mjs --ci"), true);
  assert.equal(isExecutableValidationCommand("tools/check --all"), true);
  assert.equal(isExecutableValidationCommand("./apps/foo/check --all"), true);
});

test("Technical Plan does not demand byte-exact prose verification containing slashes", () => {
  const schema = JSON.parse(readFileSync(join(process.cwd(), ".agents/schemas/implementation-plan.schema.json"), "utf8"));
  const proseCriterion = {
    id: "CLV2-02",
    source: "docs/product/PRD.md",
    statement: "Tenant and actor derive from authenticated identity.",
    blocking: true,
    verification: "HTTP/BFF/ML identity tests including N06.",
    proofStage: "implementation",
  };
  const implementationPlan = {
    schemaVersion: 1,
    revision: 1,
    coordinatorAgentId: "main-orchestrator",
    acceptanceCriteria: [proseCriterion],
    workItems: [{
      id: "WI-01-identity-review",
      ownerAgentId: "coding",
      objective: "Implement identity authority.",
      dependencies: [],
      ownedPaths: ["src/foo.js"],
      acceptanceCriteria: ["CLV2-02"],
      validation: ["npm test"],
      validationCommandIds: [validationCommandId("npm test")],
      validationExecutionScope: "workspace",
      executionMode: "agent",
      complexity: "high",
      estimatedFiles: 2,
      contractChange: true,
      migration: false,
    }],
  };
  const issues = technicalPlanRepairIssues({
    implementationPlan,
    implementationPlanSchema: schema,
    requiredAcceptanceCriteria: [proseCriterion],
    registry: registry(),
    validationCommandCatalog: [{ id: validationCommandId("npm test"), command: "npm test", source: "package.json#scripts.test" }],
  });

  assert.equal(
    issues.some((issue) => issue.startsWith("implementation_plan_criterion_verification_missing:")),
    false,
  );
});

test("validation command IDs are deterministic and byte-sensitive", () => {
  const a = validationCommandId("npm test");
  assert.match(a, /^vcmd:sha256:[a-f0-9]{64}$/u);
  assert.equal(a, validationCommandId("  npm test  "));
  assert.notEqual(a, validationCommandId("npm run test"));
});

test("projection validation rejects reordered or forged IDs", () => {
  const commands = ["npm test", "npm run lint"];
  const ids = commands.map(validationCommandId);
  assert.deepEqual(validationCommandProjectionIssues({ commandIds: ids, commands }), []);
  assert.match(validationCommandProjectionIssues({ commandIds: ids.toReversed(), commands })[0], /id_mismatch/u);
  assert.match(validationCommandProjectionIssues({ commandIds: ids.slice(0, 1), commands })[0], /length_mismatch/u);
});

test("deterministic catalog emits IDs and ignores non-validation scripts", async t => {
  const workspace = fixture(t);
  const catalog = await buildValidationCommandCatalog({
    workspace,
    brief: { validation: [], objective: "implement" },
    requiredAcceptanceCriteria: [criterion()],
  });
  const commands = catalog.map(entry => entry.command);
  assert.ok(commands.includes("npm test"));
  assert.ok(commands.includes("npm run test"));
  assert.ok(commands.includes("npm run lint"));
  assert.ok(!commands.includes("npm run start"));
  for (const entry of catalog) {
    assert.equal(entry.id, validationCommandId(entry.command));
    assert.ok(entry.source);
  }
});

test("legacy exact validation is mechanically upgraded to IDs without a model call", async t => {
  const workspace = fixture(t);
  const catalog = await buildValidationCommandCatalog({
    workspace,
    brief: { validation: [], objective: "implement" },
    requiredAcceptanceCriteria: [criterion()],
  });
  const result = normalizeTechnicalPlanMechanics({
    implementationPlan: plan(),
    requiredAcceptanceCriteria: [criterion()],
    registry: registry(),
    validationCommandCatalog: catalog,
  });
  assert.deepEqual(result.plan.workItems[0].validation, ["npm test"]);
  assert.deepEqual(result.plan.workItems[0].validationCommandIds, [validationCommandId("npm test")]);
  assert.ok(result.evidence.includes("work-item-updated:w1:validationCommandIds"));
});

test("known IDs dominate a conflicting model-authored string projection", async t => {
  const workspace = fixture(t);
  const catalog = await buildValidationCommandCatalog({
    workspace,
    brief: { validation: [], objective: "implement" },
    requiredAcceptanceCriteria: [criterion()],
  });
  const lintId = validationCommandId("npm run lint");
  const result = normalizeTechnicalPlanMechanics({
    implementationPlan: plan(["npm test"], [lintId]),
    requiredAcceptanceCriteria: [{
      ...criterion(),
      verification: "verification is performed downstream",
    }],
    registry: registry(),
    validationCommandCatalog: catalog,
  });
  assert.deepEqual(result.plan.workItems[0].validationCommandIds, [lintId]);
  assert.deepEqual(result.plan.workItems[0].validation, ["npm run lint"]);
});

test("dynamic Technical Plan schema enumerates catalog IDs separately from commands", async t => {
  const workspace = fixture(t);
  const catalog = await buildValidationCommandCatalog({
    workspace,
    brief: { validation: [], objective: "implement" },
    requiredAcceptanceCriteria: [criterion()],
  });
  const schema = JSON.parse(readFileSync(join(process.cwd(), ".agents/schemas/implementation-plan.schema.json"), "utf8"));
  const dynamic = buildTechnicalPlanStructuredSchema({
    implementationPlanSchema: schema,
    requiredAcceptanceCriteria: [criterion()],
    registry: registry(),
    validationCommandCatalog: catalog,
  });
  const item = dynamic.properties.workItems.items.properties;
  assert.ok(item.validation.items.enum.includes("npm test"));
  assert.ok(item.validationCommandIds.items.enum.includes(validationCommandId("npm test")));
  assert.ok(item.validationCommandIds.items.enum.every(id => /^vcmd:sha256:/u.test(id)));
});

test("repair issues fail closed on unauthorized or mismatched ID projections", async t => {
  const workspace = fixture(t);
  const catalog = await buildValidationCommandCatalog({
    workspace,
    brief: { validation: [], objective: "implement" },
    requiredAcceptanceCriteria: [criterion()],
  });
  const schema = JSON.parse(readFileSync(join(process.cwd(), ".agents/schemas/implementation-plan.schema.json"), "utf8"));

  const missingIds = technicalPlanRepairIssues({
    implementationPlan: plan(),
    implementationPlanSchema: schema,
    requiredAcceptanceCriteria: [criterion()],
    registry: registry(),
    validationCommandCatalog: catalog,
  });
  assert.ok(missingIds.some(issue => issue === "implementation_plan_validation_command_ids_missing:w1"));

  const forged = plan(["npm test"], [validationCommandId("npm run lint")]);
  const forgedIssues = technicalPlanRepairIssues({
    implementationPlan: forged,
    implementationPlanSchema: schema,
    requiredAcceptanceCriteria: [criterion()],
    registry: registry(),
    validationCommandCatalog: catalog,
  });
  assert.ok(forgedIssues.some(issue => issue === "implementation_plan_validation_command_projection_mismatch:w1"));

  const unknown = plan(["npm test"], ["vcmd:sha256:" + "f".repeat(64)]);
  const unknownIssues = technicalPlanRepairIssues({
    implementationPlan: unknown,
    implementationPlanSchema: schema,
    requiredAcceptanceCriteria: [criterion()],
    registry: registry(),
    validationCommandCatalog: catalog,
  });
  assert.ok(unknownIssues.some(issue => issue.includes("implementation_plan_validation_command_id_unauthorized:w1")));
});
