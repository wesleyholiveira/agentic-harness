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
  materializeFixture,
} from "./lib/fixture.mjs";
import { ProcessRunner } from "./lib/process.mjs";
import { buildSourceAttestedQualificationImage } from "./lib/source-attested-behavior.mjs";
import {
  allocatePort,
  ensureDir,
  nativeRealpath,
  randomId,
  waitFor,
  writeJson,
} from "./lib/util.mjs";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function commandAuthorityFromConfiguration(configuration) {
  return {
    schemaVersion: "command-authority/v1",
    projectId: configuration.descriptor.projectId,
    repositoryId: configuration.descriptor.repositoryId,
    sourceCommit: configuration.sourceCommit,
    sourceSnapshotSha256: configuration.sourceSnapshotSha256,
    descriptorDigest: configuration.descriptorDigest,
    policyDigest: configuration.policyDigest,
  };
}

function parseArgs(argv) {
  const out = { output: null, runId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") out.output = argv[++index];
    else if (arg === "--run-id") out.runId = argv[++index];
    else throw new Error(`wave10_preflight_unknown_argument:${arg}`);
  }
  return out;
}

function gitText(runner, root, args, label) {
  return runner.run("git", ["-C", root, ...args], { label }).stdout.trim();
}

function gatewayPostScript() {
  return [
    "let input='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',chunk=>input+=chunk);",
    "process.stdin.on('end',async()=>{",
    "try{",
    "const request=JSON.parse(input);",
    "const response=await fetch('http://127.0.0.1:8792/v1/behavior',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});",
    "const body=await response.json();",
    "process.stdout.write(JSON.stringify({httpStatus:response.status,body}));",
    "}catch(error){process.stdout.write(JSON.stringify({httpStatus:0,error:String(error?.message??error)}));process.exitCode=2;}",
    "});",
  ].join("");
}

function gatewayHealthScript() {
  return [
    "fetch('http://127.0.0.1:8792/health')",
    ".then(async response=>{if(response.status!==200)process.exit(2);process.stdout.write(await response.text());})",
    ".catch(()=>process.exit(3));",
  ].join("");
}

function safeFailure(error) {
  return {
    message: String(error?.message ?? error),
    code: error?.code ?? null,
    evidence: error?.evidence ?? null,
  };
}

export async function runWave10LivePreflight({
  harnessRoot = nativeRealpath(process.env.AGENT_HARNESS_ROOT || scriptRoot),
  output = null,
  runId = null,
} = {}) {
  const preflightId = runId || randomId("wave10-live-preflight");
  const outputDir = ensureDir(resolve(output || join(tmpdir(), "agentic-harness-wave10-preflight", preflightId)));
  const runner = new ProcessRunner({ outputDir });
  const consumerRoot = nativeRealpath(mkdtempSync(join(tmpdir(), "agentic-harness-wave10-consumer-")));
  const composeProject = `wave10-preflight-${randomBytes(5).toString("hex")}`;
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
    label: options.label ?? `wave10-compose-${extra[0] ?? "command"}`,
    timeoutMs: options.timeoutMs ?? 120_000,
    allowExitCodes: options.allowExitCodes,
    input: options.input,
  });

  let behavior = null;
  let composeStarted = false;
  let report = null;
  const cleanupErrors = [];
  try {
    const sourceHead = gitText(runner, harnessRoot, ["rev-parse", "HEAD"], "wave10-source-head");
    const sourceStatus = gitText(runner, harnessRoot, ["status", "--porcelain", "--untracked-files=all"], "wave10-source-status");
    if (sourceStatus !== "") throw new Error("wave10_preflight_harness_source_dirty");

    materializeFixture(consumerRoot);
    runner.run("git", ["-C", consumerRoot, "init"], { label: "wave10-consumer-git-init" });
    runner.run("git", ["-C", consumerRoot, "config", "user.name", "Agentic Harness Wave10 Preflight"], { label: "wave10-consumer-git-user" });
    runner.run("git", ["-C", consumerRoot, "config", "user.email", "wave10-preflight@example.invalid"], { label: "wave10-consumer-git-email" });
    runner.run("git", ["-C", consumerRoot, "config", "core.autocrlf", "false"], { label: "wave10-consumer-git-autocrlf" });
    runner.run("git", ["-C", consumerRoot, "add", "."], { label: "wave10-consumer-git-add" });
    runner.run("git", ["-C", consumerRoot, "commit", "-m", "wave10 preflight consumer baseline"], { label: "wave10-consumer-baseline-commit" });
    runner.run("git", [
      "-C", consumerRoot, "-c", "protocol.file.allow=always",
      "submodule", "add", harnessRoot, ".harness",
    ], { label: "wave10-consumer-submodule-add", timeoutMs: 120_000 });
    runner.run("git", ["-C", consumerRoot, "add", ".gitmodules", ".harness"], { label: "wave10-consumer-submodule-stage" });
    runner.run("git", ["-C", consumerRoot, "commit", "-m", "pin exact Agentic Harness candidate"], { label: "wave10-consumer-submodule-commit" });
    const consumerHead = gitText(runner, consumerRoot, ["rev-parse", "HEAD"], "wave10-consumer-head");
    const submoduleHead = gitText(runner, resolve(consumerRoot, ".harness"), ["rev-parse", "HEAD"], "wave10-submodule-head");
    if (submoduleHead !== sourceHead) {
      const error = new Error("wave10_preflight_submodule_head_mismatch");
      error.evidence = { sourceHead, submoduleHead };
      throw error;
    }

    behavior = buildSourceAttestedQualificationImage({
      consumerRoot,
      labelPrefix: "wave10-preflight-behavior-runner",
      run: (command, args, options) => runner.run(command, args, options),
    });

    compose([
      "up", "-d", "--build",
      "postgres", "database-migrate", "docker-behavior-gateway",
    ], { label: "wave10-gateway-stack-up", timeoutMs: 20 * 60_000 });
    composeStarted = true;

    await waitFor(() => {
      try {
        const probe = compose([
          "exec", "-T", "docker-behavior-gateway",
          "node", "-e", gatewayHealthScript(),
        ], {
          label: "wave10-gateway-health",
          timeoutMs: 15_000,
          allowExitCodes: [0, 2, 3],
        });
        return probe.exitCode === 0 ? probe.stdout.trim() : null;
      } catch {
        return null;
      }
    }, { timeoutMs: 120_000, intervalMs: 1_000, label: "wave10-gateway-ready" });

    const gatewayId = compose(["ps", "-q", "docker-behavior-gateway"], {
      label: "wave10-gateway-id",
    }).stdout.trim();
    if (!gatewayId) throw new Error("wave10_preflight_gateway_container_missing");
    const mountsRaw = runner.run("docker", [
      "inspect", "--format", "{{json .Mounts}}", gatewayId,
    ], { label: "wave10-gateway-mounts" }).stdout.trim();
    const mounts = JSON.parse(mountsRaw);
    const workspaceMount = mounts.find(item =>
      item?.Type === "volume"
      && item?.Destination === "/workspace/agent-workspaces"
      && typeof item?.Name === "string"
      && item.Name);
    if (!workspaceMount) throw new Error("wave10_preflight_workspace_volume_missing");

    const fenceRunId = `run-${randomBytes(8).toString("hex")}`;
    const taskId = `task-${randomBytes(8).toString("hex")}`;
    const leaseOwner = `wave10-preflight-${randomBytes(6).toString("hex")}`;
    const attempt = 1;
    const dispatchGeneration = 1;
    const fencingToken = 1;
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const workspaceRelative = `${fenceRunId}/${taskId}--attempt-${attempt}`;
    const workspacePath = `/workspace/agent-workspaces/${workspaceRelative}`;

    runner.run("docker", [
      "run", "--rm", "--pull", "never",
      "--mount", `type=volume,src=${workspaceMount.Name},dst=/workspace/agent-workspaces`,
      "--mount", `type=bind,src=${consumerRoot},dst=/source,readonly`,
      "node:22-alpine",
      "sh", "-ec", 'mkdir -p "$1"; cp -a /source/. "$1"/', "wave10-copy", workspacePath,
    ], { label: "wave10-copy-workspace", timeoutMs: 120_000 });

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
    const checkpointId = `checkpoint-${randomBytes(8).toString("hex")}`;
    const sql = [
      "BEGIN;",
      `INSERT INTO agent_runs(run_id,request,status,plan_json,max_parallel,created_at,started_at) VALUES (${sqlLiteral(fenceRunId)},'wave10-live-preflight','running','{}',1,${sqlLiteral(now.toISOString())},${sqlLiteral(now.toISOString())});`,
      `INSERT INTO agent_tasks(task_id,run_id,agent_id,role,status,attempt,max_attempts,dependencies_json,owned_paths_json,workspace_path,dispatch_generation,lease_owner,lease_expires_at,fencing_token,started_at) VALUES (${sqlLiteral(taskId)},${sqlLiteral(fenceRunId)},'wave10-preflight-agent','implementation','running',1,1,'[]','[]',${sqlLiteral(workspacePath)},1,${sqlLiteral(leaseOwner)},${sqlLiteral(leaseExpiresAt)},1,${sqlLiteral(now.toISOString())});`,
      `INSERT INTO agent_task_checkpoints(checkpoint_id,run_id,task_id,checkpoint_type,attempt,dispatch_generation,fencing_token,fingerprint,reusable,payload_json,created_at) VALUES (${sqlLiteral(checkpointId)},${sqlLiteral(fenceRunId)},${sqlLiteral(taskId)},'behavior.gateway.capability',1,1,1,${sqlLiteral(capabilityFingerprint)},false,'{}',${sqlLiteral(now.toISOString())});`,
      "COMMIT;",
    ].join("\n");
    compose([
      "exec", "-T", "postgres",
      "psql", "-v", "ON_ERROR_STOP=1", "-U", "agent", "-d", "agent_harness", "-c", sql,
    ], { label: "wave10-seed-fence", timeoutMs: 30_000 });

    const commandAuthority = commandAuthorityFromConfiguration(behavior.configuration);
    const request = {
      schemaVersion: "docker-behavior-gateway-request/v1",
      commandAuthority,
      commandSpecIds: [QUALIFICATION_BEHAVIOR_COMMAND_ID],
      executionFence: fence,
      workspacePath,
      capability,
    };
    const post = compose([
      "exec", "-T", "docker-behavior-gateway",
      "node", "-e", gatewayPostScript(),
    ], {
      label: "wave10-gateway-behavior-post",
      timeoutMs: 3 * 60_000,
      input: JSON.stringify(request),
      allowExitCodes: [0, 2],
    });
    let response;
    try {
      response = JSON.parse(post.stdout.trim());
    } catch {
      throw new Error("wave10_preflight_gateway_response_invalid");
    }
    if (post.exitCode !== 0 || response.httpStatus !== 200 || response.body?.status !== "PASSED"
        || response.body?.code !== "docker_gateway_behavior_passed") {
      const error = new Error("wave10_preflight_gateway_behavior_not_passed");
      error.evidence = { exitCode: post.exitCode, response };
      throw error;
    }
    const receipt = response.body.receipts?.[0] ?? null;
    if (!receipt || response.body.receipts.length !== 1
        || receipt.status !== "BEHAVIOR_PASSED"
        || receipt.code !== "behavior_passed"
        || receipt.commandId !== QUALIFICATION_BEHAVIOR_COMMAND_ID
        || receipt.sourceSnapshotSha256 !== behavior.sourceSnapshotSha256
        || response.body.commandAuthority?.sourceCommit !== behavior.sourceCommit
        || typeof response.body.workspaceBindingDigest !== "string"
        || !response.body.workspaceBindingDigest.startsWith("sha256:")) {
      const error = new Error("wave10_preflight_behavior_receipt_invalid");
      error.evidence = { response: response.body };
      throw error;
    }

    const containerName = behaviorContainerName(fence, QUALIFICATION_BEHAVIOR_COMMAND_ID);
    const lingering = runner.run("docker", ["container", "inspect", containerName], {
      label: "wave10-behavior-container-gone",
      allowExitCodes: [0, 1],
      timeoutMs: 30_000,
    });
    if (lingering.exitCode === 0) {
      const error = new Error("wave10_preflight_behavior_container_lingering");
      error.evidence = { containerName };
      throw error;
    }

    report = {
      schemaVersion: "wave10-live-preflight-report/v1",
      verdict: "PASS",
      preflightId,
      harness: {
        head: sourceHead,
        clean: true,
      },
      consumer: {
        head: consumerHead,
        harnessGitlink: submoduleHead,
      },
      sourceAttestedImage: {
        runnerId: behavior.runnerId,
        sourceSnapshotSha256: behavior.sourceSnapshotSha256,
        runnerSpecDigest: behavior.runnerSpecDigest,
        sourceBindingDigest: behavior.sourceBindingDigest,
        imageId: behavior.imageId,
        attestationIdentityDigest: behavior.attestationIdentityDigest,
      },
      gateway: {
        composeProject,
        containerId: gatewayId,
        workspaceVolume: workspaceMount.Name,
        commandId: QUALIFICATION_BEHAVIOR_COMMAND_ID,
        status: response.body.status,
        code: response.body.code,
        receiptStatus: receipt.status,
        receiptCode: receipt.code,
        behaviorContainerRemoved: true,
      },
      fence: {
        runId: fenceRunId,
        taskId,
        attempt,
        dispatchGeneration,
        fencingToken,
        leaseOwner,
        capabilityFingerprint,
      },
      secretsPersisted: false,
      outputDir,
    };
    return report;
  } catch (error) {
    report = {
      schemaVersion: "wave10-live-preflight-report/v1",
      verdict: "HOLD",
      preflightId,
      failure: safeFailure(error),
      outputDir,
    };
    throw error;
  } finally {
    if (composeStarted) {
      try {
        compose(["down", "-v", "--remove-orphans"], {
          label: "wave10-gateway-stack-down",
          timeoutMs: 5 * 60_000,
          allowExitCodes: [0, 1],
        });
      } catch (error) {
        cleanupErrors.push(safeFailure(error));
      }
    }
    if (behavior?.imageId) {
      try {
        runner.run("docker", ["image", "rm", "-f", behavior.imageId], {
          label: "wave10-behavior-image-cleanup",
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
      writeJson(resolve(outputDir, "wave10-live-preflight.json"), report);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = await runWave10LivePreflight({
      harnessRoot: nativeRealpath(process.env.AGENT_HARNESS_ROOT || scriptRoot),
      output: args.output,
      runId: args.runId,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.cleanup?.ok === false) process.exitCode = 1;
  } catch (error) {
    const failure = {
      verdict: "HOLD",
      error: String(error?.message ?? error),
      code: error?.code ?? null,
    };
    process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exitCode = 1;
  }
}
