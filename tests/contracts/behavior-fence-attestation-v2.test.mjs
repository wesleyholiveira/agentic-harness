import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
import {
  dockerImageSourceAttestationIdentityDigest,
  validateDockerImageSourceAttestation,
} from "../../packages/harness-contracts/src/image-source-attestation.mjs";
import {
  taskExecutionFenceIdentityDigest,
  validateActiveTaskExecutionFence,
} from "../../packages/harness-contracts/src/execution-fence.mjs";
import { bindWorkspaceAuthorityInputs } from "../../packages/project-adapters/src/workspace-binding.mjs";
import { probeDockerImageSourceAttestation } from "../../packages/project-adapters/src/docker-image-attestation.mjs";
import { evaluateBehaviorAdmission } from "../../packages/project-adapters/src/behavior-executor-v2.mjs";
import {
  executeBehaviorUnderTaskFence,
  observeActiveTaskExecutionFence,
} from "../../.agents/runtime/behavior-fence.mjs";

const sha = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const SOURCE = "sha256:" + "a".repeat(64);
const IMAGE = "sha256:" + "b".repeat(64);

function runner() {
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
    image: { mode: "source-attested-build", reference: null },
    dependencyFiles: ["package-lock.json"],
  };
}
function command() {
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
  };
}
function fixture(t) {
  const spec = runner();
  const cmd = command();
  const descriptor = {
    schemaVersion: "project-descriptor/v2",
    projectId: "project-a",
    repositoryId: "repo-a",
    policyRef: ".agent-harness/policy.json",
    modules: [{ id: "root", root: ".", languages: ["node"], requiredCapabilities: ["language.node"] }],
    evidenceRoots: ["docs"],
    protectedPaths: [".harness", ".env"],
    runners: [spec],
    commands: [cmd],
  };
  const policy = {
    schemaVersion: "execution-policy/v2",
    id: "engineering-v2",
    projectId: descriptor.projectId,
    descriptorDigest: projectDescriptorV2Digest(descriptor),
    grants: [{
      commandId: cmd.id,
      commandDigest: contractDigest(validateCommandSpec(cmd)),
      runnerSpecDigest: dockerRunnerSpecDigest(spec),
      allowedScopes: [cmd.validationScope],
      allowedNetworkPolicies: [cmd.networkPolicy],
      allowedEffects: [...cmd.effects],
      maxTimeoutMs: cmd.timeoutMs,
      allowSecrets: false,
    }],
  };
  const root = mkdtempSync(join(tmpdir(), "wave08-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const values = {
    ".agent-harness/project.json": JSON.stringify(descriptor),
    ".agent-harness/policy.json": JSON.stringify(policy),
    "compose.yaml": "services: {}\n",
    "package-lock.json": "{\"lockfileVersion\":3}\n",
  };
  for (const [path, value] of Object.entries(values)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  }
  const deps = [{ path: "package-lock.json", sha256: sha(values["package-lock.json"]) }];
  const sourceBinding = {
    schemaVersion: "docker-runner-source-binding/v1",
    runnerId: spec.id,
    runnerSpecDigest: dockerRunnerSpecDigest(spec),
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
    sourceCommit: sourceBinding.sourceCommit,
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
    runnerSourceBindings: [sourceBinding],
    commandEvaluations: {},
  };
  const workspaceBinding = bindWorkspaceAuthorityInputs(root, configuration);
  const materialization = {
    schemaVersion: "docker-runner-materialization/v1",
    runnerId: spec.id,
    runnerSpecDigest: dockerRunnerSpecDigest(spec),
    sourceBindingDigest: dockerRunnerSourceBindingDigest(sourceBinding, { spec }),
    sourceSnapshotSha256: SOURCE,
    daemonId: "daemon:alpha",
    imageId: IMAGE,
    configPublicSha256: sha("config"),
    mountsSha256: sha("mounts"),
    platform: spec.platform,
    containerId: null,
    observedAt: "2026-09-20T00:00:00.000Z",
  };
  const materializationIdentityDigest = dockerRunnerMaterializationIdentityDigest(materialization, { spec, sourceBinding });
  const toolchainReceipt = {
    schemaVersion: "docker-toolchain-receipt/v2",
    status: "TOOLCHAIN_VERIFIED",
    projectId: descriptor.projectId,
    commandId: cmd.id,
    runnerId: spec.id,
    sourceCommit: configuration.sourceCommit,
    sourceSnapshotSha256: SOURCE,
    workspaceBindingDigest: workspaceBinding.workspaceBindingDigest,
    runnerSpecDigest: dockerRunnerSpecDigest(spec),
    tools: [{ capability: "toolchain.node", executable: "node", version: "22.16.0", outputSha256: sha("v22.16.0") }],
    remoteCalls: 0,
    materializationIdentityDigest,
    containerId: null,
    imageId: IMAGE,
    trustVerified: true,
    qualificationVerdict: null,
  };
  const imageSourceAttestation = {
    schemaVersion: "docker-image-source-attestation/v1",
    attestationKind: "docker-image-labels-v1",
    runnerId: spec.id,
    runnerSpecDigest: dockerRunnerSpecDigest(spec),
    sourceBindingDigest: dockerRunnerSourceBindingDigest(sourceBinding, { spec }),
    sourceSnapshotSha256: SOURCE,
    imageId: IMAGE,
    platform: spec.platform,
    materializationIdentityDigest,
    observedAt: "2026-09-20T00:00:00.000Z",
  };
  const executionFence = {
    schemaVersion: "task-execution-fence/v1",
    runId: "run-a",
    taskId: "task-a",
    attempt: 1,
    dispatchGeneration: 2,
    fencingToken: 3,
    leaseOwner: "worker-a",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    observedAt: "2026-09-20T00:00:00.000Z",
  };
  return {
    root, spec, cmd, configuration, sourceBinding, workspaceBinding, materialization,
    materializationIdentityDigest, toolchainReceipt, imageSourceAttestation, executionFence,
    commandId: cmd.id,
  };
}

test("valid image/source attestation matches source binding and materialization", t => {
  const f = fixture(t);
  const checked = validateDockerImageSourceAttestation(f.imageSourceAttestation, {
    spec: f.spec, sourceBinding: f.sourceBinding, materialization: f.materialization,
  });
  assert.equal(checked.imageId, IMAGE);
  assert.match(dockerImageSourceAttestationIdentityDigest(checked, {
    spec: f.spec, sourceBinding: f.sourceBinding, materialization: f.materialization,
  }), /^sha256:/u);
});

test("image attestation rejects stale source or different materialization", t => {
  const f = fixture(t);
  assert.throws(() => validateDockerImageSourceAttestation({
    ...f.imageSourceAttestation,
    sourceSnapshotSha256: sha("stale"),
  }, { spec: f.spec, sourceBinding: f.sourceBinding, materialization: f.materialization }), /docker_image_attestation_mismatch/);
  assert.throws(() => validateDockerImageSourceAttestation({
    ...f.imageSourceAttestation,
    imageId: sha("other-image"),
  }, { spec: f.spec, sourceBinding: f.sourceBinding, materialization: f.materialization }), /docker_image_attestation_mismatch/);
});

test("source-attested image probe binds the post-commit image to the three authority labels", t => {
  const f = fixture(t);
  const calls = [];
  const execute = argv => {
    calls.push(argv);
    return {
      status: 0,
      stdout: JSON.stringify({
        id: IMAGE,
        os: "linux",
        architecture: "amd64",
        sourceSnapshotSha256: SOURCE,
        runnerSpecDigest: dockerRunnerSpecDigest(f.spec),
        sourceBindingDigest: dockerRunnerSourceBindingDigest(f.sourceBinding, { spec: f.spec }),
      }),
      stderr: "",
    };
  };
  const result = probeDockerImageSourceAttestation({
    spec: f.spec, sourceBinding: f.sourceBinding, materialization: f.materialization,
  }, { root: f.root, execute });
  assert.equal(result.status, "ATTESTED");
  const format = calls[0][calls[0].indexOf("--format") + 1];
  assert.ok(format.includes("org.agentic-harness.source-snapshot-sha256"));
  assert.ok(format.includes("org.agentic-harness.runner-spec-digest"));
  assert.ok(format.includes("org.agentic-harness.source-binding-digest"));
  assert.ok(!format.includes("\\\"Variant\\\""));
});

test("Docker image attestation probe fails closed on missing/mismatched labels without raw output", t => {
  const f = fixture(t);
  const result = probeDockerImageSourceAttestation({
    spec: f.spec, sourceBinding: f.sourceBinding, materialization: f.materialization,
  }, {
    root: f.root,
    execute: () => ({
      status: 0,
      stdout: JSON.stringify({
        id: IMAGE, os: "linux", architecture: "amd64",
        sourceSnapshotSha256: sha("PRIVATE"),
        runnerSpecDigest: dockerRunnerSpecDigest(f.spec),
        sourceBindingDigest: dockerRunnerSourceBindingDigest(f.sourceBinding, { spec: f.spec }),
      }),
      stderr: "PRIVATE",
    }),
  });
  assert.equal(result.status, "HOLD");
  assert.equal(result.code, "docker_image_source_labels_mismatch");
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});

test("behavior admission requires both source-attested image and active execution fence", t => {
  const f = fixture(t);
  const ok = evaluateBehaviorAdmission(f);
  assert.equal(ok.status, "BEHAVIOR_AUTHORIZED");

  const noAttestation = evaluateBehaviorAdmission({ ...f, imageSourceAttestation: null });
  assert.equal(noAttestation.status, "HOLD");
  assert.ok(noAttestation.reasons.includes("image-source-attestation-invalid"));

  const expired = evaluateBehaviorAdmission({
    ...f,
    executionFence: { ...f.executionFence, leaseExpiresAt: "2020-01-01T00:00:00.000Z" },
  });
  assert.equal(expired.status, "HOLD");
  assert.ok(expired.reasons.includes("task-execution-fence-invalid"));
});

test("fence identity is stable across heartbeat expiry extension but changes with fencing token", () => {
  const fence = {
    schemaVersion: "task-execution-fence/v1",
    runId: "run-a", taskId: "task-a", attempt: 1, dispatchGeneration: 2, fencingToken: 3,
    leaseOwner: "worker-a", leaseExpiresAt: "2099-01-01T00:00:00.000Z", observedAt: "2026-09-20T00:00:00.000Z",
  };
  validateActiveTaskExecutionFence(fence, { now: new Date("2026-09-20T01:00:00.000Z") });
  const a = taskExecutionFenceIdentityDigest(fence);
  const b = taskExecutionFenceIdentityDigest({ ...fence, leaseExpiresAt: "2099-02-01T00:00:00.000Z", observedAt: "2026-09-20T02:00:00.000Z" });
  assert.equal(a, b);
  assert.notEqual(a, taskExecutionFenceIdentityDigest({ ...fence, fencingToken: 4 }));
});

function activeRow(overrides = {}) {
  return {
    run_id: "run-a",
    task_id: "task-a",
    status: "running",
    attempt: 1,
    dispatch_generation: 2,
    fencing_token: 3,
    lease_owner: "worker-a",
    lease_expires_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("Runtime observes only the exact active task lease/fence", async () => {
  const store = { getTask: async () => activeRow() };
  const result = await observeActiveTaskExecutionFence({
    store, runId: "run-a", taskId: "task-a", attempt: 1, dispatchGeneration: 2, fencingToken: 3,
    now: new Date("2026-09-20T00:00:00.000Z"),
  });
  assert.equal(result.status, "ACTIVE");

  const stale = await observeActiveTaskExecutionFence({
    store: { getTask: async () => activeRow({ fencing_token: 4 }) },
    runId: "run-a", taskId: "task-a", attempt: 1, dispatchGeneration: 2, fencingToken: 3,
    now: new Date("2026-09-20T00:00:00.000Z"),
  });
  assert.equal(stale.status, "HOLD");
  assert.equal(stale.code, "task_execution_fence_identity_mismatch");
});

test("fenced behavior wrapper never executes when the pre-fence is inactive", async () => {
  let calls = 0;
  const result = await executeBehaviorUnderTaskFence({
    store: { getTask: async () => activeRow({ lease_expires_at: "2020-01-01T00:00:00.000Z" }) },
    identity: { runId: "run-a", taskId: "task-a", attempt: 1, dispatchGeneration: 2, fencingToken: 3 },
    now: () => new Date("2026-09-20T00:00:00.000Z"),
    executeBehavior: async () => { calls++; return { status: "BEHAVIOR_PASSED", code: "behavior_passed", executed: true }; },
  });
  assert.equal(result.status, "HOLD");
  assert.equal(result.code, "behavior_fence_not_active");
  assert.equal(calls, 0);
});

test("fenced behavior wrapper detects lease/fence replacement after execution", async () => {
  let reads = 0;
  const result = await executeBehaviorUnderTaskFence({
    store: { getTask: async () => (++reads === 1 ? activeRow() : activeRow({ fencing_token: 4 })) },
    identity: { runId: "run-a", taskId: "task-a", attempt: 1, dispatchGeneration: 2, fencingToken: 3 },
    now: () => new Date("2026-09-20T00:00:00.000Z"),
    executeBehavior: async ({ executionFence }) => {
      assert.equal(executionFence.fencingToken, 3);
      return { status: "BEHAVIOR_PASSED", code: "behavior_passed", executed: true };
    },
  });
  assert.equal(result.status, "HOLD");
  assert.equal(result.code, "behavior_fence_lost_after_execution");
  assert.equal(result.executed, true);
});

test("fenced behavior wrapper accepts heartbeat lease extension with unchanged fence identity", async () => {
  let reads = 0;
  const result = await executeBehaviorUnderTaskFence({
    store: {
      getTask: async () => (++reads === 1
        ? activeRow({ lease_expires_at: "2099-01-01T00:00:00.000Z" })
        : activeRow({ lease_expires_at: "2099-02-01T00:00:00.000Z" })),
    },
    identity: { runId: "run-a", taskId: "task-a", attempt: 1, dispatchGeneration: 2, fencingToken: 3 },
    now: () => new Date("2026-09-20T00:00:00.000Z"),
    executeBehavior: async ({ executionFence }) => ({
      status: "BEHAVIOR_PASSED", code: "behavior_passed", executed: true,
      executionFenceIdentityDigest: taskExecutionFenceIdentityDigest(executionFence),
    }),
  });
  assert.equal(result.status, "BEHAVIOR_PASSED");
  assert.equal(result.fenceVerified, true);
  assert.equal(result.before.fenceIdentityDigest, result.after.fenceIdentityDigest);
});
