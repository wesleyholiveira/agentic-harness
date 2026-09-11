import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
import {
  classifyTechnicalPlanRepairScope,
  normalizeTechnicalPlanMechanics,
  repairImplementationPlanFromReview,
  synthesizeMissingImplementationPlan,
  technicalPlanRepairIssues,
} from "../../.agents/runtime/technical-plan-synthesis.mjs";
import { cleanupWorkspace, createIsolatedWorkspace, inspectWorkspaceChanges, integrateWorkspace, isRetryableImplementationReuseFailure, reconcileHandoffPathDisposition } from "../../.agents/runtime/workspace.mjs";
import { runProcess } from "../../.agents/runtime/process.mjs";
import { buildContinuationPrompt } from "../../.agents/runtime/continuation.mjs";
import {
  buildHandoffFinalizationPrompt,
  buildHandoffFinalizationSchema,
  buildTechnicalReviewRepairProjectionPrompt,
  buildTechnicalReviewRepairProjectionSchema,
  finalizeHandoffStructured,
  finalizeTechnicalReviewRepair,
  requiresStructuredHandoffFinalization,
  reviewableHandoffProjection,
} from "../../.agents/runtime/handoff-structured-finalization.mjs";
import { resolveAuthoritativeHandoff } from "../../.agents/runtime/handoff-authority.mjs";
import { isExecutableValidationCommand, invalidValidationCommands } from "../../.agents/runtime/validation-command.mjs";
import { retryDispositionForFailure } from "../../.agents/runtime/retry-efficiency.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");




test("Quality Assurance review projection cannot veto fully proven QA evidence", async () => {
  const handoffSchema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/handoff-result.schema.json"), "utf8"));
  const brief = {
    runId: "run-r9-qa",
    taskId: "run-r9-qa:quality-assurance",
    agentId: "verification-evidence",
    objective: "Independently verify the R9 helper",
    acceptanceCriteria: [{
      id: "AC-R9-6",
      statement: "formatInitials behavior has independent automated coverage.",
      blocking: true,
    }],
    validation: ["npm test"],
    sdd: { role: "quality-assurance", stage: "quality-assurance", reviewedRevision: 1 },
  };
  const handoff = {
    schemaVersion: 2,
    runId: brief.runId,
    taskId: brief.taskId,
    agentId: brief.agentId,
    status: "complete",
    artifactVersion: "1",
    changedPaths: [],
    contractChanges: [],
    assumptions: [],
    criterionResults: [{ criterionId: "AC-R9-6", result: "passed", evidence: "node:test covers the helper behavior" }],
    validation: [{
      command: "npm test",
      phase: "final",
      blocking: true,
      result: "passed",
      evidence: "Runtime receipt exit=0",
      authority: "runtime",
      exitCode: 0,
      timedOut: false,
      executedAt: "2026-09-09T21:10:00.000Z",
    }],
    residualRisks: [],
    followUps: [],
    sddReview: {
      role: "quality-assurance",
      stage: "quality-assurance",
      decision: "changes_requested",
      reviewedRevision: 1,
      nextRole: "coding-fast",
      requiredDeltas: ["Re-run evidence already proven by Runtime receipts."],
    },
  };

  assert.equal(requiresStructuredHandoffFinalization({ brief, handoff, handoffSchema }), true);
  const schema = buildHandoffFinalizationSchema({ handoffSchema, brief, handoff, contextPacket: { upstreamArtifacts: [] } });
  assert.deepEqual(schema.properties.sddReview.properties.decision, { const: "approved" });
  assert.deepEqual(schema.properties.sddReview.properties.requiredDeltas, { const: [] });

  const structuredRunner = async () => ({
    value: {
      sddReview: {
        role: "quality-assurance",
        stage: "quality-assurance",
        decision: "approved",
        reviewedRevision: 1,
        nextRole: "coding-fast",
        requiredDeltas: [],
      },
    },
    info: {},
    sessionId: "ses-qa-evidence",
    attempts: 1,
    failures: [],
  });
  const finalized = await finalizeHandoffStructured({
    workspace: root,
    model: "openai/gpt-5.6-luna",
    brief,
    contextPacket: { upstreamArtifacts: [] },
    handoff,
    handoffSchema,
    structuredRunner,
  });
  assert.equal(finalized.handoff.sddReview.decision, "approved");
  assert.deepEqual(finalized.handoff.sddReview.requiredDeltas, []);
  assert.equal(finalized.handoff.criterionResults[0].result, "passed");
  assert.equal(finalized.handoff.validation[0].authority, "runtime");
});

test("Quality Assurance review remains fail-closed when authoritative QA evidence is not proven", () => {
  const handoffSchema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/handoff-result.schema.json"), "utf8"));
  const brief = {
    runId: "run-r9-qa-fail",
    taskId: "run-r9-qa-fail:quality-assurance",
    agentId: "verification-evidence",
    acceptanceCriteria: [{ id: "AC-R9-6", statement: "coverage", blocking: true }],
    validation: ["npm test"],
    sdd: { role: "quality-assurance", stage: "quality-assurance", reviewedRevision: 1 },
  };
  const handoff = {
    schemaVersion: 2,
    runId: brief.runId,
    taskId: brief.taskId,
    agentId: brief.agentId,
    status: "complete",
    artifactVersion: "1",
    changedPaths: [],
    contractChanges: [],
    assumptions: [],
    criterionResults: [{ criterionId: "AC-R9-6", result: "failed", evidence: "regression reproduced" }],
    validation: [{
      command: "npm test", phase: "final", blocking: true, result: "failed", evidence: "exit=1",
      authority: "runtime", exitCode: 1, timedOut: false, executedAt: "2026-09-09T21:10:00.000Z",
    }],
    residualRisks: ["blocking: regression remains"],
    followUps: [],
    sddReview: {
      role: "quality-assurance", stage: "quality-assurance", decision: "changes_requested", reviewedRevision: 1,
      nextRole: "coding-fast", requiredDeltas: ["Fix the reproduced regression."],
    },
  };

  assert.equal(requiresStructuredHandoffFinalization({ brief, handoff, handoffSchema }), false);
  const schema = buildHandoffFinalizationSchema({ handoffSchema, brief, handoff, contextPacket: { upstreamArtifacts: [] } });
  assert.deepEqual(schema.properties.sddReview.properties.decision, { const: "changes_requested" });
});

test("Handoff runtime identity canonicalizes one isolated model echo typo only when the other two identities match", () => {
  const handoffSchema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/handoff-result.schema.json"), "utf8"));
  const brief = {
    runId: "run-8c38392a-3866-4a11-8f91-08cf2a664e60",
    taskId: "run-8c38392a-3866-4a11-8f91-08cf2a664e60:product-acceptance",
    agentId: "product-owner",
  };
  const typoTaskId = "run-8c38392a-3866-4a11-8cf2a664e60:product-acceptance";
  const modelHandoff = {
    schemaVersion: 2,
    runId: brief.runId,
    taskId: typoTaskId,
    agentId: brief.agentId,
    status: "complete",
    artifactVersion: "1",
    changedPaths: [],
    contractChanges: [],
    assumptions: [],
    criterionResults: [],
    validation: [],
    residualRisks: [],
    followUps: [],
  };

  const resolved = resolveAuthoritativeHandoff({
    stdout: JSON.stringify({ role: "assistant", content: JSON.stringify(modelHandoff) }),
    handoffSchema,
    brief,
    attempt: 1,
  });

  assert.equal(resolved.handoff.runId, brief.runId);
  assert.equal(resolved.handoff.taskId, brief.taskId);
  assert.equal(resolved.handoff.agentId, brief.agentId);
  assert.equal(resolved.schemaValid, true);
  assert.deepEqual(resolved.normalization.identityEchoCorrections, [{
    field: "taskId",
    expected: brief.taskId,
    actual: typoTaskId,
  }]);
  assert.deepEqual(resolved.normalization.identityMismatches, []);
});

test("Handoff runtime identity remains fail-closed for ambiguous or multiple model identity conflicts", () => {
  const handoffSchema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/handoff-result.schema.json"), "utf8"));
  const brief = {
    runId: "run-authoritative",
    taskId: "run-authoritative:product-acceptance",
    agentId: "product-owner",
  };
  const modelHandoff = {
    schemaVersion: 2,
    runId: brief.runId,
    taskId: "run-other:product-acceptance",
    agentId: "verification-evidence",
    status: "complete",
    artifactVersion: "1",
    changedPaths: [],
    contractChanges: [],
    assumptions: [],
    criterionResults: [],
    validation: [],
    residualRisks: [],
    followUps: [],
  };

  assert.throws(
    () => resolveAuthoritativeHandoff({ stdout: JSON.stringify({ role: "assistant", content: JSON.stringify(modelHandoff) }), handoffSchema, brief, attempt: 1 }),
    /handoff_identity_mismatch:taskId:expected=run-authoritative:product-acceptance:actual=run-other:product-acceptance,agentId:expected=product-owner:actual=verification-evidence/u,
  );
});

test("agent-input manifest identity remains the fail-closed transport fence", () => {
  const source = readFileSync(resolve(root, "scripts/internal/opencode-task-executor.mjs"), "utf8");
  assert.match(source, /manifest\.runId !== brief\.runId \|\| manifest\.taskId !== brief\.taskId \|\| manifest\.agentId !== brief\.agentId/u);
  assert.match(source, /opencode_agent_input_manifest_identity_mismatch/u);
});

test("handoff auxiliary invocation schema covers every Runtime-produced purpose", () => {
  const schema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/handoff-result.schema.json"), "utf8"));
  const allowed = new Set(schema.properties.auxiliaryInvocations.items.properties.purpose.enum);
  const runtimeDir = resolve(root, ".agents/runtime");
  const produced = new Set();
  const purposePattern = /auxiliaryInvocationFromStructuredResult\(\{\s*purpose:\s*["']([^"']+)["']/g;
  for (const entry of readdirSync(runtimeDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    const source = readFileSync(resolve(runtimeDir, entry.name), "utf8");
    for (const match of source.matchAll(purposePattern)) produced.add(match[1]);
  }
  assert.ok(produced.size > 0, "Runtime must produce at least one auxiliary invocation purpose");
  assert.deepEqual([...produced].filter((purpose) => !allowed.has(purpose)).sort(), []);
});

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


test("Technical Refinement review projection excludes resolved Runtime diagnostics from semantic evidence", () => {
  const { brief, handoff, contextPacket } = technicalReviewRepairFixture();
  handoff.findings = [
    { type: "technical_plan_synthesis", status: "succeeded", reason: "deterministic_preflight:implementation_plan_path_overlap:old" },
    { type: "domain_finding", status: "open", detail: "preserve this semantic finding" },
  ];
  handoff.auxiliaryInvocations = [{ purpose: "technical-plan-synthesis" }];
  handoff.metrics = { inputTokens: 100 };
  handoff.executionTelemetry = { modelId: "example" };

  const projected = reviewableHandoffProjection(handoff);
  assert.deepEqual(projected.findings, [{ type: "domain_finding", status: "open", detail: "preserve this semantic finding" }]);
  assert.equal(Object.hasOwn(projected, "auxiliaryInvocations"), false);
  assert.equal(Object.hasOwn(projected, "metrics"), false);
  assert.equal(Object.hasOwn(projected, "executionTelemetry"), false);

  const prompt = buildHandoffFinalizationPrompt({ brief, handoff, contextPacket });
  assert.doesNotMatch(prompt, /implementation_plan_path_overlap:old/);
  assert.match(prompt, /domain_finding/);
  assert.match(prompt, /Never reconstruct requiredDeltas from historical pre-repair diagnostics/);
});

test("Technical Refinement changes_requested repair canonicalizes missing routing metadata", async () => {
  const handoffSchema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/handoff-result.schema.json"), "utf8"));
  const { brief, handoff, contextPacket, requiredDeltas } = technicalReviewRepairFixture();
  const structuredRunner = async () => ({
    value: {
      sddReview: {
        role: "technical-lead",
        stage: "technical-refinement",
        decision: "changes_requested",
        reviewedRevision: 1,
        nextRole: null,
        requiredDeltas: [requiredDeltas[0]],
      },
      repairClosure: { resolvedResidualRisks: [], resolvedFollowUps: [] },
    },
    info: {},
    sessionId: "ses-routing-normalization",
  });

  const finalized = await finalizeTechnicalReviewRepair({
    workspace: root, model: "openai/gpt-5.6-luna", brief, contextPacket, handoff, handoffSchema, requiredDeltas, structuredRunner,
  });
  assert.equal(finalized.handoff.sddReview.decision, "changes_requested");
  assert.equal(finalized.handoff.sddReview.nextRole, "technical-lead");
  assert.deepEqual(finalized.handoff.sddReview.requiredDeltas, [requiredDeltas[0]]);
});



test("Technical Refinement review boundary never requires downstream execution evidence before plan approval", () => {
  const { brief, handoff, contextPacket, requiredDeltas } = technicalReviewRepairFixture();
  const initialPrompt = buildHandoffFinalizationPrompt({ brief, handoff, contextPacket });
  const repairPrompt = buildTechnicalReviewRepairProjectionPrompt({ brief, handoff, contextPacket, requiredDeltas });
  const contextBuilder = readFileSync(resolve(root, ".agents/runtime/context-builder.mjs"), "utf8");
  const executor = readFileSync(resolve(root, "scripts/internal/opencode-task-executor.mjs"), "utf8");

  for (const prompt of [initialPrompt, repairPrompt]) {
    assert.match(prompt, /Technical Refinement approves implementationPlan readiness, not completed implementation/);
    assert.match(prompt, /npm test/);
    assert.match(prompt, /byte-identical post-state hashes/);
    assert.match(prompt, /later stages own/);
  }
  assert.match(contextBuilder, /Technical Refinement approves the implementationPlan as an executable future-work contract/);
  assert.match(contextBuilder, /Never require post-implementation evidence/);
  assert.match(executor, /Technical Refinement approves the executable future-work plan, not an already-executed implementation/);
});
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
  assert.equal(finalized.handoff.auxiliaryInvocations.at(-1)?.purpose, "technical-review-repair-projection");
  const finalizedValidation = validateAgainstSchema(finalized.handoff, handoffSchema, "handoffResult");
  assert.equal(finalizedValidation.valid, true, finalizedValidation.errors.join("\n"));

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



test("criterion verification prose mentioning npm test is not promoted to an executable validation command", async () => {
  assert.equal(isExecutableValidationCommand("npm test"), true);
  assert.equal(isExecutableValidationCommand("Test file is present and npm test executes successfully."), false);
  assert.equal(isExecutableValidationCommand("test file is present and npm test executes successfully."), false);
  assert.deepEqual(invalidValidationCommands(["test -f package.json"]), [{
    index: 0,
    command: "test -f package.json",
    reason: "validation_command_not_executable",
  }]);
  assert.equal(isExecutableValidationCommand('bash -lc "test -f package.json"'), true);

  const registry = await loadAgentCatalog(root);
  const criterion = {
    id: "AC-R9-6",
    source: "docs/specs/qualification/r9/PRD.md",
    statement: "Automated node:test coverage exists for the helper behavior.",
    blocking: true,
    verification: "Test file is present and npm test executes successfully.",
    proofStage: "implementation",
  };
  const plan = {
    schemaVersion: 1,
    revision: 1,
    acceptanceCriteria: [criterion],
    workItems: [{
      id: "R9-IMPLEMENT-FORMAT-INITIALS",
      ownerAgentId: "coding-fast",
      objective: "Implement formatInitials and its node:test coverage.",
      dependencies: [],
      ownedPaths: ["src/format-initials.mjs", "test/format-initials.test.mjs"],
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
});

test("Technical Refinement preflight deterministically repairs mechanical plan drift before whole-plan rewrite", async () => {
  const registry = await loadAgentCatalog(root);
  const implementationPlanSchema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/implementation-plan.schema.json"), "utf8"));
  const criteria = [
    {
      id: "CLV2-01",
      source: "modernization/04-ACCEPTANCE.md",
      statement: "Web identity behavior is implemented and covered.",
      blocking: true,
      verification: "npm run test:web",
      proofStage: "implementation",
    },
    {
      id: "CLV2-02",
      source: "modernization/04-ACCEPTANCE.md",
      statement: "Durable execution behavior is implemented and covered.",
      blocking: true,
      verification: "npm run test:runtime",
      proofStage: "implementation",
    },
    {
      id: "CLV2-QA",
      source: "modernization/04-ACCEPTANCE.md",
      statement: "Independent QA approves the integrated result.",
      blocking: true,
      verification: "Review QA evidence after implementation.",
      proofStage: "quality-assurance",
    },
  ];
  const sourcePlan = {
    schemaVersion: 1,
    revision: 1,
    acceptanceCriteria: criteria,
    workItems: [
      {
        id: "W-web",
        ownerAgentId: "frontend-specialist",
        objective: "Implement the web identity contract.",
        dependencies: [],
        ownedPaths: ["apps/web/**"],
        acceptanceCriteria: ["CLV2-01"],
        validation: ["npm run test:web"],
        validationExecutionScope: "workspace",
        complexity: "medium",
        estimatedFiles: 3,
        contractChange: false,
        migration: false,
      },
      {
        id: "W-web-tests",
        ownerAgentId: "coding-pro",
        objective: "Add the web identity integration tests.",
        dependencies: ["W-web"],
        ownedPaths: ["apps/web/tests/**"],
        acceptanceCriteria: ["CLV2-01"],
        validation: ["Web integration verification via npm run test:web"],
        validationExecutionScope: "workspace",
        complexity: "medium",
        estimatedFiles: 2,
        contractChange: false,
        migration: false,
      },
      {
        id: "W-durable",
        ownerAgentId: "coding-pro",
        objective: "Implement the durable execution slice.",
        dependencies: [],
        ownedPaths: ["src/runtime-durable.mjs"],
        acceptanceCriteria: ["CLV2-QA"],
        validation: ["Runtime durability rehearsal must pass"],
        validationExecutionScope: "workspace",
        complexity: "high",
        estimatedFiles: 2,
        contractChange: false,
        migration: false,
      },
    ],
  };
  const initialIssues = technicalPlanRepairIssues({
    implementationPlan: sourcePlan,
    implementationPlanSchema,
    requiredAcceptanceCriteria: criteria,
    registry,
    request: "Implement Learning V2 identity and durable execution.",
  });
  assert.ok(initialIssues.some((issue) => issue.includes("validation_command_not_executable")));
  assert.ok(initialIssues.some((issue) => issue.startsWith("implementation_plan_path_outside_agent_ownership:W-web-tests")));
  assert.ok(initialIssues.some((issue) => issue.startsWith("implementation_plan_path_overlap:")));
  assert.ok(initialIssues.includes("implementation_plan_work_item_without_implementation_criterion:W-durable"));
  assert.ok(initialIssues.includes("implementation_plan_uncovered_criterion:CLV2-02"));

  const mechanical = normalizeTechnicalPlanMechanics({ implementationPlan: sourcePlan, requiredAcceptanceCriteria: criteria, registry });
  assert.equal(mechanical.plan.workItems.find((item) => item.id === "W-web-tests").ownerAgentId, "frontend-specialist");
  assert.deepEqual(mechanical.plan.workItems.find((item) => item.id === "W-web-tests").validation, ["npm run test:web"]);

  let calls = 0;
  let observedTitle = "";
  const structuredRunner = async ({ title, schema }) => {
    calls += 1;
    observedTitle = title;
    assert.ok(schema.properties.assignments);
    return {
      value: {
        assignments: [{ workItemId: "W-durable", criterionId: "CLV2-02" }],
        unresolvedWorkItemIds: [],
        unresolvedCriterionIds: [],
      },
      info: { tokens: { input: 21, output: 5, cache: { read: 10 } } },
      sessionId: "ses-mechanical-repair",
      attempts: 1,
      failures: [],
    };
  };
  const handoff = { status: "complete", implementationPlan: structuredClone(sourcePlan), findings: [], auxiliaryInvocations: [], metrics: {} };
  const brief = {
    runId: "run-mechanical-repair",
    taskId: "run-mechanical-repair:technical-refinement",
    agentId: "technical-lead",
    objective: "Implement Learning V2 identity and durable execution.",
    upstreamAcceptanceCriteria: criteria,
    sdd: { stage: "technical-refinement" },
  };
  const repaired = await synthesizeMissingImplementationPlan({
    workspace: root,
    brief,
    handoff,
    implementationPlanSchema,
    registry,
    structuredRunner,
    models: ["openai/gpt-5.6-luna"],
    maxRepairPasses: 2,
  });

  assert.equal(calls, 1, "criterion mapping should avoid a whole-plan rewrite");
  assert.match(observedTitle, /criterion assignment repair/);
  assert.equal(repaired.repairKind, "criterion-assignment");
  assert.equal(repaired.handoff.implementationPlan.revision, 2);
  const repairedWebTests = repaired.handoff.implementationPlan.workItems.find((item) => item.id === "W-web-tests");
  assert.equal(repairedWebTests.ownerAgentId, "frontend-specialist");
  assert.deepEqual(repairedWebTests.validation, ["npm run test:web"]);
  const repairedDurable = repaired.handoff.implementationPlan.workItems.find((item) => item.id === "W-durable");
  assert.deepEqual(repairedDurable.acceptanceCriteria, ["CLV2-02"]);
  assert.deepEqual(repairedDurable.validation, ["npm run test:runtime"]);
  assert.deepEqual(technicalPlanRepairIssues({
    implementationPlan: repaired.handoff.implementationPlan,
    implementationPlanSchema,
    requiredAcceptanceCriteria: criteria,
    registry,
    request: brief.objective,
  }), []);
});

test("Technical Refinement mechanical normalization stays fail-closed when owner or validation authority is ambiguous", async () => {
  const registry = await loadAgentCatalog(root);
  const criterion = {
    id: "CLV2-AMB",
    source: "modernization/04-ACCEPTANCE.md",
    statement: "Shared package behavior is implemented.",
    blocking: true,
    verification: "Manual evidence review after implementation.",
    proofStage: "implementation",
  };
  const sourcePlan = {
    schemaVersion: 1,
    revision: 1,
    acceptanceCriteria: [criterion],
    workItems: [{
      id: "W-ambiguous",
      ownerAgentId: "unknown-implementer",
      objective: "Implement shared package behavior.",
      dependencies: [],
      ownedPaths: ["packages/shared/**"],
      acceptanceCriteria: [criterion.id],
      validation: ["Shared package verification must pass"],
      validationExecutionScope: "workspace",
      complexity: "medium",
      estimatedFiles: 2,
      contractChange: false,
      migration: false,
    }],
  };
  const normalized = normalizeTechnicalPlanMechanics({ implementationPlan: sourcePlan, requiredAcceptanceCriteria: [criterion], registry });
  assert.equal(normalized.plan.workItems[0].ownerAgentId, "unknown-implementer", "multiple eligible shared owners must not be guessed");
  assert.deepEqual(normalized.plan.workItems[0].validation, sourcePlan.workItems[0].validation, "prose cannot be replaced when no executable authority exists");
});

test("Technical Refinement acceptance-coverage repair can only map criteria onto existing work items", async () => {
  const registry = await loadAgentCatalog(root);
  const implementationPlanSchema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/implementation-plan.schema.json"), "utf8"));
  const criteria = ["CLV2-01", "CLV2-05", "CLV2-11"].map((id, index) => ({
    id,
    source: "modernization/04-ACCEPTANCE.md",
    statement: `Criterion ${id} is implemented by the bounded helper slice.`,
    blocking: true,
    verification: "npm test",
    proofStage: "implementation",
  }));
  const sourcePlan = {
    schemaVersion: 1,
    revision: 1,
    acceptanceCriteria: criteria,
    workItems: [{
      id: "W06-ranker",
      ownerAgentId: "coding-pro",
      objective: "Implement the bounded ranker behavior and its existing tests.",
      dependencies: [],
      ownedPaths: ["src/ranker.mjs", "test/ranker.test.mjs"],
      acceptanceCriteria: ["CLV2-01"],
      validation: ["npm test"],
      validationExecutionScope: "workspace",
      complexity: "medium",
      estimatedFiles: 2,
      contractChange: false,
      migration: false,
    }],
  };
  const issues = technicalPlanRepairIssues({
    implementationPlan: sourcePlan,
    implementationPlanSchema,
    requiredAcceptanceCriteria: criteria,
    registry,
    request: "Implement the bounded Learning V2 ranker slice.",
  });
  assert.deepEqual(issues.sort(), [
    "implementation_plan_uncovered_criterion:CLV2-05",
    "implementation_plan_uncovered_criterion:CLV2-11",
  ]);
  assert.equal(classifyTechnicalPlanRepairScope(issues).scope, "acceptance-coverage-only");

  const handoff = {
    status: "complete",
    implementationPlan: structuredClone(sourcePlan),
    sddReview: {
      role: "technical-lead",
      stage: "technical-refinement",
      decision: "changes_requested",
      reviewedRevision: 1,
      nextRole: "technical-lead",
      requiredDeltas: ["Map CLV2-05 and CLV2-11 onto the existing implementation work that already satisfies them."],
    },
    findings: [],
    auxiliaryInvocations: [],
    metrics: {},
  };
  const brief = {
    runId: "run-coverage-repair",
    taskId: "run-coverage-repair:technical-refinement",
    agentId: "technical-lead",
    objective: "Implement the bounded Learning V2 ranker slice.",
    upstreamAcceptanceCriteria: criteria,
    sdd: { stage: "technical-refinement" },
    modelRouting: { attempt: 1 },
  };
  let observedSchema = null;
  let observedPrompt = "";
  const structuredRunner = async ({ schema, prompt }) => {
    observedSchema = schema;
    observedPrompt = prompt;
    return {
      value: {
        assignments: [
          { criterionId: "CLV2-05", workItemId: "W06-ranker" },
          { criterionId: "CLV2-11", workItemId: "W06-ranker" },
        ],
      },
      info: { tokens: { input: 12, output: 4 } },
      sessionId: "ses-coverage-repair",
      attempts: 1,
      failures: [],
    };
  };
  const repaired = await repairImplementationPlanFromReview({
    workspace: root,
    brief,
    handoff,
    implementationPlanSchema,
    registry,
    model: "openai/gpt-5.6-luna",
    structuredRunner,
    repairPass: 1,
  });

  assert.equal(observedSchema.properties.assignments.items.properties.workItemId.enum.length, 1);
  assert.match(observedPrompt, /CANNOT create or delete work items/);
  assert.match(observedPrompt, /Acceptance coverage does not imply path ownership/);
  assert.equal(repaired.repairMutationScope, "acceptance-coverage-only");
  assert.equal(repaired.handoff.implementationPlan.revision, 2);
  assert.deepEqual(repaired.handoff.implementationPlan.workItems[0].ownerAgentId, sourcePlan.workItems[0].ownerAgentId);
  assert.deepEqual(repaired.handoff.implementationPlan.workItems[0].ownedPaths, sourcePlan.workItems[0].ownedPaths);
  assert.deepEqual(repaired.handoff.implementationPlan.workItems[0].dependencies, sourcePlan.workItems[0].dependencies);
  assert.equal(repaired.handoff.implementationPlan.workItems.length, sourcePlan.workItems.length);
  assert.deepEqual(repaired.handoff.implementationPlan.workItems[0].acceptanceCriteria.sort(), ["CLV2-01", "CLV2-05", "CLV2-11"]);
  assert.deepEqual(technicalPlanRepairIssues({
    implementationPlan: repaired.handoff.implementationPlan,
    implementationPlanSchema,
    requiredAcceptanceCriteria: criteria,
    registry,
    request: brief.objective,
  }), []);
});

test("Technical Refinement semantic repair reports real mutation scope and evidence when deterministic preflight is already clean", async () => {
  const registry = await loadAgentCatalog(root);
  const implementationPlanSchema = JSON.parse(readFileSync(resolve(root, ".agents/schemas/implementation-plan.schema.json"), "utf8"));
  const criterion = {
    id: "CLV2-01",
    source: "modernization/04-ACCEPTANCE.md",
    statement: "The bounded ranker slice is implemented and verified.",
    blocking: true,
    verification: "npm test",
    proofStage: "implementation",
  };
  const sourcePlan = {
    schemaVersion: 1,
    revision: 1,
    acceptanceCriteria: [criterion],
    workItems: [{
      id: "W06-ranker",
      ownerAgentId: "coding-pro",
      objective: "Implement the bounded ranker behavior.",
      dependencies: [],
      ownedPaths: ["src/ranker.mjs", "test/ranker.test.mjs"],
      acceptanceCriteria: [criterion.id],
      validation: ["npm test"],
      validationExecutionScope: "workspace",
      complexity: "medium",
      estimatedFiles: 2,
      contractChange: false,
      migration: false,
    }],
  };
  assert.deepEqual(technicalPlanRepairIssues({
    implementationPlan: sourcePlan,
    implementationPlanSchema,
    requiredAcceptanceCriteria: [criterion],
    registry,
    request: "Implement the bounded Learning V2 ranker slice.",
  }), []);

  const handoff = {
    status: "complete",
    implementationPlan: structuredClone(sourcePlan),
    sddReview: {
      role: "technical-lead",
      stage: "technical-refinement",
      decision: "changes_requested",
      reviewedRevision: 1,
      nextRole: "technical-lead",
      requiredDeltas: ["Clarify that the ranker work item preserves the bounded contract during implementation."],
    },
    findings: [],
    auxiliaryInvocations: [],
    metrics: {},
  };
  const brief = {
    runId: "run-semantic-repair",
    taskId: "run-semantic-repair:technical-refinement",
    agentId: "technical-lead",
    objective: "Implement the bounded Learning V2 ranker slice.",
    upstreamAcceptanceCriteria: [criterion],
    sdd: { stage: "technical-refinement" },
    modelRouting: { attempt: 2 },
  };
  const structuredRunner = async () => ({
    value: {
      ...structuredClone(sourcePlan),
      revision: 2,
      workItems: [{
        ...structuredClone(sourcePlan.workItems[0]),
        objective: "Implement the bounded ranker behavior while preserving the bounded contract.",
      }],
    },
    info: { tokens: { input: 8, output: 3 } },
    sessionId: "ses-semantic-repair",
    attempts: 1,
    failures: [],
  });

  const repaired = await repairImplementationPlanFromReview({
    workspace: root,
    brief,
    handoff,
    implementationPlanSchema,
    registry,
    model: "openai/gpt-5.6-luna",
    structuredRunner,
    repairPass: 1,
  });

  assert.equal(repaired.repairMutationScope, "semantic-review");
  assert.deepEqual(repaired.repairEvidence, ["work-item-updated:W06-ranker:objective"]);
  assert.equal(repaired.handoff.findings.at(-1).repairMutationScope, "semantic-review");
  assert.deepEqual(repaired.handoff.findings.at(-1).repairEvidence, ["work-item-updated:W06-ranker:objective"]);
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

test("implementation missing-new reused paths fail closed but receive one bounded semantic retry classification", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "agent-harness-implementation-missing-new-reuse-"));
  try {
    const paths = ["src/format-initials.mjs", "test/format-initials.test.mjs"];
    const task = {
      taskId: "run-r9:implementation:wi-r9-format-initials",
      agentId: "coding-pro",
      role: "implementation",
      stage: "implementation",
      executionMode: "agent",
      estimatedFiles: 2,
      ownedPaths: ["src/format-initials.mjs", "test/format-initials.test.mjs"],
    };
    const handoff = { status: "complete", changedPaths: [], reusedPaths: paths, criterionResults: [], validation: [] };
    const disposition = await reconcileHandoffPathDisposition({
      workspace: { mode: "copy", path: tempRoot, baseline: new Map() },
      task,
      inspection: { changedPaths: [] },
      handoff,
      reusedPaths: handoff.reusedPaths,
    });

    assert.deepEqual(disposition.invalidReused, paths.map((path) => ({
      path,
      valid: false,
      reason: "missing_in_workspace_and_baseline",
    })));
    assert.equal(isRetryableImplementationReuseFailure({ task, handoff, invalidReused: disposition.invalidReused }), true);
    assert.equal(retryDispositionForFailure({ code: "handoff_reused_paths_invalid", retryable: true }), "true-retry-semantic");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("invalid reuse remains terminal outside the exact missing-new implementation case", () => {
  const task = { role: "implementation", stage: "implementation", executionMode: "agent" };
  const handoff = { status: "complete" };
  assert.equal(isRetryableImplementationReuseFailure({
    task,
    handoff,
    invalidReused: [{ path: "src/existing.mjs", reason: "missing_in_workspace" }],
  }), false);
  assert.equal(isRetryableImplementationReuseFailure({
    task,
    handoff,
    invalidReused: [{ path: "src/foreign.mjs", reason: "ownership_violation" }],
  }), false);
  assert.equal(isRetryableImplementationReuseFailure({
    task: { ...task, executionMode: "deterministic-reuse" },
    handoff,
    invalidReused: [{ path: "src/new.mjs", reason: "missing_in_workspace_and_baseline" }],
  }), false);
  assert.equal(retryDispositionForFailure({ code: "handoff_reused_paths_invalid", retryable: false }), "terminal");
});

test("implementation prompt forbids treating required new artifacts as reused outputs", () => {
  const source = readFileSync(resolve(root, "scripts/internal/opencode-task-executor.mjs"), "utf8");
  assert.match(source, /required owned artifact that did not exist before this attempt can NEVER be reused/);
  assert.match(source, /Create it physically and report it in changedPaths/);
});

test("bootstrap governance prompt forbids invented changed/reused artifact paths for zero-file reviews", () => {
  const source = readFileSync(resolve(root, "scripts/internal/opencode-task-executor.mjs"), "utf8");
  assert.match(source, /do not invent an architecture\/ADR\/review artifact path merely to populate changedPaths or reusedPaths/);
  assert.match(source, /if no pre-existing owned artifact was actually verified as output, reusedPaths must be \[\]/);
});
