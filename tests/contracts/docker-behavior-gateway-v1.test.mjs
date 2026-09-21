import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createDockerGatewayServer,
  discoverWorkspaceVolume,
  runBehaviorGateRequest,
  validateGatewayRequest,
  workspaceSubpath,
} from "../../apps/docker-gateway/server.mjs";
import {
  buildTechnicalPlanStructuredSchema,
  normalizeTechnicalPlanMechanics,
} from "../../.agents/runtime/technical-plan-synthesis.mjs";
import { validationCommandId } from "../../.agents/runtime/validation-command.mjs";

function authority(overrides = {}) {
  return {
    schemaVersion: "command-authority/v1",
    projectId: "project-a",
    repositoryId: "repo-a",
    sourceCommit: "a".repeat(40),
    sourceSnapshotSha256: "sha256:" + "b".repeat(64),
    descriptorDigest: "sha256:" + "c".repeat(64),
    policyDigest: "sha256:" + "d".repeat(64),
    ...overrides,
  };
}
function request(overrides = {}) {
  return {
    schemaVersion: "docker-behavior-gateway-request/v1",
    commandAuthority: authority(),
    commandSpecIds: ["verify.unit"],
    executionFence: {
      schemaVersion: "task-execution-fence/v1",
      runId: "run-a",
      taskId: "task-a",
      attempt: 1,
      dispatchGeneration: 2,
      fencingToken: 3,
      leaseOwner: "worker-a",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      observedAt: "2026-09-21T00:00:00.000Z",
    },
    workspacePath: "/workspace/agent-workspaces/run-a/task-a--attempt-1",
    ...overrides,
  };
}
function configuration() {
  const auth = authority();
  return {
    sourceCommit: auth.sourceCommit,
    sourceSnapshotSha256: auth.sourceSnapshotSha256,
    descriptorDigest: auth.descriptorDigest,
    policyDigest: auth.policyDigest,
    descriptor: {
      projectId: auth.projectId,
      repositoryId: auth.repositoryId,
      commands: [{ id: "verify.unit", runnerId: "runner-a" }],
      runners: [{ id: "runner-a" }],
    },
    runnerSourceBindings: [{ runnerId: "runner-a" }],
  };
}

test("gateway request is strict and rejects duplicate command IDs", () => {
  assert.equal(validateGatewayRequest(request()).commandSpecIds[0], "verify.unit");
  assert.throws(() => validateGatewayRequest({ ...request(), extra: true }), /docker_gateway_request_invalid/);
  assert.throws(() => validateGatewayRequest(request({ commandSpecIds: ["verify.unit","verify.unit"] })), /docker_gateway_command_ids_invalid/);
});

test("workspace subpath is bounded under the shared Runtime workspace root", () => {
  assert.equal(
    workspaceSubpath("/workspace/agent-workspaces", "/workspace/agent-workspaces/run/task"),
    "run/task",
  );
  assert.throws(
    () => workspaceSubpath("/workspace/agent-workspaces", "/workspace/repository"),
    /docker_gateway_workspace_outside_root/,
  );
  assert.throws(
    () => workspaceSubpath("/workspace/agent-workspaces", "/workspace/agent-workspaces"),
    /docker_gateway_workspace_outside_root/,
  );
});

test("gateway resolves exactly one Docker volume mounted at the workspace root", () => {
  const calls = [];
  const volume = discoverWorkspaceVolume({
    gatewayContainerId: "gateway-container",
    workspaceRoot: "/workspace/agent-workspaces",
    cwd: "/workspace/repository",
    executeDocker(argv) {
      calls.push(argv);
      return {
        status: 0,
        stdout: JSON.stringify([
          { Type: "bind", Source: "/private/repo", Destination: "/workspace/repository", RW: false },
          { Type: "volume", Name: "project_agent-harness-agent-workspaces", Destination: "/workspace/agent-workspaces", RW: false },
        ]),
        stderr: "",
      };
    },
  });
  assert.equal(volume, "project_agent-harness-agent-workspaces");
  assert.deepEqual(calls[0], ["container","inspect","--format","{{json .Mounts}}","gateway-container"]);
});

test("command authority mismatch stops before workspace or Docker activity", async () => {
  let bound = 0, docker = 0;
  const result = await runBehaviorGateRequest(request({
    commandAuthority: authority({ descriptorDigest: "sha256:" + "e".repeat(64) }),
  }), {
    projectRoot: "/workspace/repository",
    workspaceRoot: "/workspace/agent-workspaces",
    loadConfiguration: () => configuration(),
    bindWorkspace: () => { bound++; throw new Error("should-not-bind"); },
    executeDocker: () => { docker++; throw new Error("should-not-docker"); },
  });
  assert.equal(result.status, "HOLD");
  assert.equal(result.code, "docker_gateway_command_authority_mismatch");
  assert.equal(bound, 0);
  assert.equal(docker, 0);
});

test("gateway orchestrates the admitted command with a read-only task-volume subpath", async () => {
  const observed = {};
  const result = await runBehaviorGateRequest(request(), {
    projectRoot: "/workspace/repository",
    workspaceRoot: "/workspace/agent-workspaces",
    loadConfiguration: () => configuration(),
    bindWorkspace: () => ({ status: "AUTHORITY_INPUTS_BOUND", workspaceBindingDigest: "sha256:" + "f".repeat(64) }),
    volumeResolver: () => "project_agent-harness-agent-workspaces",
    materialize: ({ spec, sourceBinding }) => {
      observed.spec = spec; observed.sourceBinding = sourceBinding;
      return { status: "MATERIALIZED", materialization: { identity: "m" } };
    },
    attestImage: ({ materialization }) => {
      assert.deepEqual(materialization, { identity: "m" });
      return { status: "ATTESTED", attestation: { identity: "a" } };
    },
    probeToolchain: input => {
      assert.equal(input.commandId, "verify.unit");
      return { status: "TOOLCHAIN_VERIFIED", trustVerified: true };
    },
    executeBehavior: (input, options) => {
      observed.behaviorInput = input;
      observed.behaviorOptions = options;
      return { status: "BEHAVIOR_PASSED", code: "behavior_passed", executed: true };
    },
  });
  assert.equal(result.status, "PASSED");
  assert.equal(result.receipts.length, 1);
  assert.deepEqual(observed.behaviorOptions.workspaceMount, {
    type: "volume",
    source: "project_agent-harness-agent-workspaces",
    subpath: "run-a/task-a--attempt-1",
  });
  assert.equal(observed.behaviorInput.executionFence.fencingToken, 3);
});

test("gateway returns FAILED for a behavior failure without continuing", async () => {
  const result = await runBehaviorGateRequest(request(), {
    projectRoot: "/workspace/repository",
    workspaceRoot: "/workspace/agent-workspaces",
    loadConfiguration: () => configuration(),
    bindWorkspace: () => ({ status: "AUTHORITY_INPUTS_BOUND", workspaceBindingDigest: "sha256:" + "f".repeat(64) }),
    volumeResolver: () => "workspace-volume",
    materialize: () => ({ status: "MATERIALIZED", materialization: {} }),
    attestImage: () => ({ status: "ATTESTED", attestation: {} }),
    probeToolchain: () => ({ status: "TOOLCHAIN_VERIFIED" }),
    executeBehavior: () => ({ status: "BEHAVIOR_FAILED", code: "behavior_failed", executed: true, exitCode: 9 }),
  });
  assert.equal(result.status, "FAILED");
  assert.equal(result.code, "behavior_failed");
  assert.equal(result.receipts[0].exitCode, 9);
});

test("gateway server refuses short/empty shared tokens", () => {
  assert.throws(() => createDockerGatewayServer({ token: "" }), /docker_gateway_token_required/);
  assert.throws(() => createDockerGatewayServer({ token: "short" }), /docker_gateway_token_required/);
});

test("Compose exposes Docker socket only to the isolated behavior-gateway profile", () => {
  const compose = readFileSync(join(process.cwd(), "compose.yaml"), "utf8");
  const gatewayStart = compose.indexOf("  docker-behavior-gateway:");
  const workerStart = compose.indexOf("  agent-runtime-worker:");
  assert.ok(gatewayStart >= 0 && workerStart > gatewayStart);
  const gatewayBlock = compose.slice(gatewayStart, workerStart);
  const workerBlock = compose.slice(workerStart, compose.indexOf("\nvolumes:", workerStart));
  assert.match(gatewayBlock, /profiles: \[behavior-gateway\]/u);
  assert.match(gatewayBlock, /source: \/var\/run\/docker\.sock/u);
  assert.match(gatewayBlock, /read_only: true/u);
  assert.match(gatewayBlock, /cap_drop: \[ALL\]/u);
  assert.ok(!gatewayBlock.includes("ports:"));
  assert.ok(!workerBlock.includes("/var/run/docker.sock"));
  assert.ok(!workerBlock.includes("AGENT_HARNESS_DOCKER_GATEWAY_TOKEN"));
});

function registry() {
  const impl = {
    id:"coding", role:"developer", executionRole:"implementation", orchestrationRole:"specialist",
    primaryPaths:["src/**"], sharedPaths:[], collaborativePaths:[], ownershipMode:"explicit-patterns",
  };
  const coord = {
    id:"main-orchestrator", role:"orchestrator", kind:"runtime", executionRole:"orchestration",
    orchestrationRole:"orchestrator", primaryPaths:[], sharedPaths:[], collaborativePaths:[],
  };
  return { agents:[impl,coord], byId:new Map([[impl.id,impl],[coord.id,coord]]) };
}
function criterion() {
  return {
    id:"AC-1", source:"product-owner", statement:"Focused behavior passes.",
    blocking:true, verification:"npm test", proofStage:"implementation",
  };
}
function catalog() {
  const list=[{ id:validationCommandId("npm test"), command:"npm test", source:"task-brief.validation" }];
  Object.defineProperty(list,"commandSpecCatalog",{ value:[{id:"verify.unit",source:"committed-project-descriptor"}] });
  Object.defineProperty(list,"commandSpecContext",{
    value:{
      status:"ok",
      sourceCommit:authority().sourceCommit,
      sourceSnapshotSha256:authority().sourceSnapshotSha256,
      descriptorDigest:authority().descriptorDigest,
      policyDigest:authority().policyDigest,
      configuration:{ descriptor:{projectId:"project-a",repositoryId:"repo-a"} },
    },
  });
  return list;
}
function plan(commandAuthority = null) {
  return {
    schemaVersion:1, revision:1, coordinatorAgentId:"main-orchestrator",
    ...(commandAuthority ? {commandAuthority} : {}),
    acceptanceCriteria:[criterion()],
    workItems:[{
      id:"w1", ownerAgentId:"coding", objective:"Implement.", dependencies:[], ownedPaths:["src/foo.js"],
      acceptanceCriteria:["AC-1"], validation:["npm test"], validationCommandIds:[validationCommandId("npm test")],
      commandSpecIds:["verify.unit"], validationExecutionScope:"workspace", executionMode:"agent",
      complexity:"low", estimatedFiles:1, contractChange:false, migration:false,
    }],
  };
}

test("Technical Plan mechanically binds commandAuthority to the committed catalog", () => {
  const result = normalizeTechnicalPlanMechanics({
    implementationPlan: plan(),
    requiredAcceptanceCriteria:[criterion()],
    registry:registry(),
    validationCommandCatalog:catalog(),
  });
  assert.deepEqual(result.plan.commandAuthority, authority());
  assert.ok(result.evidence.includes("command-authority-canonicalized"));
});

test("dynamic Technical Plan schema makes committed commandAuthority a const", () => {
  const schema=JSON.parse(readFileSync(join(process.cwd(),".agents/schemas/implementation-plan.schema.json"),"utf8"));
  const dynamic=buildTechnicalPlanStructuredSchema({
    implementationPlanSchema:schema,
    requiredAcceptanceCriteria:[criterion()],
    registry:registry(),
    validationCommandCatalog:catalog(),
  });
  assert.deepEqual(dynamic.properties.commandAuthority.const, authority());
});
