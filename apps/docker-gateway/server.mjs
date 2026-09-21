#!/usr/bin/env node
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadCommittedProjectConfiguration } from '../../packages/project-adapters/src/trusted-config.mjs';
import { bindWorkspaceAuthorityInputs } from '../../packages/project-adapters/src/workspace-binding.mjs';
import { probeDockerRunnerMaterialization } from '../../packages/project-adapters/src/docker-materialization-v2.mjs';
import { probeDockerToolchainV2 } from '../../packages/project-adapters/src/docker-toolchain-v2.mjs';
import { probeDockerImageSourceAttestation } from '../../packages/project-adapters/src/docker-image-attestation.mjs';
import { executeDockerBehaviorCommandV2 } from '../../packages/project-adapters/src/behavior-executor-v2.mjs';
import { spawnSync } from 'node:child_process';

const BODY_LIMIT = 128 * 1024;
const MAX_COMMANDS = 32;

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
  const allowed = ['schemaVersion','commandAuthority','commandSpecIds','executionFence','workspacePath'].sort();
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
  executeBehavior = executeDockerBehaviorCommandV2,
  volumeResolver = discoverWorkspaceVolume,
  executeDocker = nativeDocker,
  now = new Date(),
} = {}) {
  let checked;
  try { checked = validateGatewayRequest(request); }
  catch (error) { return hold(error?.message ?? 'docker_gateway_request_invalid'); }

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

    const receipt = executeBehavior({
      configuration,
      commandId,
      workspaceBinding,
      materialization: materialized.materialization,
      toolchainReceipt,
      imageSourceAttestation: attestation.attestation,
      executionFence: checked.executionFence,
      now,
    }, {
      root: projectRoot,
      execute: executeDocker,
      workspaceMount: { type: 'volume', source: volumeName, subpath },
    });
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

function authorized(request, token) {
  const header = String(request.headers.authorization ?? '');
  if (!header.startsWith('Bearer ') || !token) return false;
  const supplied = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
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
  token = process.env.AGENT_HARNESS_DOCKER_GATEWAY_TOKEN ?? '',
  runGate = runBehaviorGateRequest,
} = {}) {
  if (Buffer.byteLength(token) < 32) throw new Error('docker_gateway_token_required');
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
    if (!authorized(request, token)) {
      response.statusCode = 401;
      response.end(JSON.stringify({ status:'error', code:'unauthorized' }));
      return;
    }
    try {
      const body = JSON.parse(await readBody(request));
      const result = await runGate(body);
      response.statusCode = result.status === 'PASSED' ? 200 : 409;
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ status:'error', code:error?.message ?? 'docker_gateway_request_failed' }));
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