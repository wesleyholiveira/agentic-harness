#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { gatewayCapabilityProof } from "../../apps/docker-gateway/fence-store.mjs";
import { behaviorContainerName } from "../../apps/docker-gateway/server.mjs";
import {
  QUALIFICATION_BEHAVIOR_COMMAND_ID,
  QUALIFICATION_BEHAVIOR_DELAY_COMMAND_ID,
  materializeFixture,
} from "./lib/fixture.mjs";
import { ProcessRunner, terminateProcessTree } from "./lib/process.mjs";
import { buildSourceAttestedQualificationImage } from "./lib/source-attested-behavior.mjs";
import {
  commandAuthorityFromConfiguration,
  parseDockerRuntimeVersion,
  sqlLiteral,
} from "./wave10-live-preflight.mjs";
import {
  allocatePort,
  ensureDir,
  nativeRealpath,
  randomId,
  sleep,
  waitFor,
  writeJson,
} from "./lib/util.mjs";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const out = { output: null, runId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") out.output = argv[++index];
    else if (arg === "--run-id") out.runId = argv[++index];
    else throw new Error(`wave10_fault_preflight_unknown_argument:${arg}`);
  }
  return out;
}

function gitText(runner, root, args, label) {
  return runner.run("git", ["-C", root, ...args], { label }).stdout.trim();
}

function gatewayHealthScript() {
  return [
    "fetch('http://127.0.0.1:8792/health')",
    ".then(async response=>{if(response.status!==200)process.exit(2);process.stdout.write(await response.text());})",
    ".catch(()=>process.exit(3));",
  ].join("");
}

export function gatewayFaultClientScript() {
  return [
    "let input='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',chunk=>input+=chunk);",
    "process.stdin.on('end',async()=>{",
    "try{",
    "const request=JSON.parse(input);",
    "const response=await fetch('http://docker-behavior-gateway:8792/v1/behavior',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});",
    "const body=await response.json();",
    "process.stdout.write(JSON.stringify({kind:'http',httpStatus:response.status,body}));",
    "}catch(error){",
    "process.stdout.write(JSON.stringify({kind:'transport',code:error?.cause?.code??null,message:String(error?.message??error)}));",
    "process.exitCode=2;",
    "}",
    "});",
  ].join("");
}

function safeFailure(error) {
  return {
    message: String(error?.message ?? error),
    code: error?.code ?? null,
    evidence: error?.evidence ?? null,
  };
}

function parseClientCompletion(completion) {
  if (completion.captureOverflow) throw new Error("wave10_fault_client_output_overflow");
  const text = String(completion.stdout ?? "").trim();
  if (!text) {
    const error = new Error("wave10_fault_client_output_empty");
    error.evidence = { exitCode: completion.exitCode, stderr: String(completion.stderr ?? "").slice(0, 512) };
    throw error;
  }
  try {
    return { ...JSON.parse(text), exitCode: completion.exitCode };
  } catch {
    const error = new Error("wave10_fault_client_output_invalid");
    error.evidence = { exitCode: completion.exitCode, stdout: text.slice(0, 512) };
    throw error;
  }
}

async function waitForStartedCompletion(started, {
  timeoutMs = 30_000,
  label = "concurrent-process",
} = {}) {
  let timedOut = false;
  const result = await Promise.race([
    started.completion,
    sleep(timeoutMs).then(() => {
      timedOut = true;
      return null;
    }),
  ]);
  if (!timedOut && result) return result;
  terminateProcessTree(started.child);
  await Promise.race([started.completion, sleep(5_000)]);
  throw new Error(`wave10_fault_process_timeout:${label}:${timeoutMs}`);
}

export async function runWave10FaultPreflight({
  harnessRoot = nativeRealpath(process.env.AGENT_HARNESS_ROOT || scriptRoot),
  output = null,
  runId = null,
} = {}) {
  const preflightId = runId || randomId("wave10-fault-preflight");
  const outputDir = ensureDir(resolve(output || join(tmpdir(), "agentic-harness-wave10-fault-preflight", preflightId)));
  const runner = new ProcessRunner({ outputDir });
  const consumerRoot = nativeRealpath(mkdtempSync(join(tmpdir(), "agentic-harness-wave10-fault-consumer-")));
  const composeProject = `wave10-fault-${randomBytes(5).toString("hex")}`;
  const hmacKey = randomBytes(32).toString("hex");
  const postgresPort = await allocatePort();
  const composeEnv = {
    AGENT_HARNESS_ROOT: harnessRoot,
    AGENT_HARNESS_PROJECT_ROOT: consumerRoot,
    AGENT_HARNESS_POSTGRES_PORT: String(postgresPort),
    POSTGRES_USER: "agent",
    POSTGRES_PASSWORD: "agent",
    POSTGRES_DB: "agent_harness",
    AGENT_HARNESS_DOCKER_GATEWAY_HMAC_KEY: hmacKey,
  };
  const composeBase = [
    "compose",
    "-p", composeProject,
    "-f", resolve(harnessRoot, "compose.yaml"),
    "--profile", "runtime",
    "--profile", "behavior-gateway",
  ];
  const compose = (extra, options = {}) => runner.run("docker", [...composeBase, ...extra], {
    cwd: consumerRoot,
    env: composeEnv,
    label: options.label ?? `wave10-fault-compose-${extra[0] ?? "command"}`,
    timeoutMs: options.timeoutMs ?? 120_000,
    allowExitCodes: options.allowExitCodes,
    input: options.input,
  });
  const sql = (statement, label) => compose([
    "exec", "-T", "postgres",
    "psql", "-v", "ON_ERROR_STOP=1", "-U", "agent", "-d", "agent_harness", "-Atqc", statement,
  ], { label, timeoutMs: 30_000 }).stdout.trim();

  let behavior = null;
  let composeStarted = false;
  let workspaceVolume = null;
  let networkName = null;
  let report = null;
  const cleanupErrors = [];
  const liveClients = new Set();

  async function requireGatewayReady(label) {
    await waitFor(() => {
      try {
        const probe = compose([
          "exec", "-T", "docker-behavior-gateway",
          "node", "-e", gatewayHealthScript(),
        ], {
          label,
          timeoutMs: 15_000,
          allowExitCodes: [0, 2, 3],
        });
        return probe.exitCode === 0 ? probe.stdout.trim() : null;
      } catch {
        return null;
      }
    }, { timeoutMs: 120_000, intervalMs: 1_000, label });
  }

  async function requirePostgresReady(label) {
    await waitFor(() => {
      try {
        const probe = compose([
          "exec", "-T", "postgres",
          "pg_isready", "-U", "agent", "-d", "agent_harness",
        ], {
          label,
          timeoutMs: 10_000,
          allowExitCodes: [0, 1, 2],
        });
        return probe.exitCode === 0 ? true : null;
      } catch {
        return null;
      }
    }, { timeoutMs: 120_000, intervalMs: 1_000, label });
  }

  function copyScenarioWorkspace(workspacePath, label) {
    runner.run("docker", [
      "run", "--rm", "--pull", "never",
      "--user", "0:0",
      "--entrypoint", "sh",
      "--mount", `type=volume,src=${workspaceVolume},dst=/workspace/agent-workspaces`,
      "--mount", `type=bind,src=${consumerRoot},dst=/source,readonly`,
      behavior.imageId,
      "-ec", 'mkdir -p "$1"; cp -a /source/. "$1"/', label, workspacePath,
    ], { label: `${label}-copy-workspace`, timeoutMs: 120_000 });
  }

  function seedScenario(name, commandId) {
    const now = new Date();
    const fenceRunId = `run-${name}-${randomBytes(6).toString("hex")}`;
    const taskId = `task-${name}-${randomBytes(6).toString("hex")}`;
    const leaseOwner = `wave10-${name}-${randomBytes(5).toString("hex")}`;
    const attempt = 1;
    const dispatchGeneration = 1;
    const fencingToken = 1;
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const workspaceRelative = `${fenceRunId}/${taskId}--attempt-${attempt}`;
    const workspacePath = `/workspace/agent-workspaces/${workspaceRelative}`;
    copyScenarioWorkspace(workspacePath, name);

    const capability = randomBytes(32).toString("hex");
    const fence = {
      schemaVersion: "task-execution-fence/v1",
      runId: fenceRunId,
      taskId,
      attempt,
      dispatchGeneration,
      fencingToken,
      leaseOwner,
      leaseExpiresAt,
      observedAt: now.toISOString(),
    };
    const capabilityFingerprint = gatewayCapabilityProof(hmacKey, capability, fence);
    const checkpointId = `checkpoint-${name}-${randomBytes(6).toString("hex")}`;
    const seedSql = [
      "BEGIN;",
      `INSERT INTO agent_runs(run_id,request,status,plan_json,max_parallel,created_at,started_at) VALUES (${sqlLiteral(fenceRunId)},${sqlLiteral(`wave10-fault-${name}`)},'running','{}',1,${sqlLiteral(now.toISOString())},${sqlLiteral(now.toISOString())});`,
      `INSERT INTO agent_tasks(task_id,run_id,agent_id,role,status,attempt,max_attempts,dependencies_json,owned_paths_json,workspace_path,dispatch_generation,lease_owner,lease_expires_at,fencing_token,started_at) VALUES (${sqlLiteral(taskId)},${sqlLiteral(fenceRunId)},${sqlLiteral(`wave10-${name}-agent`)},'implementation','running',1,1,'[]','[]',${sqlLiteral(workspacePath)},1,${sqlLiteral(leaseOwner)},${sqlLiteral(leaseExpiresAt)},1,${sqlLiteral(now.toISOString())});`,
      `INSERT INTO agent_task_checkpoints(checkpoint_id,run_id,task_id,checkpoint_type,attempt,dispatch_generation,fencing_token,fingerprint,reusable,payload_json,created_at) VALUES (${sqlLiteral(checkpointId)},${sqlLiteral(fenceRunId)},${sqlLiteral(taskId)},'behavior.gateway.capability',1,1,1,${sqlLiteral(capabilityFingerprint)},false,'{}',${sqlLiteral(now.toISOString())});`,
      "COMMIT;",
    ].join("\n");
    sql(seedSql, `${name}-seed-fence`);

    const request = {
      schemaVersion: "docker-behavior-gateway-request/v1",
      commandAuthority: commandAuthorityFromConfiguration(behavior.configuration),
      commandSpecIds: [commandId],
      executionFence: fence,
      workspacePath,
      capability,
    };
    return {
      name,
      commandId,
      runId: fenceRunId,
      taskId,
      fence,
      request,
      capabilityFingerprint,
      containerName: behaviorContainerName(fence, commandId),
    };
  }

  function startGatewayClient(scenario, label) {
    const started = runner.start("docker", [
      "run", "--rm", "--pull", "never", "-i",
      "--network", networkName,
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m,mode=1777",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges=true",
      "--pids-limit", "64",
      "--user", "node",
      "--entrypoint", "node",
      behavior.imageId,
      "-e", gatewayFaultClientScript(),
    ], {
      label,
      input: JSON.stringify(scenario.request),
      maxCaptureBytes: 1024 * 1024,
    });
    liveClients.add(started);
    started.completion.finally(() => liveClients.delete(started));
    return started;
  }

  async function waitBehaviorRunning(scenario, label) {
    return await waitFor(() => {
      const inspect = runner.run("docker", [
        "container", "inspect", "--format", "{{json .State.Running}}", scenario.containerName,
      ], {
        label,
        allowExitCodes: [0, 1],
        timeoutMs: 10_000,
      });
      return inspect.exitCode === 0 && inspect.stdout.trim() === "true" ? true : null;
    }, { timeoutMs: 30_000, intervalMs: 200, label });
  }

  async function requireBehaviorGone(scenario, label) {
    return await waitFor(() => {
      const inspect = runner.run("docker", ["container", "inspect", scenario.containerName], {
        label,
        allowExitCodes: [0, 1],
        timeoutMs: 10_000,
      });
      return inspect.exitCode !== 0 ? true : null;
    }, { timeoutMs: 15_000, intervalMs: 200, label });
  }

  function assertHoldResponse(response, expectedCode, scenario) {
    if (response.kind !== "http" || response.httpStatus !== 409
        || response.body?.status !== "HOLD" || response.body?.code !== expectedCode
        || !Array.isArray(response.body?.receipts) || response.body.receipts.length !== 0) {
      const error = new Error(`wave10_fault_${scenario.name}_response_invalid`);
      error.evidence = { expectedCode, response };
      throw error;
    }
  }

  async function quickRecoveryProbe(name) {
    const scenario = seedScenario(name, QUALIFICATION_BEHAVIOR_COMMAND_ID);
    const started = startGatewayClient(scenario, `${name}-client`);
    const completion = await waitForStartedCompletion(started, {
      timeoutMs: 60_000,
      label: `${name}-client`,
    });
    const response = parseClientCompletion(completion);
    if (response.kind !== "http" || response.httpStatus !== 200
        || response.body?.status !== "PASSED"
        || response.body?.code !== "docker_gateway_behavior_passed"
        || response.body?.receipts?.[0]?.status !== "BEHAVIOR_PASSED") {
      const error = new Error(`wave10_fault_${name}_recovery_probe_failed`);
      error.evidence = { response };
      throw error;
    }
    await requireBehaviorGone(scenario, `${name}-behavior-gone`);
    return {
      runId: scenario.runId,
      taskId: scenario.taskId,
      gatewayStatus: response.body.status,
      receiptStatus: response.body.receipts[0].status,
      behaviorContainerRemoved: true,
    };
  }

  try {
    const sourceHead = gitText(runner, harnessRoot, ["rev-parse", "HEAD"], "fault-source-head");
    const sourceStatus = gitText(runner, harnessRoot, ["status", "--porcelain", "--untracked-files=all"], "fault-source-status");
    if (sourceStatus !== "") throw new Error("wave10_fault_preflight_harness_source_dirty");

    materializeFixture(consumerRoot);
    runner.run("git", ["-C", consumerRoot, "init"], { label: "fault-consumer-git-init" });
    runner.run("git", ["-C", consumerRoot, "config", "user.name", "Agentic Harness Wave10 Fault Preflight"], { label: "fault-consumer-git-user" });
    runner.run("git", ["-C", consumerRoot, "config", "user.email", "wave10-fault@example.invalid"], { label: "fault-consumer-git-email" });
    runner.run("git", ["-C", consumerRoot, "config", "core.autocrlf", "false"], { label: "fault-consumer-git-autocrlf" });
    runner.run("git", ["-C", consumerRoot, "add", "."], { label: "fault-consumer-git-add" });
    runner.run("git", ["-C", consumerRoot, "commit", "-m", "wave10 fault consumer baseline"], { label: "fault-consumer-baseline-commit" });
    runner.run("git", [
      "-C", consumerRoot, "-c", "protocol.file.allow=always",
      "submodule", "add", harnessRoot, ".harness",
    ], { label: "fault-consumer-submodule-add", timeoutMs: 120_000 });
    runner.run("git", ["-C", consumerRoot, "add", ".gitmodules", ".harness"], { label: "fault-consumer-submodule-stage" });
    runner.run("git", ["-C", consumerRoot, "commit", "-m", "pin exact Agentic Harness candidate"], { label: "fault-consumer-submodule-commit" });
    const consumerHead = gitText(runner, consumerRoot, ["rev-parse", "HEAD"], "fault-consumer-head");
    const submoduleHead = gitText(runner, resolve(consumerRoot, ".harness"), ["rev-parse", "HEAD"], "fault-submodule-head");
    if (submoduleHead !== sourceHead) throw new Error("wave10_fault_preflight_submodule_head_mismatch");

    behavior = buildSourceAttestedQualificationImage({
      consumerRoot,
      labelPrefix: "wave10-fault-behavior-runner",
      run: (command, args, options) => runner.run(command, args, options),
    });

    composeStarted = true;
    compose([
      "up", "-d", "--build",
      "postgres", "database-migrate", "docker-behavior-gateway",
    ], { label: "fault-stack-up", timeoutMs: 20 * 60_000 });
    await requirePostgresReady("fault-postgres-ready");
    await requireGatewayReady("fault-gateway-ready");

    const dockerRuntimeProbe = compose([
      "exec", "-T", "docker-behavior-gateway",
      "docker", "version", "--format", "{{.Client.Version}} {{.Server.APIVersion}}",
    ], { label: "fault-gateway-docker-version", timeoutMs: 30_000 });
    const dockerRuntime = parseDockerRuntimeVersion(dockerRuntimeProbe.stdout);

    const gatewayId = compose(["ps", "-q", "docker-behavior-gateway"], { label: "fault-gateway-id" }).stdout.trim();
    if (!gatewayId) throw new Error("wave10_fault_gateway_container_missing");
    const gatewayInspect = JSON.parse(runner.run("docker", ["inspect", gatewayId], { label: "fault-gateway-inspect" }).stdout)[0];
    const gatewayProcessBaseline = {
      containerId: gatewayId,
      pid: gatewayInspect?.State?.Pid ?? null,
      restartCount: gatewayInspect?.RestartCount ?? null,
    };
    if (!Number.isInteger(gatewayProcessBaseline.pid) || gatewayProcessBaseline.pid <= 0
        || !Number.isInteger(gatewayProcessBaseline.restartCount)) {
      const error = new Error("wave10_fault_gateway_process_baseline_invalid");
      error.evidence = gatewayProcessBaseline;
      throw error;
    }
    const workspaceMount = (gatewayInspect?.Mounts ?? []).find(item =>
      item?.Type === "volume"
      && item?.Destination === "/workspace/agent-workspaces"
      && typeof item?.Name === "string" && item.Name);
    if (!workspaceMount) throw new Error("wave10_fault_workspace_volume_missing");
    workspaceVolume = workspaceMount.Name;
    const networks = Object.keys(gatewayInspect?.NetworkSettings?.Networks ?? {});
    if (networks.length !== 1) {
      const error = new Error("wave10_fault_gateway_network_ambiguous");
      error.evidence = { networks };
      throw error;
    }
    [networkName] = networks;

    const fenceScenario = seedScenario("fence-replacement", QUALIFICATION_BEHAVIOR_DELAY_COMMAND_ID);
    const fenceClient = startGatewayClient(fenceScenario, "fence-replacement-client");
    await waitBehaviorRunning(fenceScenario, "fence-replacement-behavior-running");
    const replaced = sql(
      `UPDATE agent_tasks SET fencing_token=fencing_token+1,state_version=state_version+1 WHERE run_id=${sqlLiteral(fenceScenario.runId)} AND task_id=${sqlLiteral(fenceScenario.taskId)} AND fencing_token=1 RETURNING fencing_token;`,
      "fence-replacement-update",
    );
    if (replaced !== "2") throw new Error("wave10_fault_fence_replacement_not_applied");
    const fenceCompletion = await waitForStartedCompletion(fenceClient, {
      timeoutMs: 30_000,
      label: "fence-replacement-client",
    });
    const fenceResponse = parseClientCompletion(fenceCompletion);
    assertHoldResponse(fenceResponse, "docker_gateway_fence_identity_mismatch", fenceScenario);
    await requireBehaviorGone(fenceScenario, "fence-replacement-behavior-gone");

    const postgresScenario = seedScenario("postgres-outage", QUALIFICATION_BEHAVIOR_DELAY_COMMAND_ID);
    const postgresClient = startGatewayClient(postgresScenario, "postgres-outage-client");
    await waitBehaviorRunning(postgresScenario, "postgres-outage-behavior-running");
    compose(["stop", "postgres"], { label: "postgres-outage-stop", timeoutMs: 60_000 });
    const postgresCompletion = await waitForStartedCompletion(postgresClient, {
      timeoutMs: 30_000,
      label: "postgres-outage-client",
    });
    const postgresResponse = parseClientCompletion(postgresCompletion);
    assertHoldResponse(postgresResponse, "docker_gateway_capability_store_unavailable", postgresScenario);
    await requireBehaviorGone(postgresScenario, "postgres-outage-behavior-gone");
    compose(["start", "postgres"], { label: "postgres-outage-start", timeoutMs: 60_000 });
    await requirePostgresReady("postgres-outage-recovered");
    const postgresRecovery = await quickRecoveryProbe("postgres-recovery");
    const gatewayAfterPostgres = JSON.parse(runner.run("docker", ["inspect", gatewayId], {
      label: "postgres-outage-gateway-process-after-recovery",
    }).stdout)[0];
    const gatewayProcessAfterPostgres = {
      containerId: gatewayId,
      pid: gatewayAfterPostgres?.State?.Pid ?? null,
      restartCount: gatewayAfterPostgres?.RestartCount ?? null,
      running: gatewayAfterPostgres?.State?.Running === true,
    };
    if (!gatewayProcessAfterPostgres.running
        || gatewayProcessAfterPostgres.pid !== gatewayProcessBaseline.pid
        || gatewayProcessAfterPostgres.restartCount !== gatewayProcessBaseline.restartCount) {
      const error = new Error("wave10_fault_postgres_outage_restarted_gateway");
      error.evidence = {
        before: gatewayProcessBaseline,
        after: gatewayProcessAfterPostgres,
      };
      throw error;
    }

    const gatewayScenario = seedScenario("gateway-outage", QUALIFICATION_BEHAVIOR_COMMAND_ID);
    compose(["stop", "docker-behavior-gateway"], { label: "gateway-outage-stop", timeoutMs: 60_000 });
    const gatewayClient = startGatewayClient(gatewayScenario, "gateway-outage-client");
    const gatewayCompletion = await waitForStartedCompletion(gatewayClient, {
      timeoutMs: 30_000,
      label: "gateway-outage-client",
    });
    const gatewayResponse = parseClientCompletion(gatewayCompletion);
    if (gatewayResponse.kind !== "transport" || gatewayResponse.exitCode !== 2) {
      const error = new Error("wave10_fault_gateway_outage_not_transport_failure");
      error.evidence = { gatewayResponse };
      throw error;
    }
    await requireBehaviorGone(gatewayScenario, "gateway-outage-no-behavior");
    compose(["start", "docker-behavior-gateway"], { label: "gateway-outage-start", timeoutMs: 60_000 });
    await requireGatewayReady("gateway-outage-recovered");
    const retryClient = startGatewayClient(gatewayScenario, "gateway-outage-retry-client");
    const retryCompletion = await waitForStartedCompletion(retryClient, {
      timeoutMs: 60_000,
      label: "gateway-outage-retry-client",
    });
    const retryResponse = parseClientCompletion(retryCompletion);
    if (retryResponse.kind !== "http" || retryResponse.httpStatus !== 200
        || retryResponse.body?.status !== "PASSED"
        || retryResponse.body?.receipts?.[0]?.status !== "BEHAVIOR_PASSED") {
      const error = new Error("wave10_fault_gateway_recovery_failed");
      error.evidence = { retryResponse };
      throw error;
    }
    await requireBehaviorGone(gatewayScenario, "gateway-outage-retry-behavior-gone");

    report = {
      schemaVersion: "wave10-fault-preflight-report/v1",
      verdict: "PASS",
      preflightId,
      harness: { head: sourceHead, clean: true },
      consumer: { head: consumerHead, harnessGitlink: submoduleHead },
      dockerRuntime: {
        clientVersion: dockerRuntime.clientVersion,
        serverApiVersion: dockerRuntime.serverApiVersion,
        volumeSubpathSupported: true,
      },
      sourceAttestedImage: {
        sourceSnapshotSha256: behavior.sourceSnapshotSha256,
        runnerSpecDigest: behavior.runnerSpecDigest,
        sourceBindingDigest: behavior.sourceBindingDigest,
        imageId: behavior.imageId,
        attestationIdentityDigest: behavior.attestationIdentityDigest,
      },
      faults: {
        fenceReplacement: {
          status: "PASS",
          expectedHoldCode: "docker_gateway_fence_identity_mismatch",
          observedHoldCode: fenceResponse.body.code,
          behaviorContainerRemoved: true,
          replacementFencingToken: 2,
          receiptsAccepted: 0,
        },
        postgresOutage: {
          status: "PASS",
          expectedHoldCode: "docker_gateway_capability_store_unavailable",
          observedHoldCode: postgresResponse.body.code,
          behaviorContainerRemoved: true,
          receiptsAccepted: 0,
          recoveredWithoutGatewayRestart: true,
          gatewayProcessBefore: gatewayProcessBaseline,
          gatewayProcessAfter: gatewayProcessAfterPostgres,
          recoveryProbe: postgresRecovery,
        },
        gatewayOutage: {
          status: "PASS",
          transportFailedClosed: true,
          behaviorContainerStartedWhileGatewayDown: false,
          recovered: true,
          retryGatewayStatus: retryResponse.body.status,
          retryReceiptStatus: retryResponse.body.receipts[0].status,
          behaviorContainerRemoved: true,
        },
      },
      rawCapabilityPersistedInEvidence: false,
      hmacKeyPersistedInEvidence: false,
      outputDir,
    };
    return report;
  } catch (error) {
    report = {
      schemaVersion: "wave10-fault-preflight-report/v1",
      verdict: "HOLD",
      preflightId,
      failure: safeFailure(error),
      outputDir,
    };
    error.preflightOutputDir = outputDir;
    throw error;
  } finally {
    for (const started of liveClients) {
      try { terminateProcessTree(started.child); } catch {}
    }
    if (composeStarted) {
      try {
        compose(["down", "-v", "--remove-orphans"], {
          label: "fault-stack-down",
          timeoutMs: 5 * 60_000,
        });
      } catch (error) {
        cleanupErrors.push(safeFailure(error));
      }
    }
    if (behavior?.imageId) {
      try {
        runner.run("docker", ["image", "rm", "-f", behavior.imageId], {
          label: "fault-behavior-image-cleanup",
          timeoutMs: 60_000,
          allowExitCodes: [0, 1],
        });
      } catch (error) {
        cleanupErrors.push(safeFailure(error));
      }
    }
    try {
      rmSync(consumerRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(safeFailure(error));
    }
    if (report) {
      report.cleanup = {
        attempted: true,
        errors: cleanupErrors,
        ok: cleanupErrors.length === 0,
      };
      if (cleanupErrors.length > 0 && report.verdict === "PASS") {
        report.verdict = "HOLD";
        report.failure = {
          message: "wave10_fault_preflight_cleanup_failed",
          code: "wave10_fault_preflight_cleanup_failed",
          evidence: { cleanupErrors },
        };
      }
      writeJson(resolve(outputDir, "wave10-fault-preflight.json"), report);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = await runWave10FaultPreflight({
      harnessRoot: nativeRealpath(process.env.AGENT_HARNESS_ROOT || scriptRoot),
      output: args.output,
      runId: args.runId,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.cleanup?.ok === false) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      verdict: "HOLD",
      error: String(error?.message ?? error),
      code: error?.code ?? null,
      outputDir: error?.preflightOutputDir ?? null,
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
