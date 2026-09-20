import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateProjectDescriptor } from '../../harness-contracts/src/project-descriptor.mjs';
import { dockerRunnerDigest } from '../../harness-contracts/src/docker-runner.mjs';

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
  java: [{ capability: 'toolchain.java', executable: 'java', argv: ['-version'], parse: text => /^(?:openjdk|java) version "([^"]+)"(?:\r?\n[\s\S]*)?$/u.exec(text)?.[1] ?? null }],
  dotnet: [{ capability: 'toolchain.dotnet', executable: 'dotnet', argv: ['--version'], parse: text => /^(\d+\.\d+\.\d+(?:[-+][^\s]+)?)$/u.exec(text)?.[1] ?? null }],
});
const MAX_OUTPUT = 32768;
const RECEIPT_VERSION = 'docker-image-toolchain-receipt/v1';

function nativeDocker(argv, { cwd, timeoutMs }) {
  return spawnSync('docker', argv, { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, stdio: ['ignore','pipe','pipe'] });
}
function hashOutput(stdout, stderr) {
  return `sha256:${createHash('sha256').update(String(stdout ?? '')).update('\0').update(String(stderr ?? '')).digest('hex')}`;
}
function cleanOutput(result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT) return null;
  return { stdout, stderr, combined: `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trim() };
}
function requirements(languages) {
  const output = [];
  for (const language of languages) {
    if (language === 'docs') continue;
    const probes = PROBES[language];
    if (!probes) return { unsupported: language, groups: [] };
    if (language === 'python') output.push({ capability: 'toolchain.python', alternatives: probes });
    else if (language === 'rust') for (const probe of probes) output.push({ capability: probe.capability, alternatives: [probe] });
    else output.push({ capability: probes[0].capability, alternatives: probes });
  }
  return { unsupported: null, groups: output };
}
function identityMatches(runner, observation) {
  return observation && observation.schemaVersion === 'docker-identity-observation/v1'
    && observation.status === 'PARTIAL' && observation.runnerId === runner.id
    && observation.runnerDigest === dockerRunnerDigest(runner) && observation.imageId === runner.imageId
    && (runner.operation !== 'exec' || typeof observation.containerId === 'string');
}
function baseArgs(runner, probe) {
  return ['--context', runner.dockerContext, 'run', '--rm', '--pull', 'never', '--network', 'none',
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m,mode=1777',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', '64',
    '--platform', runner.platform, '--user', runner.user, '--workdir', runner.containerCwd,
    '--entrypoint', probe.executable, runner.imageId, ...probe.argv];
}

/**
 * Executes ONLY fixed adapter-owned version probes in the immutable image observed
 * for the declared Compose target. It never dispatches CommandSpec executable/argv.
 */
export function probeDockerImageToolchain({ descriptor, commandId, identityObservation }, { root = process.cwd(), execute = nativeDocker, timeoutMs = 60000 } = {}) {
  const checked = validateProjectDescriptor(descriptor);
  const command = checked.commands.find(item => item.id === commandId) ?? null;
  const runner = command ? checked.runners.find(item => item.id === command.runnerId) ?? null : null;
  const module = command ? checked.modules.find(item => item.id === command.moduleId) ?? null : null;
  const startedAt = new Date().toISOString();
  const base = {
    schemaVersion: RECEIPT_VERSION,
    status: 'HOLD',
    proofKind: 'docker-image-toolchain-probe',
    projectId: checked.projectId,
    commandId: command?.id ?? String(commandId ?? ''),
    moduleId: module?.id ?? null,
    runnerId: runner?.id ?? null,
    runnerDigest: runner ? dockerRunnerDigest(runner) : null,
    imageId: runner?.imageId ?? null,
    platform: runner?.platform ?? null,
    networkPolicy: 'none',
    tools: [],
    remoteCalls: 0,
    trustVerified: false,
    qualificationVerdict: null,
  };
  if (!command || !runner || !module) return { ...base, code: 'toolchain_target_invalid', startedAt, finishedAt: new Date().toISOString() };
  if (!identityMatches(runner, identityObservation)) return { ...base, code: 'toolchain_identity_observation_required', startedAt, finishedAt: new Date().toISOString() };
  const requested = requirements(module.languages);
  if (requested.unsupported) return { ...base, code: 'toolchain_language_unsupported', unsupportedLanguage: requested.unsupported, startedAt, finishedAt: new Date().toISOString() };
  if (requested.groups.length === 0) return { ...base, code: 'toolchain_probe_not_declared', startedAt, finishedAt: new Date().toISOString() };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) return { ...base, code: 'toolchain_timeout_invalid', startedAt, finishedAt: new Date().toISOString() };

  const deadline = performance.now() + timeoutMs;
  const tools = [];
  for (const group of requested.groups) {
    let accepted = null;
    for (const probe of group.alternatives) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) return { ...base, code: 'toolchain_probe_timeout', tools, startedAt, finishedAt: new Date().toISOString() };
      let result;
      try { result = execute(baseArgs(runner, probe), { cwd: root, timeoutMs: Math.min(remaining, 10000) }); }
      catch { result = { status: null, error: { code: 'EXEC_ERROR' }, stdout: '', stderr: '' }; }
      const output = cleanOutput(result);
      if (!output) return { ...base, code: 'toolchain_output_limit', tools, startedAt, finishedAt: new Date().toISOString() };
      if (result?.error?.code === 'ETIMEDOUT') return { ...base, code: 'toolchain_probe_timeout', tools, startedAt, finishedAt: new Date().toISOString() };
      if (result?.error?.code === 'ENOENT') return { ...base, code: 'docker_command_unavailable', tools, startedAt, finishedAt: new Date().toISOString() };
      if (result?.status !== 0) continue;
      const version = probe.parse(output.combined);
      if (!version) return { ...base, code: 'toolchain_version_unrecognized', tools, startedAt, finishedAt: new Date().toISOString() };
      accepted = { capability: group.capability, executable: probe.executable, version, outputSha256: hashOutput(output.stdout, output.stderr) };
      break;
    }
    if (!accepted) return { ...base, code: 'toolchain_capability_unavailable', missingCapability: group.capability, tools, startedAt, finishedAt: new Date().toISOString() };
    tools.push(accepted);
  }
  return { ...base, status: 'TOOLCHAIN_VERIFIED', code: 'docker_image_toolchain_verified', tools, startedAt, finishedAt: new Date().toISOString() };
}
