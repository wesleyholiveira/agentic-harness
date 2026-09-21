import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  dockerRunnerMaterializationIdentityDigest, dockerRunnerSpecDigest,
  validateDockerRunnerMaterialization, validateDockerRunnerSourceBinding, validateDockerRunnerSpec,
} from '../../harness-contracts/src/docker-runner-v2.mjs';
import { validateProjectDescriptorV2 } from '../../harness-contracts/src/project-descriptor-v2.mjs';
import { probeDockerRunnerMaterialization } from './docker-materialization-v2.mjs';
import { workspaceBindingMatchesRunner } from './workspace-binding.mjs';

const PROBES = Object.freeze({
  node: [{ capability: 'toolchain.node', executable: 'node', argv: ['--version'], parse: text => /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(text)?.[1] ?? null }],
  python: [
    { capability: 'toolchain.python', executable: 'python', argv: ['--version'], parse: text => /^Python (\d+\.\d+\.\d+(?:[^\s]*)?)$/u.exec(text)?.[1] ?? null },
    { capability: 'toolchain.python', executable: 'python3', argv: ['--version'], parse: text => /^Python (\d+\.\d+\.\d+(?:[^\s]*)?)$/u.exec(text)?.[1] ?? null },
  ],
  rust: [
    { capability: 'toolchain.rustc', executable: 'rustc', argv: ['--version'], parse: text => /^rustc ([^\s]+)(?:\s.*)?$/u.exec(text)?.[1] ?? null },
    { capability: 'toolchain.cargo', executable: 'cargo', argv: ['--version'], parse: text => /^cargo ([^\s]+)(?:\s.*)?$/u.exec(text)?.[1] ?? null },
  ],
  go: [{ capability: 'toolchain.go', executable: 'go', argv: ['version'], parse: text => /^go version go([^\s]+)\s+[^\s]+$/u.exec(text)?.[1] ?? null }],
  java: [{ capability: 'toolchain.java', executable: 'java', argv: ['-version'], parse: text => /^(?:openjdk|java) version "([^"]+)"[^\r\n]*(?:\r?\n[\s\S]*)?$/u.exec(text)?.[1] ?? null }],
  dotnet: [{ capability: 'toolchain.dotnet', executable: 'dotnet', argv: ['--version'], parse: text => /^(\d+\.\d+\.\d+(?:[-+][^\s]+)?)$/u.exec(text)?.[1] ?? null }],
});
const MAX_OUTPUT = 32768;

function nativeDocker(argv, { cwd, timeoutMs }) {
  return spawnSync('docker', argv, { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, stdio: ['ignore','pipe','pipe'] });
}
function hashOutput(stdout, stderr) {
  return `sha256:${createHash('sha256').update(String(stdout ?? '')).update('\0').update(String(stderr ?? '')).digest('hex')}`;
}
function clean(result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT) return null;
  return { stdout, stderr, combined: `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trim() };
}
function required(languages) {
  const groups = [];
  for (const language of languages) {
    if (language === 'docs') continue;
    const probes = PROBES[language];
    if (!probes) return { unsupported: language, groups: [] };
    if (language === 'python') groups.push({ capability: 'toolchain.python', alternatives: probes });
    else if (language === 'rust') probes.forEach(probe => groups.push({ capability: probe.capability, alternatives: [probe] }));
    else groups.push({ capability: probes[0].capability, alternatives: probes });
  }
  return { unsupported: null, groups };
}
function argsFor(spec, materialization, probe) {
  if (spec.operation === 'exec') {
    return ['--context', spec.dockerContext, 'exec', '--user', spec.user,
      '--workdir', spec.containerCwd, materialization.containerId, probe.executable, ...probe.argv];
  }
  return ['--context', spec.dockerContext, 'run', '--rm', '--pull', 'never', '--network', 'none',
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m,mode=1777', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges=true', '--pids-limit', '64', '--platform', spec.platform,
    '--user', spec.user, '--workdir', spec.containerCwd, '--entrypoint', probe.executable,
    materialization.imageId, ...probe.argv];
}

export function probeDockerToolchainV2({
  configuration, commandId, workspaceBinding, materialization,
}, {
  root = process.cwd(), execute = nativeDocker, timeoutMs = 60000,
  reobserve = probeDockerRunnerMaterialization,
} = {}) {
  const descriptor = validateProjectDescriptorV2(configuration?.descriptor);
  const command = descriptor.commands.find(item => item.id === commandId) ?? null;
  const module = command ? descriptor.modules.find(item => item.id === command.moduleId) ?? null : null;
  const spec = command ? descriptor.runners.find(item => item.id === command.runnerId) ?? null : null;
  const sourceBinding = spec ? configuration.runnerSourceBindings.find(item => item.runnerId === spec.id) ?? null : null;
  const base = {
    schemaVersion: 'docker-toolchain-receipt/v2',
    status: 'HOLD',
    projectId: descriptor.projectId,
    commandId: command?.id ?? String(commandId ?? ''),
    runnerId: spec?.id ?? null,
    sourceCommit: configuration?.sourceCommit ?? null,
    sourceSnapshotSha256: configuration?.sourceSnapshotSha256 ?? null,
    workspaceBindingDigest: workspaceBinding?.workspaceBindingDigest ?? null,
    runnerSpecDigest: spec ? dockerRunnerSpecDigest(spec) : null,
    tools: [],
    remoteCalls: 0,
    trustVerified: false,
    qualificationVerdict: null,
  };
  if (!command || !module || !spec || !sourceBinding
      || configuration?.schemaVersion !== 'committed-project-configuration/v1'
      || configuration?.sourceTrustVerified !== true
      || configuration?.policyTrustVerified !== true
      || !workspaceBindingMatchesRunner({ configuration, workspaceBinding, runnerId: spec?.id })) {
    return { ...base, code: 'toolchain_v2_prerequisite_missing' };
  }
  let checkedBinding, checkedMaterialization;
  try {
    checkedBinding = validateDockerRunnerSourceBinding(sourceBinding, { spec });
    checkedMaterialization = validateDockerRunnerMaterialization(materialization, { spec, sourceBinding: checkedBinding });
  } catch {
    return { ...base, code: 'toolchain_v2_materialization_invalid' };
  }
  if (workspaceBinding.sourceCommit !== configuration.sourceCommit
      || workspaceBinding.sourceSnapshotSha256 !== configuration.sourceSnapshotSha256
      || workspaceBinding.projectId !== descriptor.projectId) return { ...base, code: 'toolchain_v2_workspace_binding_mismatch' };

  const materializationIdentity = dockerRunnerMaterializationIdentityDigest(checkedMaterialization, { spec, sourceBinding: checkedBinding });
  const requested = required(module.languages);
  if (requested.unsupported) return { ...base, code: 'toolchain_v2_language_unsupported', unsupportedLanguage: requested.unsupported, materializationIdentityDigest: materializationIdentity };
  if (!requested.groups.length) return { ...base, code: 'toolchain_v2_probe_not_declared', materializationIdentityDigest: materializationIdentity };

  const deadline = performance.now() + timeoutMs;
  const tools = [];
  for (const group of requested.groups) {
    let accepted = null;
    for (const probe of group.alternatives) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) return { ...base, code: 'toolchain_v2_timeout', tools, materializationIdentityDigest: materializationIdentity };
      let result;
      try { result = execute(argsFor(spec, checkedMaterialization, probe), { cwd: root, timeoutMs: Math.min(remaining, 10000) }); }
      catch { result = { status: null, error: { code: 'EXEC_ERROR' }, stdout: '', stderr: '' }; }
      const output = clean(result);
      if (!output) return { ...base, code: 'toolchain_v2_output_limit', tools, materializationIdentityDigest: materializationIdentity };
      if (result?.error?.code === 'ETIMEDOUT') return { ...base, code: 'toolchain_v2_timeout', tools, materializationIdentityDigest: materializationIdentity };
      if (result?.error?.code === 'ENOENT') return { ...base, code: 'docker_command_unavailable', tools, materializationIdentityDigest: materializationIdentity };
      if (result?.status !== 0) continue;
      const version = probe.parse(output.combined);
      if (!version) return { ...base, code: 'toolchain_v2_version_unrecognized', tools, materializationIdentityDigest: materializationIdentity };
      accepted = { capability: group.capability, executable: probe.executable, version, outputSha256: hashOutput(output.stdout, output.stderr) };
      break;
    }
    if (!accepted) return { ...base, code: 'toolchain_v2_capability_unavailable', missingCapability: group.capability, tools, materializationIdentityDigest: materializationIdentity };
    tools.push(accepted);
  }

  const remainingForReobserve = Math.floor(deadline - performance.now());
  if (remainingForReobserve <= 0) return { ...base, code: 'toolchain_v2_timeout', tools, materializationIdentityDigest: materializationIdentity };
  const after = reobserve(
    { spec, sourceBinding: checkedBinding },
    { root, execute, timeoutMs: Math.min(20000, remainingForReobserve) },
  );
  if (after.status !== 'MATERIALIZED') return { ...base, code: 'toolchain_v2_materialization_lost', tools, materializationIdentityDigest: materializationIdentity };
  const afterIdentity = dockerRunnerMaterializationIdentityDigest(after.materialization, { spec, sourceBinding: checkedBinding });
  if (afterIdentity !== materializationIdentity) return { ...base, code: 'toolchain_v2_materialization_changed', tools, materializationIdentityDigest: materializationIdentity };

  return {
    ...base,
    status: 'TOOLCHAIN_VERIFIED',
    code: 'docker_toolchain_v2_verified',
    tools,
    materializationIdentityDigest: materializationIdentity,
    containerId: checkedMaterialization.containerId,
    imageId: checkedMaterialization.imageId,
    trustVerified: true,
  };
}
