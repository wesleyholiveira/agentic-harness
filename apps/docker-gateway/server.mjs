#!/usr/bin/env node
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadCommittedProjectConfiguration } from '../../packages/project-adapters/src/trusted-config.mjs';
import { bindWorkspaceAuthorityInputs } from '../../packages/project-adapters/src/workspace-binding.mjs';
import { probeDockerRunnerMaterialization } from '../../packages/project-adapters/src/docker-materialization-v2.mjs';
import { probeDockerToolchainV2 } from '../../packages/project-adapters/src/docker-toolchain-v2.mjs';
import { probeDockerImageSourceAttestation } from '../../packages/project-adapters/src/docker-image-attestation.mjs';
import { executeDockerBehaviorCommandV2Async } from '../../packages/project-adapters/src/behavior-executor-v2.mjs';
import { createPostgresCapabilityVerifier } from './fence-store.mjs';
import { spawnSync } from 'node:child_process';

const BODY_LIMIT = 128 * 1024;
const MAX_COMMANDS = 32;

let defaultCapabilityVerifierPromise = null;
async function verifyWithDefaultCapabilityStore(request, options) {
  defaultCapabilityVerifierPromise ??= createPostgresCapabilityVerifier();
  const verifier = await defaultCapabilityVerifierPromise;
  return await verifier(request, options);
}

function nativeDocker(argv, { cwd, timeoutMs }) {
  return spawnSync('docker', argv, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore','pipe','pipe'],
  });
}
function hold(code, details = {}) {
  return { schemaVersion: 'docker-behavior-gateway-result/v1', status: 'HOLD', code, receipts: [], ...details };
}
function behaviorContainerName(fence, commandId) {
  const hash = createHash('sha256');
  for (const value of [
    fence?.runId,
    fence?.taskId,
    fence?.attempt,
    fence?.dispatchGeneration,
    fence?.fencingToken,
    commandId,
  ]) {
    hash.update(String(value ?? ''), 'utf8');
    hash.update(Buffer.from([0]));
  }
  return `ah-beh-${hash.digest('hex').slice(0, 40)}`;
}

function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function verifyCapabilityBounded(verifyCapability, request, {
  timeoutMs = 2_500,
  now = new Date(),
} = {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => verifyCapability(request, { now })),
      new Promise(resolve => {
        timer = setTimeout(
          () => resolve({ status: 'HOLD', code: 'docker_gateway_capability_check_timeout' }),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } catch {
    return { status: 'HOLD', code: 'docker_gateway_capability_verifier_unavailable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function executeBehaviorUnderCapabilityFence({
  request,
  input,
  options,
  verifyCapability,
  executeBehavior,
  externalSignal = null,
  pollIntervalMs = 500,
}) {
  const controller = new AbortController();
  const abortFromClient = () => controller.abort();
  externalSignal?.addEventListener('abort', abortFromClient, { once: true });
  let executionSettled = false;
  const execution = Promise.resolve()
    .then(() => executeBehavior(input, { ...options, signal: controller.signal }))
    .then(
      receipt => ({ ok: true, receipt }),
      error => ({ ok: false, error }),
    )
    .finally(() => { executionSettled = true; });

  try {
    while (!executionSettled) {
      const observed = await Promise.race([
        execution,
        delay(pollIntervalMs).then(() => null),
      ]);
      if (observed) {
        if (!observed.ok) {
          return {
            holdCode: controller.signal.aborted
              ? 'docker_gateway_behavior_revoked'
              : 'docker_gateway_behavior_execution_failed',
            receipt: null,
          };
        }
        const finalDecision = await verifyCapabilityBounded(verifyCapability, request, { now: new Date() });
        if (finalDecision?.status !== 'VERIFIED') {
          return { holdCode: finalDecision?.code ?? 'docker_gateway_capability_not_verified', receipt: observed.receipt };
        }
        return { holdCode: null, receipt: observed.receipt };
      }

      if (externalSignal?.aborted) {
        controller.abort();
        await execution;
        return { holdCode: 'docker_gateway_client_disconnected', receipt: null };
      }

      const decision = await verifyCapabilityBounded(verifyCapability, request, { now: new Date() });
      if (decision?.status !== 'VERIFIED') {
        controller.abort();
        await execution;
        return { holdCode: decision?.code ?? 'docker_gateway_capability_not_verified', receipt: null };
      }
    }

    const observed = await execution;
    if (!observed.ok) {
      return {
        holdCode: controller.signal.aborted
          ? 'docker_gateway_behavior_revoked'
          : 'docker_gateway_behavior_execution_failed',
        receipt: null,
      };
    }
    const finalDecision = await verifyCapabilityBounded(verifyCapability, request, { now: new Date() });
    return finalDecision?.status === 'VERIFIED'
      ? { holdCode: null, receipt: observed.receipt }
      : { holdCode: finalDecision?.code ?? 'docker_gateway_capability_not_verified', receipt: observed.receipt };
  } finally {
    externalSignal?.removeEventListener('abort', abortFromClient);
  }
}

function authority(configuration) {
  return {
    schemaVersion: 'command-authority/v1',
    projectId: configuration.descriptor.projectId,
    repositoryId: configuration.descriptor.repositoryId,
    sourceCommit: configuration.sourceCommit,
    sourceSnapshotSha256: configuration.sourceSnapshotSha256,
    descriptorDigest: configuration.descriptorDigest,
    policyDigest: configuration.policyDigest,
  };
}
function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
}
function authorityMatches(actual, expected) {
  return actual?.schemaVersion === expected?.schemaVersion
    && actual?.projectId === expected?.projectId
    && actual?.repositoryId === expected?.repositoryId
    && actual?.sourceCommit === expected?.sourceCommit
    && actual?.sourceSnapshotSha256 === expected?.sourceSnapshotSha256
    && actual?.descriptorDigest === expected?.descriptorDigest
    && actual?.policyDigest === expected?.policyDigest;
}
export function validateGatewayRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('docker_gateway_request_invalid');
  const keys = Object.keys(request).sort();
  const allowed = ['schemaVersion','commandAuthority','commandSpecIds','executionFence','workspacePath','capability'].sort();
  if (JSON.stringify(keys) !== JSON.stringify(allowed) || request.schemaVersion !== 'docker-behavior-gateway-request/v1') {
    throw new Error('docker_gateway_request_invalid');
  }
  if (!request.commandAuthority || request.commandAuthority.schemaVersion !== 'command-authority/v1') throw new Error('docker_gateway_command_authority_invalid');
  if (!Array.isArray(request.commandSpecIds) || request.commandSpecIds.length < 1 || request.commandSpecIds.length > MAX_COMMANDS
      || new Set(request.commandSpecIds).size !== request.commandSpecIds.length || request.commandSpecIds.some(id => !validId(id))) {
    throw new Error('docker_gateway_command_ids_invalid');
  }
  if (typeof request.workspacePath !== 'string' || !request.workspacePath) throw new Error('docker_gateway_workspace_invalid');
  if (!request.executionFence || request.executionFence.schemaVersion !== 'task-execution-fence/v1') throw new Error('docker_gateway_fence_invalid');
  if (typeof request.capability !== 'string' || !/^[a-f0-9]{64}$/u.test(request.capability)) throw new Error('docker_gateway_capability_invalid');
  return request;
}
export function workspaceSubpath(workspaceRoot, workspacePath) {
  const root = resolve(workspaceRoot);
  const workspace = resolve(workspacePath);
  const rel = relative(root, workspace).replaceAll('\\', '/');
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || rel.includes('/../') || rel.startsWith('/')) {
    throw new Error('docker_gateway_workspace_outside_root');
  }
  return rel;
}
export function discoverWorkspaceVolume({
  executeDocker = nativeDocker,
  gatewayContainerId = process.env.HOSTNAME,
  workspaceRoot = process.env.AGENT_HARNESS_AGENT_WORKSPACE_ROOT ?? '/workspace/agent-workspaces',
  cwd = process.cwd(),
} = {}) {
  if (!gatewayContainerId) throw new Error('docker_gateway_container_identity_missing');
  const result = executeDocker(['container','inspect','--format','{{json .Mounts}}',gatewayContainerId], { cwd, timeoutMs: 5_000 });
  if (result?.error || result?.status !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 131072) {
    throw new Error('docker_gateway_mount_inspect_failed');
  }
  let mounts;
  try { mounts = JSON.parse(result.stdout); } catch { throw new Error('docker_gateway_mount_inspect_invalid'); }
  const matches = (Array.isArray(mounts) ? mounts : []).filter(mount =>
    mount?.Type === 'volume' && mount?.Destination === workspaceRoot && typeof mount?.Name === 'string' && mount.Name);
  if (matches.length !== 1) throw new Error('docker_gateway_workspace_volume_ambiguous');
  return matches[0].Name;
}

export async function runBehaviorGateRequest(request, {
  projectRoot = process.env.AGENT_HARNESS_PROJECT_ROOT ?? '/workspace/repository',
  workspaceRoot = process.env.AGENT_HARNESS_AGENT_WORKSPACE_ROOT ?? '/workspace/agent-workspaces',
  loadConfiguration = loadCommittedProjectConfiguration,
  bindWorkspace = bindWorkspaceAuthorityInputs,
  materialize = probeDockerRunnerMaterialization,
  attestImage = probeDockerImageSourceAttestation,
  probeToolchain = probeDockerToolchainV2,
  executeBehavior = executeDockerBehaviorCommandV2Async,
  volumeResolver = discoverWorkspaceVolume,
  executeDocker = nativeDocker,
  verifyCapability = verifyWithDefaultCapabilityStore,
  signal = null,
  capabilityPollIntervalMs = 500,
  now = new Date(),
} = {}) {
  let checked;
  try { checked = validateGatewayRequest(request); }
  catch (error) { return hold(error?.message ?? 'docker_gateway_request_invalid'); }

  const capabilityDecision = await verifyCapabilityBounded(verifyCapability, checked, { now });
  if (capabilityDecision?.status !== 'VERIFIED') {
    return hold(capabilityDecision?.code ?? 'docker_gateway_capability_not_verified');
  }

  let configuration;
  try {
    configuration = loadConfiguration(projectRoot, { commit: checked.commandAuthority.sourceCommit });
  } catch {
    return hold('docker_gateway_committed_configuration_invalid');
  }
  if (!authorityMatches(authority(configuration), checked.commandAuthority)) {
    return hold('docker_gateway_command_authority_mismatch');
  }

  let subpath, workspaceBinding, volumeName;
  try {
    subpath = workspaceSubpath(workspaceRoot, checked.workspacePath);
    workspaceBinding = bindWorkspace(checked.workspacePath, configuration);
    if (workspaceBinding.status !== 'AUTHORITY_INPUTS_BOUND') return hold('docker_gateway_workspace_binding_hold');
    volumeName = volumeResolver({ executeDocker, workspaceRoot, cwd: projectRoot });
  } catch (error) {
    return hold(error?.message ?? 'docker_gateway_workspace_binding_failed');
  }

  const receipts = [];
  for (const commandId of checked.commandSpecIds) {
    const command = configuration.descriptor.commands.find(item => item.id === commandId) ?? null;
    const spec = command ? configuration.descriptor.runners.find(item => item.id === command.runnerId) ?? null : null;
    const sourceBinding = spec ? configuration.runnerSourceBindings.find(item => item.runnerId === spec.id) ?? null : null;
    if (!command || !spec || !sourceBinding) return hold('docker_gateway_command_not_found', { receipts });

    const materialized = materialize({ spec, sourceBinding }, { root: projectRoot, execute: executeDocker });
    if (materialized.status !== 'MATERIALIZED') return hold(materialized.code ?? 'docker_gateway_materialization_hold', { receipts });

    const attestation = attestImage({
      spec, sourceBinding, materialization: materialized.materialization,
    }, { root: projectRoot, execute: executeDocker });
    if (attestation.status !== 'ATTESTED') return hold(attestation.code ?? 'docker_gateway_image_attestation_hold', { receipts });

    const toolchainReceipt = probeToolchain({
      configuration,
      commandId,
      workspaceBinding,
      materialization: materialized.materialization,
    }, { root: projectRoot, execute: executeDocker });
    if (toolchainReceipt.status !== 'TOOLCHAIN_VERIFIED') {
      return hold(toolchainReceipt.code ?? 'docker_gateway_toolchain_hold', { receipts });
    }

    const supervised = await executeBehaviorUnderCapabilityFence({
      request: checked,
      input: {
        configuration,
        commandId,
        workspaceBinding,
        materialization: materialized.materialization,
        toolchainReceipt,
        imageSourceAttestation: attestation.attestation,
        executionFence: checked.executionFence,
        now: new Date(),
      },
      options: {
        root: projectRoot,
        reobserveExecute: executeDocker,
        workspaceMount: { type: 'volume', source: volumeName, subpath },
        containerName: behaviorContainerName(checked.executionFence, commandId),
      },
      verifyCapability,
      executeBehavior,
      externalSignal: signal,
      pollIntervalMs: capabilityPollIntervalMs,
    });
    if (supervised.holdCode) {
      return hold(supervised.holdCode, {
        receipts: supervised.receipt ? [...receipts, supervised.receipt] : receipts,
      });
    }
    const receipt = supervised.receipt;
    receipts.push(receipt);
    if (receipt.status !== 'BEHAVIOR_PASSED') {
      return {
        schemaVersion: 'docker-behavior-gateway-result/v1',
        status: receipt.status === 'BEHAVIOR_FAILED' ? 'FAILED' : 'HOLD',
        code: receipt.code ?? 'docker_gateway_behavior_not_passed',
        receipts,
      };
    }
  }

  return {
    schemaVersion: 'docker-behavior-gateway-result/v1',
    status: 'PASSED',
    code: 'docker_gateway_behavior_passed',
    receipts,
    commandAuthority: checked.commandAuthority,
    workspaceBindingDigest: workspaceBinding.workspaceBindingDigest,
  };
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > BODY_LIMIT) throw new Error('docker_gateway_body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export function createDockerGatewayServer({
  runGate = runBehaviorGateRequest,
} = {}) {
  return createServer(async (request, response) => {
    response.setHeader('content-type','application/json');
    if (request.method === 'GET' && request.url === '/health') {
      response.statusCode = 200;
      response.end(JSON.stringify({ status:'ok', service:'docker-behavior-gateway' }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/behavior') {
      response.statusCode = 404;
      response.end(JSON.stringify({ status:'error', code:'not_found' }));
      return;
    }
    const disconnect = new AbortController();
    const onResponseClose = () => {
      if (!response.writableEnded) disconnect.abort();
    };
    response.once('close', onResponseClose);
    try {
      const body = JSON.parse(await readBody(request));
      const result = await runGate(body, { signal: disconnect.signal });
      if (response.destroyed) return;
      response.statusCode = result.status === 'PASSED' ? 200 : 409;
      response.end(JSON.stringify(result));
    } catch (error) {
      if (response.destroyed) return;
      response.statusCode = 400;
      response.end(JSON.stringify({ status:'error', code:error?.message ?? 'docker_gateway_request_failed' }));
    } finally {
      response.removeListener('close', onResponseClose);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.AGENT_HARNESS_DOCKER_GATEWAY_PORT ?? 8792);
  const host = process.env.AGENT_HARNESS_DOCKER_GATEWAY_HOST ?? '0.0.0.0';
  const server = createDockerGatewayServer();
  server.listen(port, host, () => {
    process.stdout.write(JSON.stringify({ event:'docker_gateway.listening', host, port }) + '\n');
  });
}