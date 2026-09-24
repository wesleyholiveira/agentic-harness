import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { contractDigest, validateCommandSpec } from "../../packages/harness-contracts/src/project-descriptor.mjs";
import { projectDescriptorV2Digest } from "../../packages/harness-contracts/src/project-descriptor-v2.mjs";
import { executionPolicyV2Digest } from "../../packages/harness-contracts/src/execution-policy-v2.mjs";
import {
  dependencyFileSetDigest,
  dockerRunnerMaterializationIdentityDigest,
  dockerRunnerSourceBindingDigest,
  dockerRunnerSpecDigest,
} from "../../packages/harness-contracts/src/docker-runner-v2.mjs";
import { buildCommittedCommandSpecCatalog } from "../../packages/project-adapters/src/command-spec-catalog.mjs";
import { bindWorkspaceAuthorityInputs } from "../../packages/project-adapters/src/workspace-binding.mjs";
import {
  evaluateBehaviorAdmission,
  executeDockerBehaviorCommandV2,
  executeDockerBehaviorCommandV2Async,
} from "../../packages/project-adapters/src/behavior-executor-v2.mjs";
import {
  buildTechnicalPlanStructuredSchema,
  buildValidationCommandCatalog,
  technicalPlanRepairIssues,
} from "../../.agents/runtime/technical-plan-synthesis.mjs";
import { validationCommandId } from "../../.agents/runtime/validation-command.mjs";

const sha = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const SOURCE = "sha256:" + "a".repeat(64);
const IMAGE = "sha256:" + "b".repeat(64);

function runnerSpec(overrides = {}) {
  return {
    schemaVersion: "docker-runner-spec/v2",
    id: "verify-runner",
    kind: "docker-compose",
    dockerContext: "default",
    composeProject: "fixture",
    composeFiles: ["compose.yaml"],
    profiles: ["test"],
    service: "tests",
    purpose: "test",
    operation: "one-off",
    replica: null,
    containerCwd: "/workspace",
    user: "1000:1000",
    platform: "linux/amd64",
    buildTarget: "test",
    image: { mode: "pinned-reference", reference: "example.invalid/tool@sha256:" + "e".repeat(64) },
    dependencyFiles: ["package-lock.json"],
    ...overrides,
  };
}
function commandSpec(overrides = {}) {
  return {
    schemaVersion: "command-spec/v1",
    id: "verify.unit",
    moduleId: "root",
    runnerId: "verify-runner",
    phase: "behavior",
    executable: "node",
    argv: ["--version"],
    cwd: ".",
    envAllowlist: [],
    secretRefs: [],
    requiredCapabilities: ["language.node"],
    networkPolicy: "none",
    effects: ["read-only"],
    timeoutMs: 60_000,
    dependencyPolicy: "none",
    validationScope: "container",
    ...overrides,
  };
}
function descriptorV2({ runner = runnerSpec(), command = commandSpec() } = {}) {
  return {
    schemaVersion: "project-descriptor/v2",
    projectId: "project-a",
    repositoryId: "repo-a",
    policyRef: ".agent-harness/policy.json",
    modules: [{ id: "root", root: ".", languages: ["node"], requiredCapabilities: ["language.node"] }],
    evidenceRoots: ["docs"],
    protectedPaths: [".harness", ".env"],
    runners: [runner],
    commands: [command],
  };
}
function policyV2(descriptor) {
  const command = descriptor.commands[0], runner = descriptor.runners[0];
  return {
    schemaVersion: "execution-policy/v2",
    id: "engineering-v2",
    projectId: descriptor.projectId,
    descriptorDigest: projectDescriptorV2Digest(descriptor),
    grants: [{
      commandId: command.id,
      commandDigest: contractDigest(validateCommandSpec(command)),
      runnerSpecDigest: dockerRunnerSpecDigest(runner),
      allowedScopes: [command.validationScope],
      allowedNetworkPolicies: [command.networkPolicy],
      allowedEffects: [...command.effects],
      maxTimeoutMs: command.timeoutMs,
      allowSecrets: command.secretRefs.length > 0,
    }],
  };
}
function writeTree(root, values) {
  for (const [path, value] of Object.entries(values)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  }
}
function gitRepo(t, descriptor = descriptorV2(), policy = policyV2(descriptor)) {
  const root = mkdtempSync(join(tmpdir(), "command-spec-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const git = args => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
    stdio: ["ignore","pipe","pipe"],
  }).trim();
  git(["init"]);
  git(["config","user.name","Command Spec Test"]);
  git(["config","user.email","test@example.invalid"]);
  git(["config","core.autocrlf","false"]);
  git(["config","commit.gpgsign","false"]);
  writeTree(root, {
    ".agent-harness/project.json": JSON.stringify(descriptor),
    ".agent-harness/policy.json": JSON.stringify(policy),
    "compose.yaml": "services:\n  tests:\n    image: example.invalid/tool@sha256:" + "e".repeat(64) + "\n",
    "package-lock.json": "{\"lockfileVersion\":3}\n",
    "package.json": JSON.stringify({ packageManager: "npm@11.0.0", scripts: { test: "node --test", start: "node server.js" } }),
    "src/foo.js": "export const value = 1;\n",
  });
  git(["add","."]);
  git(["commit","-m","fixture"]);
  return { root, descriptor, policy, git };
}
function criterion() {
  return {
    id: "AC-1", source: "product-owner", statement: "Focused validation passes.",
    blocking: true, verification: "npm test", proofStage: "implementation",
  };
}
function registry() {
  const impl = {
    id: "coding", role: "developer", executionRole: "implementation", orchestrationRole: "specialist",
    primaryPaths: ["src/**"], sharedPaths: [], collaborativePaths: [], ownershipMode: "explicit-patterns",
  };
  const coord = {
    id: "main-orchestrator", role: "orchestrator", kind: "runtime", executionRole: "orchestration",
    orchestrationRole: "orchestrator", primaryPaths: [], sharedPaths: [], collaborativePaths: [],
  };
  return { agents: [impl, coord], byId: new Map([[impl.id,impl],[coord.id,coord]]) };
}
function plan(commandSpecIds = ["verify.unit"]) {
  return {
    schemaVersion: 1, revision: 1, coordinatorAgentId: "main-orchestrator",
    acceptanceCriteria: [criterion()],
    workItems: [{
      id: "w1", ownerAgentId: "coding", objective: "Implement scoped change.", dependencies: [],
      ownedPaths: ["src/foo.js"], acceptanceCriteria: ["AC-1"],
      validation: ["npm test"], validationCommandIds: [validationCommandId("npm test")],
      commandSpecIds, validationExecutionScope: "workspace", executionMode: "agent",
      complexity: "low", estimatedFiles: 1, contractChange: false, migration: false,
    }],
  };
}

test("non-Git legacy workspace has no committed CommandSpec authority", t => {
  const root = mkdtempSync(join(tmpdir(), "command-spec-no-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), "{}");
  const result = buildCommittedCommandSpecCatalog(root);
  assert.equal(result.status, "absent");
  assert.deepEqual(result.catalog, []);
});

test("committed descriptor exposes exact CommandSpec IDs to Technical Refinement", async t => {
  const f = gitRepo(t);
  const commandSpecs = buildCommittedCommandSpecCatalog(f.root);
  assert.equal(commandSpecs.status, "ok");
  assert.deepEqual(commandSpecs.catalog.map(item => item.id), ["verify.unit"]);
  const validationCatalog = await buildValidationCommandCatalog({
    workspace: f.root, brief: { validation: [], objective: "implement" }, requiredAcceptanceCriteria: [criterion()],
  });
  assert.deepEqual(validationCatalog.commandSpecCatalog.map(item => item.id), ["verify.unit"]);
  assert.equal(validationCatalog.commandSpecContext.sourceCommit, f.git(["rev-parse","HEAD"]));
});

test("isolated non-Git workspace keeps validation local but loads CommandSpec authority from committed source root", async t => {
  const f = gitRepo(t);
  const workspace = mkdtempSync(join(tmpdir(), "command-spec-copy-workspace-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeTree(workspace, {
    "package.json": JSON.stringify({
      packageManager: "npm@11.0.0",
      scripts: { test: "node --test", localonly: "node local.js" },
    }),
    "src/foo.js": "export const value = 2;\n",
  });

  const directWorkspaceCatalog = buildCommittedCommandSpecCatalog(workspace);
  assert.equal(directWorkspaceCatalog.status, "absent");

  const validationCatalog = await buildValidationCommandCatalog({
    workspace,
    committedSourceRoot: f.root,
    brief: { validation: [], objective: "implement" },
    requiredAcceptanceCriteria: [criterion()],
  });

  assert.ok(validationCatalog.some(entry => entry.command === "npm test"));
  assert.deepEqual(validationCatalog.commandSpecCatalog.map(item => item.id), ["verify.unit"]);
  assert.equal(validationCatalog.commandSpecContext.status, "ok");
  assert.equal(validationCatalog.commandSpecContext.sourceCommit, f.git(["rev-parse","HEAD"]));
  assert.equal(validationCatalog.commandSpecContext.configuration.repositoryRoot, f.root);
});

test("dynamic Technical Plan schema enumerates only committed CommandSpec IDs", async t => {
  const f = gitRepo(t);
  const validationCatalog = await buildValidationCommandCatalog({
    workspace: f.root, brief: { validation: [], objective: "implement" }, requiredAcceptanceCriteria: [criterion()],
  });
  const schema = JSON.parse(readFileSync(join(process.cwd(), ".agents/schemas/implementation-plan.schema.json"), "utf8"));
  const dynamic = buildTechnicalPlanStructuredSchema({
    implementationPlanSchema: schema, requiredAcceptanceCriteria: [criterion()],
    registry: registry(), validationCommandCatalog: validationCatalog,
  });
  assert.deepEqual(dynamic.properties.workItems.items.properties.commandSpecIds.items.enum, ["verify.unit"]);
});

test("unknown CommandSpec ID is a deterministic plan issue", async t => {
  const f = gitRepo(t);
  const validationCatalog = await buildValidationCommandCatalog({
    workspace: f.root, brief: { validation: [], objective: "implement" }, requiredAcceptanceCriteria: [criterion()],
  });
  const schema = JSON.parse(readFileSync(join(process.cwd(), ".agents/schemas/implementation-plan.schema.json"), "utf8"));
  const issues = technicalPlanRepairIssues({
    implementationPlan: plan(["invented.command"]), implementationPlanSchema: schema,
    requiredAcceptanceCriteria: [criterion()], registry: registry(), request: "implement",
    validationCommandCatalog: validationCatalog,
  });
  assert.ok(issues.some(issue => issue.includes("implementation_plan_command_spec_id_unauthorized:w1")));
});

function behaviorFixture(t, { runnerOverrides = {}, commandOverrides = {} } = {}) {
  const runner = runnerSpec(runnerOverrides);
  const command = commandSpec(commandOverrides);
  if (runner.id !== command.runnerId) command.runnerId = runner.id;
  const descriptor = descriptorV2({ runner, command });
  const policy = policyV2(descriptor);
  const root = mkdtempSync(join(tmpdir(), "behavior-executor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const values = {
    ".agent-harness/project.json": JSON.stringify(descriptor),
    ".agent-harness/policy.json": JSON.stringify(policy),
    "compose.yaml": "services: {}\n",
    "package-lock.json": "{\"lockfileVersion\":3}\n",
  };
  writeTree(root, values);
  const deps = [{ path: "package-lock.json", sha256: sha(values["package-lock.json"]) }];
  const binding = {
    schemaVersion: "docker-runner-source-binding/v1",
    runnerId: runner.id,
    runnerSpecDigest: dockerRunnerSpecDigest(runner),
    sourceCommit: "d".repeat(40),
    sourceObjectFormat: "sha1",
    sourceSnapshotSha256: SOURCE,
    composeFiles: [{ path: "compose.yaml", sha256: sha(values["compose.yaml"]) }],
    dependencyFiles: deps,
    dependencyLockSha256: dependencyFileSetDigest(deps),
    trustKind: "git-commit",
  };
  const configuration = {
    schemaVersion: "committed-project-configuration/v1",
    repositoryRoot: root,
    sourceCommit: binding.sourceCommit,
    sourceObjectFormat: "sha1",
    sourceSnapshotSha256: SOURCE,
    descriptorPath: ".agent-harness/project.json",
    descriptorSha256: sha(values[".agent-harness/project.json"]),
    policyPath: ".agent-harness/policy.json",
    policySha256: sha(values[".agent-harness/policy.json"]),
    descriptorDigest: projectDescriptorV2Digest(descriptor),
    policyDigest: executionPolicyV2Digest(policy),
    sourceTrustVerified: true,
    policyTrustVerified: true,
    trustKind: "git-commit-config",
    workingTreeChecked: false,
    workspaceBindingVerified: false,
    qualificationVerdict: null,
    descriptor,
    policy,
    runnerSourceBindings: [binding],
    commandEvaluations: {},
  };
  const workspaceBinding = bindWorkspaceAuthorityInputs(root, configuration);
  const materialization = {
    schemaVersion: "docker-runner-materialization/v1",
    runnerId: runner.id,
    runnerSpecDigest: dockerRunnerSpecDigest(runner),
    sourceBindingDigest: dockerRunnerSourceBindingDigest(binding, { spec: runner }),
    sourceSnapshotSha256: SOURCE,
    daemonId: "daemon:alpha",
    imageId: IMAGE,
    configPublicSha256: sha("config"),
    mountsSha256: sha("mounts"),
    platform: runner.platform,
    containerId: runner.operation === "exec" ? "c".repeat(64) : null,
    observedAt: new Date(0).toISOString(),
  };
  const materializationIdentityDigest = dockerRunnerMaterializationIdentityDigest(materialization, { spec: runner, sourceBinding: binding });
  const imageSourceAttestation = {
    schemaVersion: "docker-image-source-attestation/v1",
    attestationKind: "docker-image-labels-v1",
    runnerId: runner.id,
    runnerSpecDigest: dockerRunnerSpecDigest(runner),
    sourceBindingDigest: dockerRunnerSourceBindingDigest(binding, { spec: runner }),
    sourceSnapshotSha256: SOURCE,
    imageId: IMAGE,
    platform: runner.platform,
    materializationIdentityDigest,
    observedAt: "2026-09-20T00:00:00.000Z",
  };
  const executionFence = {
    schemaVersion: "task-execution-fence/v1",
    runId: "run-a",
    taskId: "task-a",
    attempt: 1,
    dispatchGeneration: 1,
    fencingToken: 1,
    leaseOwner: "worker-a",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    observedAt: "2026-09-20T00:00:00.000Z",
  };
  const toolchainReceipt = {
    schemaVersion: "docker-toolchain-receipt/v2",
    status: "TOOLCHAIN_VERIFIED",
    projectId: descriptor.projectId,
    commandId: command.id,
    runnerId: runner.id,
    sourceCommit: configuration.sourceCommit,
    sourceSnapshotSha256: SOURCE,
    workspaceBindingDigest: workspaceBinding.workspaceBindingDigest,
    runnerSpecDigest: dockerRunnerSpecDigest(runner),
    tools: [{ capability: "toolchain.node", executable: "node", version: "22.16.0", outputSha256: sha("v22.16.0") }],
    remoteCalls: 0,
    materializationIdentityDigest,
    containerId: materialization.containerId,
    imageId: IMAGE,
    trustVerified: true,
    qualificationVerdict: null,
  };
  return {
    root, runner, command, commandId: command.id, descriptor, policy, binding, configuration,
    workspaceBinding, materialization, imageSourceAttestation, executionFence, toolchainReceipt,
  };
}

test("missing commandId fails closed before behavior admission", t => {
  const f = behaviorFixture(t);
  const { commandId: _commandId, ...withoutCommandId } = f;
  const admission = evaluateBehaviorAdmission(withoutCommandId);
  assert.equal(admission.status, "HOLD");
  assert.ok(admission.reasons.includes("toolchain-readiness-required"));
  assert.ok(admission.reasons.includes("command-or-runner-missing"));
  assert.equal(admission.executableNow, false);
});

test("fully enforceable one-off read-only CommandSpec becomes behavior-authorized", t => {
  const f = behaviorFixture(t);
  const admission = evaluateBehaviorAdmission(f);
  assert.equal(admission.status, "BEHAVIOR_AUTHORIZED");
  assert.equal(admission.executableNow, true);
  assert.equal(admission.effectsEnforced, true);
  assert.equal(admission.networkEnforced, true);
  assert.equal(admission.secretsResolved, true);
});

for (const [name, options, reason] of [
  ["exec runner", { runnerOverrides: { operation: "exec", replica: 1, image: { mode: "running-service", reference: null } } }, "behavior-exec-runner-not-yet-enforceable"],
  ["workspace write", { commandOverrides: { effects: ["workspace-write"] } }, "behavior-effects-not-yet-enforceable"],
  ["service network", { commandOverrides: { networkPolicy: "service-only" } }, "behavior-network-policy-not-yet-enforceable"],
  ["secret refs", { commandOverrides: { secretRefs: ["secret/token"] } }, "behavior-secrets-not-yet-supported"],
  ["env allowlist", { commandOverrides: { envAllowlist: ["PUBLIC_FLAG"] } }, "behavior-env-not-yet-supported"],
  ["dependencies", { commandOverrides: { dependencyPolicy: "required" } }, "behavior-dependencies-not-yet-supported"],
]) test(`behavior admission HOLDs for ${name}`, t => {
  const f = behaviorFixture(t, options);
  const admission = evaluateBehaviorAdmission(f);
  assert.equal(admission.status, "HOLD");
  assert.ok(admission.reasons.includes(reason));
  assert.equal(admission.executableNow, false);
});

test("behavior executor uses immutable image and argv without shell or raw output", t => {
  const f = behaviorFixture(t);
  const calls = [];
  const execute = argv => {
    calls.push(argv);
    return { status: 0, stdout: "PRIVATE-OUTPUT\n", stderr: "" };
  };
  const receipt = executeDockerBehaviorCommandV2(f, {
    root: f.root,
    execute,
    workspaceMount: { type: "volume", source: "project_workspaces", subpath: "run/task--attempt-1" },
    reobserve: () => ({ status: "MATERIALIZED", materialization: { ...f.materialization, observedAt: new Date(1).toISOString() } }),
  });
  assert.equal(receipt.status, "BEHAVIOR_PASSED");
  assert.equal(receipt.executed, true);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.trustVerified, true);
  assert.ok(!JSON.stringify(receipt).includes("PRIVATE-OUTPUT"));
  const argv = calls[0];
  for (const [flag,value] of [["--network","none"],["--pull","never"],["--entrypoint","node"]]) {
    const index = argv.indexOf(flag); assert.equal(argv[index + 1], value);
  }
  assert.ok(argv.includes("--read-only"));
  assert.ok(argv.includes("--cap-drop"));
  const mountIndex = argv.indexOf("--mount");
  assert.equal(argv[mountIndex + 1], "type=volume,src=project_workspaces,dst=/workspace,readonly,volume-subpath=run/task--attempt-1");
  const workdirIndex = argv.indexOf("--workdir");
  assert.equal(argv[workdirIndex + 1], "/workspace");
  assert.ok(argv.includes(IMAGE));
  assert.ok(argv.includes("--version"));
  assert.ok(!argv.includes("sh"));
  assert.ok(!argv.includes("bash"));
});

test("async behavior executor requires a named container and projects abort as HOLD", async t => {
  const f = behaviorFixture(t);
  const missingName = await executeDockerBehaviorCommandV2Async(f, {
    root: f.root,
    execute: async () => ({ status: 0, stdout: "", stderr: "" }),
    reobserve: () => ({ status: "MATERIALIZED", materialization: { ...f.materialization, observedAt: new Date(1).toISOString() } }),
  });
  assert.equal(missingName.status, "HOLD");
  assert.equal(missingName.code, "behavior_container_name_required");
  assert.equal(missingName.executed, false);

  const calls = [];
  const receipt = await executeDockerBehaviorCommandV2Async(f, {
    root: f.root,
    containerName: "ah-beh-test-123",
    execute: async (argv, options) => {
      calls.push({ argv, options });
      return { status: null, stdout: "", stderr: "", error: { code: "ABORT_ERR" } };
    },
    reobserve: () => { throw new Error("abort_must_not_reobserve"); },
  });
  assert.equal(receipt.status, "HOLD");
  assert.equal(receipt.code, "behavior_execution_aborted");
  assert.equal(receipt.executed, true);
  const nameIndex = calls[0].argv.indexOf("--name");
  assert.equal(calls[0].argv[nameIndex + 1], "ah-beh-test-123");
  assert.equal(calls[0].options.containerName, "ah-beh-test-123");
});

test("behavior executor applies CommandSpec cwd below the mounted workspace root", t => {
  const f = behaviorFixture(t, { commandOverrides: { cwd: "packages/api" } });
  const calls = [];
  const receipt = executeDockerBehaviorCommandV2(f, {
    root: f.root,
    execute: argv => { calls.push(argv); return { status: 0, stdout: "", stderr: "" }; },
    workspaceMount: { type: "volume", source: "project_workspaces", subpath: "run/task--attempt-1" },
    reobserve: () => ({ status: "MATERIALIZED", materialization: { ...f.materialization, observedAt: new Date(1).toISOString() } }),
  });
  assert.equal(receipt.status, "BEHAVIOR_PASSED");
  const workdirIndex = calls[0].indexOf("--workdir");
  assert.equal(calls[0][workdirIndex + 1], "/workspace/packages/api");
});

test("behavior executor records a nonzero exit without converting it to authorization failure", t => {
  const f = behaviorFixture(t);
  const receipt = executeDockerBehaviorCommandV2(f, {
    root: f.root,
    execute: () => ({ status: 7, stdout: "", stderr: "failure" }),
    reobserve: () => ({ status: "MATERIALIZED", materialization: { ...f.materialization, observedAt: new Date(1).toISOString() } }),
  });
  assert.equal(receipt.status, "BEHAVIOR_FAILED");
  assert.equal(receipt.code, "behavior_failed");
  assert.equal(receipt.exitCode, 7);
  assert.equal(receipt.admission.status, "BEHAVIOR_AUTHORIZED");
});

test("behavior executor fails closed if materialization changes after execution", t => {
  const f = behaviorFixture(t);
  const receipt = executeDockerBehaviorCommandV2(f, {
    root: f.root,
    execute: () => ({ status: 0, stdout: "", stderr: "" }),
    reobserve: () => ({
      status: "MATERIALIZED",
      materialization: { ...f.materialization, imageId: "sha256:" + "f".repeat(64), observedAt: new Date(1).toISOString() },
    }),
  });
  assert.equal(receipt.status, "HOLD");
  assert.equal(receipt.code, "behavior_materialization_changed");
});

test("toolchain receipt from another workspace never authorizes behavior", t => {
  const f = behaviorFixture(t);
  const admission = evaluateBehaviorAdmission({
    ...f,
    toolchainReceipt: { ...f.toolchainReceipt, workspaceBindingDigest: sha("other") },
  });
  assert.equal(admission.status, "HOLD");
  assert.ok(admission.reasons.includes("toolchain-readiness-required"));
});
