/** Read-only Docker identity observation. No exec, run, build, pull or cleanup. */
import { spawnSync } from 'node:child_process';
import { validateDockerRunnerRef, dockerRunnerDigest } from '../../harness-contracts/src/docker-runner.mjs';
import { projectRoot } from './safe-files.mjs';

const IMAGE_TEMPLATE = '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"variant":{{json (index . "Variant")}}}';
const CONTAINER_TEMPLATE = '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},"restartCount":{{json .RestartCount}},"startedAt":{{json .State.StartedAt}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"replica":{{json (index .Config.Labels "com.docker.compose.container-number")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}}}';
const isId = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
class ProbeError extends Error { constructor(code) { super(code); this.code = code; } }
function reject(code) { throw new ProbeError(code); }
function nativeDocker(argv, { timeoutMs, cwd }) {
  return spawnSync('docker', argv, { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 131072, stdio: ['ignore','pipe','pipe'] });
}

export function probeDockerIdentity(input, { root = process.cwd(), execute = nativeDocker, timeoutMs = 15000 } = {}) {
  const runner = validateDockerRunnerRef(input);
  const cwd = projectRoot(root);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) reject('docker_probe_timeout_invalid');
  const start = performance.now(); let calls = 0;
  const base = { schemaVersion: 'docker-identity-observation/v1', runnerId: runner.id, runnerDigest: dockerRunnerDigest(runner), toolchain: 'NOT_RUN', behavior: 'NOT_RUN', configurationVerified: false, sourceSnapshotVerified: false, mountsVerified: false, trustVerified: false, qualificationVerdict: null };
  function run(argv) {
    const remaining = Math.floor(timeoutMs - (performance.now() - start));
    if (remaining <= 0) reject('docker_probe_timeout');
    let result;
    try { calls++; result = execute(argv, { cwd, timeoutMs: Math.min(remaining, 3000) }); }
    catch { reject('docker_command_unavailable'); }
    if (result?.error?.code === 'ENOENT') reject('docker_command_unavailable');
    if (result?.error?.code === 'ETIMEDOUT') reject('docker_probe_timeout');
    if (result?.error || result?.status !== 0) reject('docker_command_failed');
    if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 131072) reject('docker_output_invalid');
    if (performance.now() - start >= timeoutMs) reject('docker_probe_timeout');
    return result.stdout;
  }
  function json(argv) { try { return JSON.parse(run(argv)); } catch (error) { if (error instanceof ProbeError) throw error; reject('docker_output_invalid'); } }
  function inspect(id) {
    const item = json(['--context',runner.dockerContext,'container','inspect','--format',CONTAINER_TEMPLATE,id]);
    if (!item || typeof item !== 'object' || item.id !== id || !isId(item.id) || typeof item.running !== 'boolean' || !Number.isSafeInteger(item.restartCount) || item.restartCount < 0 || typeof item.startedAt !== 'string') reject('docker_output_invalid');
    return item;
  }
  try {
    const daemon = json(['--context',runner.dockerContext,'info','--format','{{json .ID}}']);
    if (daemon !== runner.daemonId) reject('docker_daemon_mismatch');
    const image = json(['--context',runner.dockerContext,'image','inspect','--format',IMAGE_TEMPLATE,runner.imageId]);
    if (!image || image.id !== runner.imageId) reject('docker_image_mismatch');
    const [os, architecture, variant] = runner.platform.split('/');
    if (image.os !== os || image.architecture !== architecture || (variant && image.variant !== variant)) reject('docker_platform_mismatch');
    let containerId = null;
    if (runner.operation === 'exec') {
      const ids = run(['--context',runner.dockerContext,'ps','--all','--no-trunc','--quiet','--filter',`label=com.docker.compose.project=${runner.composeProject}`,'--filter',`label=com.docker.compose.service=${runner.service}`]).trim().split(/\r?\n/u).filter(Boolean);
      if (ids.length > 32 || ids.some(id => !isId(id)) || new Set(ids).size !== ids.length) reject('docker_output_invalid');
      const matches = ids.map(inspect).filter(c => c.project === runner.composeProject && c.service === runner.service && c.replica === String(runner.replica) && c.oneoff === 'False' && c.running);
      if (!matches.length) reject('docker_container_missing');
      if (matches.length !== 1) reject('docker_container_ambiguous');
      const before = matches[0];
      if (before.image !== runner.imageId) reject('docker_container_image_mismatch');
      const after = inspect(before.id);
      const keys = ['id','image','running','restartCount','startedAt','project','service','replica','oneoff'];
      if (keys.some(key => before[key] !== after[key])) reject('docker_container_changed');
      const currentIds = run(['--context',runner.dockerContext,'ps','--all','--no-trunc','--quiet','--filter',`label=com.docker.compose.project=${runner.composeProject}`,'--filter',`label=com.docker.compose.service=${runner.service}`]).trim().split(/\r?\n/u).filter(Boolean);
      if (JSON.stringify([...ids].sort()) !== JSON.stringify([...currentIds].sort())) reject('docker_container_changed');
      containerId = before.id;
    }
    return { ...base, status: 'PARTIAL', code: 'docker_identity_observed', imageId: runner.imageId, containerId, calls, elapsedMs: Math.max(0, performance.now() - start) };
  } catch (error) {
    return { ...base, status: 'HOLD', code: error instanceof ProbeError ? error.code : 'docker_probe_failed', imageId: null, containerId: null, calls, elapsedMs: Math.max(0, performance.now() - start) };
  }
}
