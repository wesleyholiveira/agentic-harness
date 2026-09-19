import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  applyValidationCommandRepairs,
  buildTechnicalPlanStructuredSchema,
  buildValidationCommandCatalog,
  buildValidationCommandRepairPrompt,
  normalizeTechnicalPlanMechanics,
  technicalPlanRepairIssues,
} from "../../.agents/runtime/technical-plan-synthesis.mjs";

test("validation command catalog uses only independent deterministic command authority", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-harness-validation-catalog-"));
  try {
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      packageManager: "npm@11",
      scripts: {
        dev: "node dev.mjs",
        "test:ml": "python apps/ml/run_tests.py",
        "test:schema": "node scripts/test-schema.mjs",
        "check:types": "tsc --noEmit",
      },
    }), "utf8");

    const catalog = await buildValidationCommandCatalog({
      workspace,
      brief: {
        objective: "Implement schema validation.",
        validation: [],
      },
      // These legacy arguments are deliberately ignored as command authority.
      implementationPlan: {
        workItems: [{
          id: "W01",
          validation: ["pytest -q tests/domain-contracts"],
        }],
      },
      requiredAcceptanceCriteria: [{
        id: "AC-1",
        verification: "npm run test:ml",
      }],
      evidence: [{
        path: "docs/plan.md",
        content: "Focused validation: `pytest tests/test_upgrade.py -k populated_upgrade`",
      }],
    });

    const commands = catalog.map((entry) => entry.command);
    assert.ok(commands.includes("npm run test:ml"));
    assert.ok(commands.includes("npm run test:schema"));
    assert.ok(commands.includes("npm run check:types"));
    assert.ok(!commands.includes("npm run dev"));
    assert.ok(!commands.includes("pytest -q tests/domain-contracts"));
    assert.ok(!commands.includes("pytest tests/test_upgrade.py -k populated_upgrade"));
    assert.ok(!catalog.some((entry) => String(entry.source).startsWith("implementation-plan:")));
    assert.ok(!catalog.some((entry) => String(entry.source).startsWith("technical-artifact:")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validation command repair mutates only validation and preserves exact criterion verification", () => {
  const sourcePlan = {
    schemaVersion: 1,
    revision: 1,
    acceptanceCriteria: [{
      id: "AC-1",
      source: "spec",
      statement: "Tenant isolation is enforced.",
      blocking: true,
      verification: "pytest tests/test_identity.py -k tenant_isolation",
      proofStage: "implementation",
    }],
    workItems: [{
      id: "W01",
      ownerAgentId: "coding-pro",
      objective: "Implement identity constraints.",
      dependencies: [],
      ownedPaths: ["src/identity.py"],
      acceptanceCriteria: ["AC-1"],
      validation: ["Identity tampering and cross-tenant negative tests"],
      validationExecutionScope: "workspace",
      complexity: "medium",
      estimatedFiles: 1,
      contractChange: true,
      migration: false,
    }],
  };

  const applied = applyValidationCommandRepairs({
    implementationPlan: sourcePlan,
    requiredAcceptanceCriteria: sourcePlan.acceptanceCriteria,
    repairs: [{
      workItemId: "W01",
      validation: ["npm run test:schema"],
    }],
  });

  assert.deepEqual(applied.plan.workItems[0].validation, [
    "npm run test:schema",
    "pytest tests/test_identity.py -k tenant_isolation",
  ]);
  assert.equal(applied.plan.workItems[0].objective, sourcePlan.workItems[0].objective);
  assert.deepEqual(applied.plan.workItems[0].ownedPaths, sourcePlan.workItems[0].ownedPaths);
  assert.deepEqual(applied.plan.workItems[0].acceptanceCriteria, ["AC-1"]);
});

test("deterministic mechanics replaces prose when an exact criterion command exists", () => {
  const criteria = [{
    id: "AC-1",
    source: "spec",
    statement: "Schema is valid.",
    blocking: true,
    verification: "pytest tests/test_schema.py -k tenant_isolation",
    proofStage: "implementation",
  }];
  const plan = {
    schemaVersion: 1,
    revision: 1,
    acceptanceCriteria: criteria,
    workItems: [{
      id: "W01",
      ownerAgentId: "coding-pro",
      objective: "Implement schema.",
      dependencies: [],
      ownedPaths: ["src/schema.py"],
      acceptanceCriteria: ["AC-1"],
      validation: ["Constraint, index, tenant-isolation, champion-CAS, and quarantine tests"],
      validationExecutionScope: "workspace",
      complexity: "medium",
      estimatedFiles: 1,
      contractChange: true,
      migration: true,
    }],
  };

  const normalized = normalizeTechnicalPlanMechanics({
    implementationPlan: plan,
    requiredAcceptanceCriteria: criteria,
    registry: {
      agents: [{
        id: "coding-pro",
        executionRole: "implementation",
        ownershipMode: "fallback-unclaimed-primary",
        primaryPaths: [],
        sharedPaths: [],
        collaborativePaths: [],
      }],
    },
  });

  assert.deepEqual(normalized.plan.workItems[0].validation, [
    "pytest tests/test_schema.py -k tenant_isolation",
  ]);
});

test("validation repair prompt forbids invented commands", () => {
  const prompt = buildValidationCommandRepairPrompt({
    brief: { objective: "Implement schema." },
    implementationPlan: {
      workItems: [{
        id: "W01",
        objective: "Implement schema.",
        ownedPaths: ["src/schema.py"],
        acceptanceCriteria: ["AC-1"],
        validation: ["schema tests"],
      }],
    },
    requiredAcceptanceCriteria: [{
      id: "AC-1",
      statement: "Schema works.",
      verification: "pytest tests/test_schema.py",
    }],
    targetWorkItemIds: ["W01"],
    validationCommandCatalog: [{
      command: "pytest tests/test_schema.py",
      source: "acceptance-criterion:AC-1",
    }],
    deterministicValidationIssues: [
      "validation_command_not_executable:W01:0:schema tests",
    ],
  });

  assert.match(prompt, /MUST be selected byte-for-byte from validationCommandCatalog\.command/u);
  assert.match(prompt, /Do NOT guess/u);
  assert.match(prompt, /full Technical Lead retry with repository tools/u);
});

test("syntactically executable model-authored validation cannot self-authorize", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const implementationPlanSchema = JSON.parse(
    readFileSync(resolve(root, ".agents/schemas/implementation-plan.schema.json"), "utf8"),
  );
  const criteria = [{
    id: "AC-1",
    source: "spec",
    statement: "Domain contracts are verified.",
    blocking: true,
    verification: "npm run test:ml",
    proofStage: "implementation",
  }];
  const registry = {
    orchestrator: "main-orchestrator",
    agents: [
      {
        id: "main-orchestrator",
        role: "delivery-orchestrator",
        kind: "orchestrator",
        executionRole: "contract",
        orchestrationRole: "orchestrator",
        skills: ["operate-multi-agent-runtime"],
        primaryPaths: [],
        sharedPaths: [],
        collaborativePaths: [],
      },
      {
        id: "coding-pro",
        role: "coding-pro",
        kind: "implementation",
        executionRole: "implementation",
        orchestrationRole: "specialist",
        ownershipMode: "fallback-unclaimed-primary",
        skills: [],
        primaryPaths: [],
        sharedPaths: [],
        collaborativePaths: [],
      },
    ],
  };
  const plan = {
    schemaVersion: 1,
    revision: 1,
    coordinatorAgentId: "main-orchestrator",
    acceptanceCriteria: structuredClone(criteria),
    workItems: [{
      id: "W01",
      ownerAgentId: "coding-pro",
      objective: "Implement domain contracts.",
      dependencies: [],
      ownedPaths: ["src/domain-contracts.py"],
      acceptanceCriteria: ["AC-1"],
      validation: ["pytest -q tests/domain-contracts"],
      validationExecutionScope: "workspace",
      complexity: "medium",
      estimatedFiles: 1,
      contractChange: true,
      migration: false,
    }],
  };
  const trustedCatalog = [{
    command: "npm run test:ml",
    source: "package.json#scripts.test:ml",
  }];

  const issues = technicalPlanRepairIssues({
    implementationPlan: plan,
    implementationPlanSchema,
    requiredAcceptanceCriteria: criteria,
    registry,
    validationCommandCatalog: trustedCatalog,
  });

  assert.ok(issues.includes(
    "implementation_plan_validation_command_unauthorized:W01:0:pytest -q tests/domain-contracts",
  ));

  const schema = buildTechnicalPlanStructuredSchema({
    implementationPlanSchema,
    requiredAcceptanceCriteria: criteria,
    registry,
    validationCommandCatalog: trustedCatalog,
  });
  assert.deepEqual(
    schema.properties.workItems.items.properties.validation.items.enum,
    ["npm run test:ml"],
  );
});
