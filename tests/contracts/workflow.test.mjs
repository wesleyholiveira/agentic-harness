import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadAgentCatalog } from "../../.agents/runtime/agent-catalog.mjs";
import { loadSchemas, validateAgainstSchema } from "../../.agents/runtime/schema-validator.mjs";
import { createExecutionPlan } from "../../.agents/runtime/planner.mjs";
import { provisionalizeBootstrapPlan } from "../../.agents/runtime/bootstrap-topology-refiner.mjs";
import { collectImplementationPlanValidationIssues } from "../../.agents/runtime/dag-compiler.mjs";
import { projectOwnershipRegistry } from "../../.agents/runtime/agent-input-manifest.mjs";
import { productDiscoveryAcceptanceCriteriaIssue } from "../../.agents/runtime/product-discovery-acceptance-criteria.mjs";
import { cleanupWorkspace, createIsolatedWorkspace, inspectWorkspaceChanges, integrateWorkspace } from "../../.agents/runtime/workspace.mjs";
import { runProcess } from "../../.agents/runtime/process.mjs";

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


test("worktree integration materializes newly created implementation files for downstream workspaces", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "agent-harness-worktree-integration-"));
  const repositoryRoot = join(tempRoot, "consumer");
  const workspacePath = join(tempRoot, "implementation-worktree");
  await mkdir(repositoryRoot, { recursive: true });
  let workspace = null;
  try {
    for (const [args, label] of [
      [["init", "--quiet"], "git-init"],
      [["config", "user.email", "qualification@example.invalid"], "git-email"],
      [["config", "user.name", "Qualification"], "git-name"],
      [["config", "core.autocrlf", "true"], "git-autocrlf"],
    ]) {
      const result = await runProcess("git", args, { cwd: repositoryRoot });
      assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
    }
    await writeFile(join(repositoryRoot, "README.md"), "baseline\n", "utf8");
    let result = await runProcess("git", ["add", "README.md"], { cwd: repositoryRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    result = await runProcess("git", ["commit", "--quiet", "-m", "baseline"], { cwd: repositoryRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const task = {
      taskId: "run-test:implementation:format-name",
      agentId: "coding-fast",
      dependencies: [],
      ownedPaths: ["src/**", "test/**"],
    };
    workspace = await createIsolatedWorkspace({
      repositoryRoot,
      runDirectory: join(repositoryRoot, ".runtime", "agents", "runs", "run-test"),
      task,
      mode: "worktree",
      workspacePath,
    });
    await mkdir(join(workspace.path, "src"), { recursive: true });
    await mkdir(join(workspace.path, "test"), { recursive: true });
    await writeFile(join(workspace.path, "src", "format-name.mjs"), "export const formatName = (name) => name || 'Anonymous';\n", "utf8");
    await writeFile(join(workspace.path, "test", "format-name.test.mjs"), "export const fixture = true;\n", "utf8");

    const inspection = await inspectWorkspaceChanges(workspace, task);
    assert.deepEqual(inspection.changedPaths, ["src/format-name.mjs", "test/format-name.test.mjs"]);

    const conflicts = [];
    const integrated = new Map();
    const store = {
      async integratedPath() { return null; },
      async addConflict(entry) { conflicts.push(entry); },
      async markIntegratedPath(_runId, _taskId, path, fingerprint) { integrated.set(path, fingerprint); },
      async event() {},
    };
    const integratedInspection = await integrateWorkspace({
      repositoryRoot,
      workspace,
      task,
      store,
      runId: "run-test",
      inspection,
      approvedChangedPaths: inspection.changedPaths,
    });

    assert.deepEqual(integratedInspection.changedPaths, ["src/format-name.mjs", "test/format-name.test.mjs"]);
    assert.equal((await readFile(join(repositoryRoot, "src", "format-name.mjs"), "utf8")).replaceAll("\r\n", "\n"), "export const formatName = (name) => name || 'Anonymous';\n");
    assert.equal((await readFile(join(repositoryRoot, "test", "format-name.test.mjs"), "utf8")).replaceAll("\r\n", "\n"), "export const fixture = true;\n");
    assert.equal(conflicts.length, 0);
    assert.match(integrated.get("src/format-name.mjs") ?? "", /^[a-f0-9]{64}$/);
    assert.match(integrated.get("test/format-name.test.mjs") ?? "", /^[a-f0-9]{64}$/);
  } finally {
    if (workspace) await cleanupWorkspace(repositoryRoot, workspace).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});
