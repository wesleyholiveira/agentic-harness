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
import { cleanupWorkspace, createIsolatedWorkspace, inspectWorkspaceChanges, integrateWorkspace, reconcileHandoffPathDisposition } from "../../.agents/runtime/workspace.mjs";
import { runProcess } from "../../.agents/runtime/process.mjs";
import { buildContinuationPrompt } from "../../.agents/runtime/continuation.mjs";
import {
  buildTechnicalReviewRepairProjectionPrompt,
  buildTechnicalReviewRepairProjectionSchema,
  finalizeTechnicalReviewRepair,
} from "../../.agents/runtime/handoff-structured-finalization.mjs";

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



test("standalone terminal continuation resumes the original user request with a finite post-wake protocol", () => {
  const prompt = buildContinuationPrompt({
    runId: "run-standalone",
    eventType: "run.completed",
    effectKey: "sha256:test-effect",
    generation: 1,
  });
  assert.match(prompt, /agent_summary exactly once/);
  assert.match(prompt, /continue the original user conversation/);
  assert.match(prompt, /give the user the final outcome/);
  assert.match(prompt, /end this resumed assistant turn/);
  assert.match(prompt, /Do not call agent_start again for this same run\/request/);
  assert.match(prompt, /context_efficiency.*only when the original user request explicitly requires/);
  assert.match(prompt, /External qualification, fault injection, promotion gates, and harness verdicts are owned by the host qualification controller/);
  assert.doesNotMatch(prompt, /outer-controller procedure/);
  assert.doesNotMatch(prompt, /required final report\/verdict/);
});

test("SDD process skills stay behind the persistent Main Orchestrator Runtime ingress boundary", () => {
  const skill = readFileSync(resolve(root, ".agents/skills/sdd-workflow/SKILL.md"), "utf8");
  assert.match(skill, /Persistent Main Orchestrator boundary/);
  assert.match(skill, /captures `runtime-continuation`, calls Context Engine `agent_start`/);
  assert.match(skill, /must not invoke Superpowers design\/implementation process skills/);
  assert.match(skill, /For Runtime-dispatched specialist children, Superpowers is stage-compatible guidance rather than a second workflow authority/);
});

test("persistent Main Orchestrator does not re-enter delivery after a terminal continuation", () => {
  const source = readFileSync(resolve(root, ".agents/agents/main-orchestrator/AGENT.md"), "utf8");
  assert.match(source, /call `agent_summary` exactly once for the delivered run/);
  assert.match(source, /answer the original user from authoritative Runtime state and terminate the resumed turn/);
  assert.match(source, /Do not call `agent_start`, `agent_wait`, `agent_status`, or `agent_progress` again/);
  assert.match(source, /External harness qualification\/fault\/promotion gates remain host-controller authority/);
});

function technicalReviewRepairFixture() {
  const brief = {
    schemaVersion: 2,
    runId: "run-repair",
    taskId: "run-repair:technical-refinement",
    agentId: "technical-lead",
    objective: "Compile the approved Anonymous fallback increment into an implementation plan.",
    acceptanceCriteria: [
      { id: "PROC-TL-1", source: "runtime", statement: "coverage", blocking: true, verification: "plan coverage" },
      { id: "PROC-TL-2", source: "runtime", statement: "bounded work", blocking: true, verification: "plan schema" },
      { id: "PROC-TL-3", source: "runtime", statement: "acyclic", blocking: true, verification: "dag compiler" },
    ],
    upstreamAcceptanceCriteria: [
      { id: "AC-IMPL-1", source: "docs/specs/example/PRD.md", statement: "Blank names return Anonymous.", blocking: true, verification: "npm test", proofStage: "implementation" },
    ],
    validation: [],
    sdd: { role: "technical-lead", stage: "technical-refinement", reviewedRevision: 1 },
  };
  const handoff = {
    schemaVersion: 2,
    runId: brief.runId,
    taskId: brief.taskId,
    agentId: brief.agentId,
    status: "complete",
    artifactVersion: "technical-refinement-r2",
    changedPaths: [],
    contractChanges: [],
    assumptions: [],
    criterionResults: brief.acceptanceCriteria.map((criterion) => ({ criterionId: criterion.id, result: "passed", evidence: `proved ${criterion.id}` })),
    validation: [],
    residualRisks: ["blocking: keep the work item validation scoped to npm test", "non-blocking: implementation still pending"],
    followUps: ["required: preserve the Product criterion on the implementation work item", "optional: implementation specialist may add comments"],
    implementationPlan: {
      schemaVersion: 1,
      revision: 2,
      acceptanceCriteria: brief.upstreamAcceptanceCriteria,
      workItems: [],
    },
  };
  const contextPacket = { upstreamArtifacts: [] };
  const requiredDeltas = [
    "Use npm test as the exact work-item validation command.",
    "Assign AC-IMPL-1 to the implementation work item.",
  ];
  return { brief, handoff, contextPacket, requiredDeltas };
}

test("Technical Refinement same-attempt re-review has a closed requiredDelta scope", async () => {
  const handoffSchema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/handoff-result.schema.json"), "utf8"));
  const { brief, handoff, contextPacket, requiredDeltas } = technicalReviewRepairFixture();
  const schema = buildTechnicalReviewRepairProjectionSchema({ handoffSchema, brief, handoff, contextPacket, requiredDeltas });

  assert.deepEqual(schema.properties.sddReview.properties.decision.enum, ["approved", "changes_requested"]);
  assert.deepEqual(schema.properties.sddReview.properties.requiredDeltas.items.enum, requiredDeltas);
  assert.deepEqual(schema.properties.repairClosure.properties.resolvedResidualRisks.items.enum, ["blocking: keep the work item validation scoped to npm test"]);
  assert.deepEqual(schema.properties.repairClosure.properties.resolvedFollowUps.items.enum, ["required: preserve the Product criterion on the implementation work item"]);

  const expanded = {
    sddReview: {
      role: "technical-lead",
      stage: "technical-refinement",
      decision: "changes_requested",
      reviewedRevision: 1,
      nextRole: "technical-lead",
      requiredDeltas: ["Invent a new unrelated requirement."],
    },
    repairClosure: { resolvedResidualRisks: [], resolvedFollowUps: [] },
  };
  const result = validateAgainstSchema(expanded, schema, "technicalRepairProjection");
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("expected one of")));

  const prompt = buildTechnicalReviewRepairProjectionPrompt({ brief, handoff, contextPacket, requiredDeltas });
  assert.match(prompt, /complete and immutable semantic review scope/);
  assert.match(prompt, /Never add a new delta/);
  assert.match(prompt, /PRE-REPAIR Handoff/);
  assert.doesNotMatch(prompt, /sourceHandoff/);
});

test("Technical Refinement repair closes only explicitly re-reviewed stale blockers and remains fail-closed otherwise", async () => {
  const handoffSchema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/handoff-result.schema.json"), "utf8"));
  const { brief, handoff, contextPacket, requiredDeltas } = technicalReviewRepairFixture();
  const approvedProjection = {
    sddReview: {
      role: "technical-lead",
      stage: "technical-refinement",
      decision: "approved",
      reviewedRevision: 1,
      nextRole: "implementation",
      requiredDeltas: [],
    },
    repairClosure: {
      resolvedResidualRisks: ["blocking: keep the work item validation scoped to npm test"],
      resolvedFollowUps: ["required: preserve the Product criterion on the implementation work item"],
    },
  };
  const structuredRunner = async () => ({ value: approvedProjection, info: { tokens: { input: 10, output: 5 } }, sessionId: "ses-repair", attempts: 1, failures: [] });
  const finalized = await finalizeTechnicalReviewRepair({
    workspace: root,
    model: "openai/gpt-5.6-luna",
    brief,
    contextPacket,
    handoff,
    handoffSchema,
    requiredDeltas,
    structuredRunner,
  });
  assert.equal(finalized.handoff.sddReview.decision, "approved");
  assert.deepEqual(finalized.handoff.sddReview.requiredDeltas, []);
  assert.deepEqual(finalized.handoff.residualRisks, ["non-blocking: implementation still pending"]);
  assert.deepEqual(finalized.handoff.followUps, ["optional: implementation specialist may add comments"]);
  assert.equal(finalized.handoff.findings.at(-1)?.authority, "closed-technical-review-repair-projection");

  const unsafeRunner = async () => ({
    value: { ...approvedProjection, repairClosure: { resolvedResidualRisks: [], resolvedFollowUps: [] } },
    info: {},
    sessionId: "ses-unsafe",
  });
  await assert.rejects(
    finalizeTechnicalReviewRepair({ workspace: root, model: "openai/gpt-5.6-luna", brief, contextPacket, handoff, handoffSchema, requiredDeltas, structuredRunner: unsafeRunner }),
    /technical_review_repair_projection_unproven:review_approval_not_proven:/,
  );
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


test("zero-file governance review drops non-evidentiary phantom reused path absent from workspace and baseline", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "agent-harness-phantom-reuse-"));
  try {
    const phantomPath = "docs/architecture/example-anonymous-fallback.md";
    const task = {
      taskId: "run-test:architecture-review",
      agentId: "architecture-governance",
      role: "contract",
      stage: "architecture-review",
      estimatedFiles: 0,
      ownedPaths: ["docs/architecture/**", "docs/adr/**", "docs/specs/**"],
    };
    const handoff = {
      status: "complete",
      changedPaths: [],
      reusedPaths: [phantomPath],
      usedContextPaths: ["docs/specs/example/PRD.md"],
      criterionResults: [{
        criterionId: "PROC-ARCH-1",
        result: "passed",
        evidence: "Reviewed the approved Product Discovery scope and its boundary constraints.",
      }],
      validation: [],
      assumptions: [],
      contractChanges: [],
      residualRisks: [],
      followUps: [],
    };
    const disposition = await reconcileHandoffPathDisposition({
      workspace: { mode: "copy", path: tempRoot, baseline: new Map() },
      task,
      inspection: { changedPaths: [] },
      handoff,
      changedPaths: handoff.changedPaths,
      reusedPaths: handoff.reusedPaths,
      contextReferencePaths: handoff.usedContextPaths,
    });

    assert.deepEqual(disposition.changedPaths, []);
    assert.deepEqual(disposition.reusedPaths, []);
    assert.deepEqual(disposition.droppedPhantomReusedPaths, [phantomPath]);
    assert.deepEqual(disposition.invalidReused, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("governance phantom reused path remains fail-closed when handoff evidence references it", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "agent-harness-phantom-evidence-"));
  try {
    const phantomPath = "docs/architecture/example-anonymous-fallback.md";
    const task = {
      taskId: "run-test:architecture-review",
      agentId: "architecture-governance",
      role: "contract",
      stage: "architecture-review",
      estimatedFiles: 0,
      ownedPaths: ["docs/architecture/**"],
    };
    const handoff = {
      status: "complete",
      changedPaths: [],
      reusedPaths: [phantomPath],
      criterionResults: [{
        criterionId: "PROC-ARCH-1",
        result: "passed",
        evidence: `Architecture proof is recorded in ${phantomPath}.`,
      }],
      validation: [],
    };
    const disposition = await reconcileHandoffPathDisposition({
      workspace: { mode: "copy", path: tempRoot, baseline: new Map() },
      task,
      inspection: { changedPaths: [] },
      handoff,
      reusedPaths: handoff.reusedPaths,
    });

    assert.deepEqual(disposition.droppedPhantomReusedPaths, []);
    assert.deepEqual(disposition.invalidReused, [{
      path: phantomPath,
      valid: false,
      reason: "missing_in_workspace_and_baseline",
    }]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("missing pre-existing reused artifact is never normalized as a phantom", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "agent-harness-missing-baseline-reuse-"));
  try {
    const path = "docs/architecture/existing.md";
    const task = {
      taskId: "run-test:architecture-review",
      agentId: "architecture-governance",
      role: "contract",
      stage: "architecture-review",
      estimatedFiles: 0,
      ownedPaths: ["docs/architecture/**"],
    };
    const handoff = { status: "complete", changedPaths: [], reusedPaths: [path], criterionResults: [], validation: [] };
    const disposition = await reconcileHandoffPathDisposition({
      workspace: {
        mode: "copy",
        path: tempRoot,
        baseline: new Map([[path, { sha256: "baseline", bytes: 8 }]]),
      },
      task,
      inspection: { changedPaths: [] },
      handoff,
      reusedPaths: handoff.reusedPaths,
    });

    assert.deepEqual(disposition.droppedPhantomReusedPaths, []);
    assert.deepEqual(disposition.invalidReused, [{ path, valid: false, reason: "missing_in_workspace" }]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("phantom reused paths remain fail-closed outside zero-file governance reviews", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "agent-harness-implementation-phantom-reuse-"));
  try {
    const path = "src/format-name.mjs";
    const task = {
      taskId: "run-test:implementation:format-name",
      agentId: "coding-fast",
      role: "implementation",
      stage: "implementation",
      estimatedFiles: 1,
      ownedPaths: ["src/**"],
    };
    const handoff = { status: "complete", changedPaths: [], reusedPaths: [path], criterionResults: [], validation: [] };
    const disposition = await reconcileHandoffPathDisposition({
      workspace: { mode: "copy", path: tempRoot, baseline: new Map() },
      task,
      inspection: { changedPaths: [] },
      handoff,
      reusedPaths: handoff.reusedPaths,
    });

    assert.deepEqual(disposition.droppedPhantomReusedPaths, []);
    assert.deepEqual(disposition.invalidReused, [{
      path,
      valid: false,
      reason: "missing_in_workspace_and_baseline",
    }]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("bootstrap governance prompt forbids invented changed/reused artifact paths for zero-file reviews", () => {
  const source = readFileSync(resolve(root, "scripts/internal/opencode-task-executor.mjs"), "utf8");
  assert.match(source, /do not invent an architecture\/ADR\/review artifact path merely to populate changedPaths or reusedPaths/);
  assert.match(source, /if no pre-existing owned artifact was actually verified as output, reusedPaths must be \[\]/);
});
