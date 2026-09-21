import { spawnSync } from 'node:child_process';
import {
  DOCKER_IMAGE_SOURCE_LABELS,
  dockerImageSourceAttestationIdentityDigest,
  validateDockerImageSourceAttestation,
} from '../../harness-contracts/src/image-source-attestation.mjs';
import {
  dockerRunnerMaterializationIdentityDigest,
  dockerRunnerSourceBindingDigest,
  dockerRunnerSpecDigest,
  validateDockerRunnerMaterialization,
  validateDockerRunnerSourceBinding,
  validateDockerRunnerSpec,
} from '../../harness-contracts/src/docker-runner-v2.mjs';
import { projectRoot } from './safe-files.mjs';

const TEMPLATE = `{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"variant":{{json (index . "Variant")}},"sourceSnapshotSha256":{{json (index .Config.Labels "${DOCKER_IMAGE_SOURCE_LABELS.sourceSnapshotSha256}")}},"runnerSpecDigest":{{json (index .Config.Labels "${DOCKER_IMAGE_SOURCE_LABELS.runnerSpecDigest}")}},"sourceBindingDigest":{{json (index .Config.Labels "${DOCKER_IMAGE_SOURCE_LABELS.sourceBindingDigest}")}}}`;

function nativeDocker(argv, { cwd, timeoutMs }) {
  return spawnSync('docker', argv, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 131072,
    stdio: ['ignore','pipe','pipe'],
  });
}
function platformMatches(expected, image) {
  const [os, architecture, variant] = expected.split('/');
  return image?.os === os && image?.architecture === architecture && (!variant || image?.variant === variant);
}
function hold(code) {
  return { schemaVersion: 'docker-image-attestation-observation/v1', status: 'HOLD', code, attestation: null, qualificationVerdict: null };
}

export function probeDockerImageSourceAttestation({ spec, sourceBinding, materialization }, {
  root = process.cwd(),
  execute = nativeDocker,
  timeoutMs = 10_000,
} = {}) {
  let checkedSpec, checkedBinding, checkedMaterialization;
  try {
    checkedSpec = validateDockerRunnerSpec(spec);
    checkedBinding = validateDockerRunnerSourceBinding(sourceBinding, { spec: checkedSpec });
    checkedMaterialization = validateDockerRunnerMaterialization(materialization, { spec: checkedSpec, sourceBinding: checkedBinding });
  } catch {
    return hold('docker_image_attestation_prerequisite_invalid');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return hold('docker_image_attestation_timeout_invalid');

  let result;
  try {
    result = execute([
      '--context', checkedSpec.dockerContext,
      'image','inspect','--format',TEMPLATE,checkedMaterialization.imageId,
    ], { cwd: projectRoot(root), timeoutMs });
  } catch {
    return hold('docker_command_unavailable');
  }
  if (result?.error?.code === 'ENOENT') return hold('docker_command_unavailable');
  if (result?.error?.code === 'ETIMEDOUT') return hold('docker_image_attestation_timeout');
  if (result?.error || result?.status !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 131072) {
    return hold('docker_image_attestation_inspect_failed');
  }

  let image;
  try { image = JSON.parse(result.stdout); }
  catch { return hold('docker_image_attestation_output_invalid'); }
  if (!image || image.id !== checkedMaterialization.imageId || !platformMatches(checkedSpec.platform, image)) {
    return hold('docker_image_attestation_image_mismatch');
  }
  const expectedRunner = dockerRunnerSpecDigest(checkedSpec);
  const expectedBinding = dockerRunnerSourceBindingDigest(checkedBinding, { spec: checkedSpec });
  if (image.sourceSnapshotSha256 !== checkedBinding.sourceSnapshotSha256
      || image.runnerSpecDigest !== expectedRunner
      || image.sourceBindingDigest !== expectedBinding) {
    return hold('docker_image_source_labels_mismatch');
  }

  const attestation = {
    schemaVersion: 'docker-image-source-attestation/v1',
    attestationKind: 'docker-image-labels-v1',
    runnerId: checkedSpec.id,
    runnerSpecDigest: expectedRunner,
    sourceBindingDigest: expectedBinding,
    sourceSnapshotSha256: checkedBinding.sourceSnapshotSha256,
    imageId: checkedMaterialization.imageId,
    platform: checkedSpec.platform,
    materializationIdentityDigest: dockerRunnerMaterializationIdentityDigest(checkedMaterialization, {
      spec: checkedSpec, sourceBinding: checkedBinding,
    }),
    observedAt: new Date().toISOString(),
  };
  try {
    const checked = validateDockerImageSourceAttestation(attestation, {
      spec: checkedSpec, sourceBinding: checkedBinding, materialization: checkedMaterialization,
    });
    return {
      schemaVersion: 'docker-image-attestation-observation/v1',
      status: 'ATTESTED',
      code: 'docker_image_source_attested',
      attestation: checked,
      attestationIdentityDigest: dockerImageSourceAttestationIdentityDigest(checked, {
        spec: checkedSpec, sourceBinding: checkedBinding, materialization: checkedMaterialization,
      }),
      qualificationVerdict: null,
    };
  } catch {
    return hold('docker_image_attestation_invalid');
  }
}
