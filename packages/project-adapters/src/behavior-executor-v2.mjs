import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { posix } from 'node:path';

import { contractDigest, validateCommandSpec } from '../../harness-contracts/src/project-descriptor.mjs';
import {
  dockerRunnerMaterializationIdentityDigest,
  validateDockerRunnerMaterialization,
  validateDockerRunnerSourceBinding,
} from '../../harness-contracts/src/docker-runner-v2.mjs';
import { evaluateCommandReadiness } from './command-readiness.mjs';
import { probeDockerRunnerMaterialization } from './docker-materialization-v2.mjs';
import {
  dockerImageSourceAttestationIdentityDigest,
  validateDockerImageSourceAttestation,
} from '../../harness-contracts/src/image-source-attestation.mjs';
import {
  taskExecutionFenceIdentityDigest,
  validateActiveTaskExecutionFence,
} from '../../harness-contracts/src/execution-fence.mjs';

const MAX_OUTPUT_BYTES = 1024 * 1024;

function nativeDocker(argv, { cwd, timeoutMs }) {
  return spawnSync('docker', argv, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ['ignore','pipe','pipe'],
  });
}
function hashText(value) {
  return `sha256:${createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')}`;
}
function behaviorWorkdir(spec, command) {
  return command.cwd === '.' ? spec.containerCwd : posix.join(spec.containerCwd, command.cwd);
}
function validatedWorkspaceMount(value, spec) {
  if (value == null) return null;
  if (!value || value.type !== 'volume' || typeof value.source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/u.test(value.source)
      || typeof value.subpath !== 'string' || !value.subpath || value.subpath.startsWith('/') || value.subpath.includes('\\')
      || value.subpath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('behavior_workspace_mount_invalid');
  }
  return `type=volume,src=${value.source},dst=${spec.containerCwd},readonly,volume-subpath=${value.subpath}`;
}

function resultEvidence(result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
    return { ok: false, code: 'behavior_output_limit' };
  }
  return {
    ok: true,
    stdoutSha256: hashText(stdout),
    stderrSha256: hashText(stderr),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  };
}

export function evaluateBehaviorAdmission({
  configuration, commandId, workspaceBinding, materialization, toolchainReceipt,
  imageSourceAttestation, executionFence, now = new Date(),
}) {
  const readiness = evaluateCommandReadiness({
    configuration, commandId, workspaceBinding, materialization, toolchainReceipt,
  });
  const command = configuration?.descriptor?.commands?.find(item => item.id === commandId) ?? null;
  const runner = command
    ? configuration.descriptor.runners.find(item => item.id === command.runnerId) ?? null
    : null;
  const sourceBinding = runner
    ? configuration?.runnerSourceBindings?.find(item => item.runnerId === runner.id) ?? null
    : null;
  const reasons = [...(readiness.reasons ?? [])];
  let imageSourceAttestationIdentityDigest = null;
  if (!runner || !sourceBinding) {
    reasons.push('image-source-attestation-prerequisite-missing');
  } else {
    try {
      const checkedAttestation = validateDockerImageSourceAttestation(imageSourceAttestation, {
        spec: runner,
        sourceBinding,
        materialization,
      });
      imageSourceAttestationIdentityDigest = dockerImageSourceAttestationIdentityDigest(checkedAttestation, {
        spec: runner,
        sourceBinding,
        materialization,
      });
    } catch {
      reasons.push('image-source-attestation-invalid');
    }
  }
  let executionFenceIdentityDigest = null;
  try {
    const checkedFence = validateActiveTaskExecutionFence(executionFence, { now });
    executionFenceIdentityDigest = taskExecutionFenceIdentityDigest(checkedFence);
  } catch {
    reasons.push('task-execution-fence-invalid');
  }
  if (readiness.status !== 'TOOLCHAIN_READY') reasons.push('toolchain-readiness-required');
  if (!command || !runner) reasons.push('command-or-runner-missing');
  if (command?.phase !== 'behavior') reasons.push('behavior-phase-required');
  // WAVE-07 only authorizes a subset whose enforcement is complete with Docker
  // primitives available here. Running inside an existing service would inherit
  // its network/env/mount state, so exec remains HOLD rather than pretending.
  if (runner?.operation !== 'one-off') reasons.push('behavior-exec-runner-not-yet-enforceable');
  if (command?.networkPolicy !== 'none') reasons.push('behavior-network-policy-not-yet-enforceable');
  if (JSON.stringify(command?.effects ?? []) !== JSON.stringify(['read-only'])) reasons.push('behavior-effects-not-yet-enforceable');
  if ((command?.secretRefs ?? []).length > 0) reasons.push('behavior-secrets-not-yet-supported');
  if ((command?.envAllowlist ?? []).length > 0) reasons.push('behavior-env-not-yet-supported');
  if (command?.dependencyPolicy !== 'none') reasons.push('behavior-dependencies-not-yet-supported');
  if (!['workspace','container'].includes(command?.validationScope ?? '')) reasons.push('behavior-scope-not-enforceable');

  return {
    schemaVersion: 'behavior-admission/v1',
    status: reasons.length ? 'HOLD' : 'BEHAVIOR_AUTHORIZED',
    reasons: [...new Set(reasons)],
    projectId: configuration?.descriptor?.projectId ?? null,
    commandId: String(commandId ?? ''),
    commandDigest: command ? contractDigest(validateCommandSpec(command)) : null,
    runnerId: runner?.id ?? null,
    sourceCommit: configuration?.sourceCommit ?? null,
    sourceSnapshotSha256: configuration?.sourceSnapshotSha256 ?? null,
    workspaceBindingDigest: workspaceBinding?.workspaceBindingDigest ?? null,
    materializationIdentityDigest: readiness.materializationIdentityDigest ?? null,
    imageSourceAttestationIdentityDigest,
    executionFenceIdentityDigest,
    toolchainVerified: readiness.toolchainVerified === true,
    effectsEnforced: reasons.length === 0,
    networkEnforced: reasons.length === 0,
    secretsResolved: reasons.length === 0,
    behaviorAuthorized: reasons.length === 0,
    executableNow: reasons.length === 0,
    qualificationVerdict: null,
  };
}

function validatedContainerName(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)) {
    throw new Error('behavior_container_name_invalid');
  }
  return value;
}

function prepareDockerBehaviorExecutionV2(input, { workspaceMount = null, containerName = null } = {}) {
  const admission = evaluateBehaviorAdmission(input);
  const configuration = input.configuration;
  const command = configuration?.descriptor?.commands?.find(item => item.id === input.commandId) ?? null;
  const spec = command
    ? configuration.descriptor.runners.find(item => item.id === command.runnerId) ?? null
    : null;
  const sourceBinding = spec
    ? configuration.runnerSourceBindings.find(item => item.runnerId === spec.id) ?? null
    : null;

  const base = {
    schemaVersion: 'behavior-execution-receipt/v1',
    status: 'HOLD',
    admission,
    projectId: admission.projectId,
    commandId: admission.commandId,
    commandDigest: admission.commandDigest,
    runnerId: admission.runnerId,
    sourceCommit: admission.sourceCommit,
    sourceSnapshotSha256: admission.sourceSnapshotSha256,
    workspaceBindingDigest: admission.workspaceBindingDigest,
    materializationIdentityDigest: admission.materializationIdentityDigest,
    imageSourceAttestationIdentityDigest: admission.imageSourceAttestationIdentityDigest,
    executionFenceIdentityDigest: admission.executionFenceIdentityDigest,
    qualificationVerdict: null,
  };
  if (admission.status !== 'BEHAVIOR_AUTHORIZED' || !command || !spec || !sourceBinding) {
    return { ok: false, receipt: { ...base, code: 'behavior_not_authorized', executed: false } };
  }

  let checkedBinding, checkedMaterialization;
  try {
    checkedBinding = validateDockerRunnerSourceBinding(sourceBinding, { spec });
    checkedMaterialization = validateDockerRunnerMaterialization(input.materialization, {
      spec, sourceBinding: checkedBinding,
    });
  } catch {
    return { ok: false, receipt: { ...base, code: 'behavior_materialization_invalid', executed: false } };
  }

  let mountArg = null, checkedContainerName = null;
  try {
    mountArg = validatedWorkspaceMount(workspaceMount, spec);
    checkedContainerName = validatedContainerName(containerName);
  } catch (error) {
    return {
      ok: false,
      receipt: {
        ...base,
        code: error?.message === 'behavior_container_name_invalid'
          ? 'behavior_container_name_invalid'
          : 'behavior_workspace_mount_invalid',
        executed: false,
      },
    };
  }

  const argv = [
    '--context', spec.dockerContext,
    'run', '--rm', '--pull', 'never',
    ...(checkedContainerName ? ['--name', checkedContainerName] : []),
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges=true',
    '--pids-limit', '128',
    '--platform', spec.platform,
    '--user', spec.user,
    ...(mountArg ? ['--mount', mountArg] : []),
    '--workdir', behaviorWorkdir(spec, command),
    '--entrypoint', command.executable,
    checkedMaterialization.imageId,
    ...command.argv,
  ];

  return {
    ok: true,
    base,
    command,
    spec,
    checkedBinding,
    checkedMaterialization,
    argv,
    containerName: checkedContainerName,
  };
}

function completeDockerBehaviorExecutionV2(prepared, result, {
  root,
  execute,
  reobserve,
} = {}) {
  const { base, command, spec, checkedBinding, checkedMaterialization } = prepared;
  const evidence = resultEvidence(result);
  if (!evidence.ok || result?.error?.code === 'MAX_BUFFER') {
    return { ...base, code: 'behavior_output_limit', executed: true };
  }
  if (result?.error?.code === 'ETIMEDOUT') {
    return { ...base, code: 'behavior_timeout', executed: true, ...evidence };
  }
  if (result?.error?.code === 'ABORT_ERR') {
    return { ...base, code: 'behavior_execution_aborted', executed: true, ...evidence };
  }
  if (result?.error?.code === 'ENOENT') {
    return { ...base, code: 'docker_command_unavailable', executed: false, ...evidence };
  }
  if (result?.error || !Number.isInteger(result?.status)) {
    return { ...base, code: 'behavior_execution_failed', executed: true, ...evidence };
  }

  const after = reobserve({ spec, sourceBinding: checkedBinding }, {
    root, execute, timeoutMs: Math.min(20_000, command.timeoutMs),
  });
  if (after.status !== 'MATERIALIZED') {
    return { ...base, code: 'behavior_materialization_lost', executed: true, exitCode: result.status, ...evidence };
  }
  const beforeIdentity = dockerRunnerMaterializationIdentityDigest(checkedMaterialization, {
    spec, sourceBinding: checkedBinding,
  });
  const afterIdentity = dockerRunnerMaterializationIdentityDigest(after.materialization, {
    spec, sourceBinding: checkedBinding,
  });
  if (beforeIdentity !== afterIdentity) {
    return { ...base, code: 'behavior_materialization_changed', executed: true, exitCode: result.status, ...evidence };
  }

  return {
    ...base,
    status: result.status === 0 ? 'BEHAVIOR_PASSED' : 'BEHAVIOR_FAILED',
    code: result.status === 0 ? 'behavior_passed' : 'behavior_failed',
    executed: true,
    exitCode: result.status,
    stdoutSha256: evidence.stdoutSha256,
    stderrSha256: evidence.stderrSha256,
    stdoutBytes: evidence.stdoutBytes,
    stderrBytes: evidence.stderrBytes,
    materializationIdentityDigest: beforeIdentity,
    trustVerified: true,
  };
}

function removeNamedContainer(dockerContext, containerName, { cwd }) {
  if (!containerName) return;
  try {
    spawnSync('docker', ['--context', dockerContext, 'rm', '-f', containerName], {
      cwd,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore','ignore','ignore'],
    });
  } catch {
    // Cleanup is best effort here; the caller treats cancellation as fail-closed
    // and subsequent same-fence launches use the same name, preventing overlap.
  }
}

async function verifyNamedContainerRemovedAfterAbort(dockerContext, containerName, { cwd }) {
  // A killed Docker CLI may have already submitted create/run to the daemon.
  // Reap the fence-bound name more than once before reporting cancellation so a
  // late daemon-side create cannot outlive the revoked authority window.
  for (const delayMs of [0, 100, 400, 1_000]) {
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    removeNamedContainer(dockerContext, containerName, { cwd });
  }
}

function nativeDockerAsync(argv, {
  cwd,
  timeoutMs,
  signal,
  containerName,
  dockerContext,
}) {
  if (signal?.aborted) {
    return Promise.resolve({ status: null, stdout: '', stderr: '', error: { code: 'ABORT_ERR' } });
  }
  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let outputLimit = false;
    let childError = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    let child;
    const finishCleanup = () => removeNamedContainer(dockerContext, containerName, { cwd });
    const stop = reason => {
      if (settled) return;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'abort') aborted = true;
      if (reason === 'output') outputLimit = true;
      try { child?.kill('SIGKILL'); } catch {}
      // Race-safe double cleanup: once immediately, then again after the CLI
      // closes in case the daemon created the named container concurrently.
      finishCleanup();
    };
    const collect = (target, chunk, kind) => {
      const bytes = Buffer.byteLength(chunk);
      if (kind === 'stdout') stdoutBytes += bytes;
      else stderrBytes += bytes;
      if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) {
        stop('output');
        return;
      }
      target.push(Buffer.from(chunk));
    };
    try {
      child = spawn('docker', argv, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore','pipe','pipe'],
      });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error: { code: error?.code ?? 'EXEC_ERROR' } });
      return;
    }
    child.stdout?.on('data', chunk => collect(stdout, chunk, 'stdout'));
    child.stderr?.on('data', chunk => collect(stderr, chunk, 'stderr'));
    child.on('error', error => { childError = error; });
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    timer.unref?.();
    const onAbort = () => stop('abort');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', async (code, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (aborted || timedOut || outputLimit) {
        await verifyNamedContainerRemovedAfterAbort(dockerContext, containerName, { cwd });
      }
      resolve({
        status: Number.isInteger(code) ? code : null,
        signal: childSignal ?? null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        error: aborted
          ? { code: 'ABORT_ERR' }
          : timedOut
            ? { code: 'ETIMEDOUT' }
            : outputLimit
              ? { code: 'MAX_BUFFER' }
              : childError
                ? { code: childError.code ?? 'EXEC_ERROR' }
                : null,
      });
    });
  });
}

export function executeDockerBehaviorCommandV2(input, {
  root = process.cwd(),
  execute = nativeDocker,
  reobserve = probeDockerRunnerMaterialization,
  workspaceMount = null,
  containerName = null,
} = {}) {
  const prepared = prepareDockerBehaviorExecutionV2(input, { workspaceMount, containerName });
  if (!prepared.ok) return prepared.receipt;

  let result;
  try {
    result = execute(prepared.argv, { cwd: root, timeoutMs: prepared.command.timeoutMs });
  } catch {
    result = { status: null, stdout: '', stderr: '', error: { code: 'EXEC_ERROR' } };
  }
  return completeDockerBehaviorExecutionV2(prepared, result, {
    root,
    execute,
    reobserve,
  });
}

export async function executeDockerBehaviorCommandV2Async(input, {
  root = process.cwd(),
  execute = nativeDockerAsync,
  reobserve = probeDockerRunnerMaterialization,
  reobserveExecute = nativeDocker,
  workspaceMount = null,
  containerName,
  signal,
} = {}) {
  if (!containerName) {
    const admission = evaluateBehaviorAdmission(input);
    return {
      schemaVersion: 'behavior-execution-receipt/v1',
      status: 'HOLD',
      code: 'behavior_container_name_required',
      executed: false,
      admission,
      projectId: admission.projectId,
      commandId: admission.commandId,
      commandDigest: admission.commandDigest,
      runnerId: admission.runnerId,
      sourceCommit: admission.sourceCommit,
      sourceSnapshotSha256: admission.sourceSnapshotSha256,
      workspaceBindingDigest: admission.workspaceBindingDigest,
      materializationIdentityDigest: admission.materializationIdentityDigest,
      imageSourceAttestationIdentityDigest: admission.imageSourceAttestationIdentityDigest,
      executionFenceIdentityDigest: admission.executionFenceIdentityDigest,
      qualificationVerdict: null,
    };
  }
  const prepared = prepareDockerBehaviorExecutionV2(input, { workspaceMount, containerName });
  if (!prepared.ok) return prepared.receipt;

  let result;
  try {
    result = await execute(prepared.argv, {
      cwd: root,
      timeoutMs: prepared.command.timeoutMs,
      signal,
      containerName: prepared.containerName,
      dockerContext: prepared.spec.dockerContext,
    });
  } catch (error) {
    result = {
      status: null,
      stdout: '',
      stderr: '',
      error: { code: signal?.aborted ? 'ABORT_ERR' : (error?.code ?? 'EXEC_ERROR') },
    };
  }
  return completeDockerBehaviorExecutionV2(prepared, result, {
    root,
    execute: reobserveExecute,
    reobserve,
  });
}
