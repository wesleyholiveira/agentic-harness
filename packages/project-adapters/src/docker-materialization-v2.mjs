import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  dockerRunnerSourceBindingDigest, dockerRunnerSpecDigest,
  validateDockerRunnerMaterialization, validateDockerRunnerSourceBinding, validateDockerRunnerSpec,
} from '../../harness-contracts/src/docker-runner-v2.mjs';
import { DOCKER_IMAGE_SOURCE_LABELS } from '../../harness-contracts/src/docker-source-labels.mjs';
import { projectRoot } from './safe-files.mjs';

const IMAGE_TEMPLATE = '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"variant":{{json (index . "Variant")}}}';
const CONTAINER_TEMPLATE = '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},"restartCount":{{json .RestartCount}},"startedAt":{{json .State.StartedAt}},"platform":{{json .Platform}},"user":{{json .Config.User}},"workingDir":{{json .Config.WorkingDir}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"replica":{{json (index .Config.Labels "com.docker.compose.container-number")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"mounts":{{json .Mounts}}}';
const ID = /^[a-f0-9]{64}$/u;

function digest(value) {
  const canonical = item => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]));
    return item;
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}
function nativeDocker(argv, { cwd, timeoutMs }) {
  return spawnSync('docker', argv, { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 262144, stdio: ['ignore','pipe','pipe'] });
}
class ProbeError extends Error { constructor(code) { super(code); this.code = code; } }
function reject(code) { throw new ProbeError(code); }
function safeMountProjection(mounts) {
  if (!Array.isArray(mounts) || mounts.length > 128) reject('docker_materialization_mounts_invalid');
  return mounts.map(mount => {
    if (!mount || typeof mount !== 'object' || typeof mount.Type !== 'string' || typeof mount.Destination !== 'string' || typeof mount.RW !== 'boolean') {
      reject('docker_materialization_mounts_invalid');
    }
    return {
      type: mount.Type,
      destination: mount.Destination,
      rw: mount.RW,
      ...(mount.Type === 'volume' && typeof mount.Name === 'string' ? { volumeName: mount.Name } : {}),
    };
  }).sort((a,b) => Buffer.compare(Buffer.from(a.destination), Buffer.from(b.destination)));
}
function parseJson(result) {
  if (result?.error?.code === 'ENOENT') reject('docker_command_unavailable');
  if (result?.error?.code === 'ETIMEDOUT') reject('docker_materialization_timeout');
  if (result?.error || result?.status !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 262144) reject('docker_materialization_command_failed');
  try { return JSON.parse(result.stdout); } catch { reject('docker_materialization_output_invalid'); }
}
function parseIds(result) {
  if (result?.error?.code === 'ENOENT') reject('docker_command_unavailable');
  if (result?.error?.code === 'ETIMEDOUT') reject('docker_materialization_timeout');
  if (result?.error || result?.status !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 131072) reject('docker_materialization_command_failed');
  const ids = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
  if (ids.length > 32 || ids.some(id => !ID.test(id)) || new Set(ids).size !== ids.length) reject('docker_materialization_output_invalid');
  return ids;
}
function parseImageIds(result) {
  if (result?.error?.code === 'ENOENT') reject('docker_command_unavailable');
  if (result?.error?.code === 'ETIMEDOUT') reject('docker_materialization_timeout');
  if (result?.error || result?.status !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 131072) reject('docker_materialization_command_failed');
  const ids = [...new Set(result.stdout.trim().split(/\r?\n/u).filter(Boolean))];
  if (ids.length > 32 || ids.some(id => !/^sha256:[a-f0-9]{64}$/u.test(id))) reject('docker_materialization_output_invalid');
  return ids;
}
function platformMatches(expected, image) {
  const [os, arch, variant] = expected.split('/');
  return image?.os === os && image?.architecture === arch && (!variant || image?.variant === variant);
}
function publicConfigDigest(spec, container) {
  return digest({
    schemaVersion: 'docker-public-config/v1',
    composeProject: spec.composeProject,
    service: spec.service,
    replica: spec.replica,
    operation: spec.operation,
    purpose: spec.purpose,
    user: container?.user ?? spec.user,
    workingDir: container?.workingDir ?? spec.containerCwd,
    platform: spec.platform,
  });
}

/** Read-only live observation. It does not execute project/toolchain commands. */
export function probeDockerRunnerMaterialization({ spec, sourceBinding }, {
  root = process.cwd(),
  execute = nativeDocker,
  timeoutMs = 20000,
} = {}) {
  const checkedSpec = validateDockerRunnerSpec(spec);
  const checkedBinding = validateDockerRunnerSourceBinding(sourceBinding, { spec: checkedSpec });
  const cwd = projectRoot(root);
  const started = performance.now();
  let calls = 0;
  const run = (argv, limit = 4000) => {
    const remaining = Math.floor(timeoutMs - (performance.now() - started));
    if (remaining <= 0) reject('docker_materialization_timeout');
    calls++;
    return execute(argv, { cwd, timeoutMs: Math.min(remaining, limit) });
  };
  const base = {
    schemaVersion: 'docker-materialization-observation/v1',
    status: 'HOLD',
    runnerId: checkedSpec.id,
    runnerSpecDigest: dockerRunnerSpecDigest(checkedSpec),
    sourceBindingDigest: dockerRunnerSourceBindingDigest(checkedBinding, { spec: checkedSpec }),
    sourceSnapshotSha256: checkedBinding.sourceSnapshotSha256,
    calls,
    qualificationVerdict: null,
  };
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) reject('docker_materialization_timeout_invalid');
    const daemonId = parseJson(run(['--context', checkedSpec.dockerContext, 'info', '--format', '{{json .ID}}']));
    if (typeof daemonId !== 'string' || !daemonId) reject('docker_materialization_daemon_invalid');

    let imageId, containerId = null, configPublicSha256, mountsSha256;
    if (checkedSpec.operation === 'exec') {
      const ids = parseIds(run([
        '--context', checkedSpec.dockerContext, 'ps', '--all', '--no-trunc', '--quiet',
        '--filter', `label=com.docker.compose.project=${checkedSpec.composeProject}`,
        '--filter', `label=com.docker.compose.service=${checkedSpec.service}`,
      ]));
      const inspect = id => parseJson(run(['--context', checkedSpec.dockerContext, 'container', 'inspect', '--format', CONTAINER_TEMPLATE, id]));
      const matches = ids.map(inspect).filter(item =>
        item?.id && ID.test(item.id) && item.project === checkedSpec.composeProject && item.service === checkedSpec.service
        && item.replica === String(checkedSpec.replica) && item.oneoff === 'False' && item.running === true);
      if (!matches.length) reject('docker_materialization_container_missing');
      if (matches.length !== 1) reject('docker_materialization_container_ambiguous');
      const before = matches[0];
      if (before.user !== checkedSpec.user || before.workingDir !== checkedSpec.containerCwd) reject('docker_materialization_container_config_mismatch');
      imageId = before.image;
      if (typeof imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(imageId)) reject('docker_materialization_image_invalid');
      const image = parseJson(run(['--context', checkedSpec.dockerContext, 'image', 'inspect', '--format', IMAGE_TEMPLATE, imageId]));
      if (image.id !== imageId || !platformMatches(checkedSpec.platform, image)) reject('docker_materialization_platform_mismatch');
      containerId = before.id;
      const safeMounts = safeMountProjection(before.mounts);
      configPublicSha256 = publicConfigDigest(checkedSpec, before);
      mountsSha256 = digest({ schemaVersion: 'docker-mount-projection/v1', mounts: safeMounts });

      const after = inspect(containerId);
      const fields = ['id','image','running','restartCount','startedAt','project','service','replica','oneoff','user','workingDir'];
      if (fields.some(field => before[field] !== after[field])
          || digest({ mounts: safeMountProjection(after.mounts) }) !== digest({ mounts: safeMounts })) reject('docker_materialization_container_changed');
      const currentIds = parseIds(run([
        '--context', checkedSpec.dockerContext, 'ps', '--all', '--no-trunc', '--quiet',
        '--filter', `label=com.docker.compose.project=${checkedSpec.composeProject}`,
        '--filter', `label=com.docker.compose.service=${checkedSpec.service}`,
      ]));
      if (JSON.stringify([...ids].sort()) !== JSON.stringify([...currentIds].sort())) reject('docker_materialization_container_changed');
    } else {
      let imageRef = checkedSpec.image.reference;
      if (checkedSpec.image.mode === 'source-attested-build') {
        const expectedRunner = dockerRunnerSpecDigest(checkedSpec);
        const expectedBinding = dockerRunnerSourceBindingDigest(checkedBinding, { spec: checkedSpec });
        const ids = parseImageIds(run([
          '--context', checkedSpec.dockerContext,
          'image', 'ls', '--no-trunc', '--quiet',
          '--filter', `label=${DOCKER_IMAGE_SOURCE_LABELS.sourceSnapshotSha256}=${checkedBinding.sourceSnapshotSha256}`,
          '--filter', `label=${DOCKER_IMAGE_SOURCE_LABELS.runnerSpecDigest}=${expectedRunner}`,
          '--filter', `label=${DOCKER_IMAGE_SOURCE_LABELS.sourceBindingDigest}=${expectedBinding}`,
        ]));
        if (!ids.length) reject('docker_materialization_source_attested_image_missing');
        if (ids.length !== 1) reject('docker_materialization_source_attested_image_ambiguous');
        imageRef = ids[0];
      }
      const image = parseJson(run(['--context', checkedSpec.dockerContext, 'image', 'inspect', '--format', IMAGE_TEMPLATE, imageRef]));
      imageId = image?.id;
      if (typeof imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(imageId) || !platformMatches(checkedSpec.platform, image)) reject('docker_materialization_image_invalid');
      configPublicSha256 = publicConfigDigest(checkedSpec, null);
      mountsSha256 = digest({ schemaVersion: 'docker-mount-projection/v1', mounts: [] });
    }

    const materialization = validateDockerRunnerMaterialization({
      schemaVersion: 'docker-runner-materialization/v1',
      runnerId: checkedSpec.id,
      runnerSpecDigest: dockerRunnerSpecDigest(checkedSpec),
      sourceBindingDigest: dockerRunnerSourceBindingDigest(checkedBinding, { spec: checkedSpec }),
      sourceSnapshotSha256: checkedBinding.sourceSnapshotSha256,
      daemonId,
      imageId,
      configPublicSha256,
      mountsSha256,
      platform: checkedSpec.platform,
      containerId,
      observedAt: new Date().toISOString(),
    }, { spec: checkedSpec, sourceBinding: checkedBinding });
    return { ...base, status: 'MATERIALIZED', code: 'docker_runner_materialized', materialization, calls };
  } catch (error) {
    return { ...base, status: 'HOLD', code: error instanceof ProbeError ? error.code : 'docker_materialization_failed', materialization: null, calls };
  }
}
