import { createHash } from 'node:crypto';
import { assertKeys, assertSha256, fail } from './source-identity.mjs';
import { DOCKER_IMAGE_SOURCE_LABELS } from './docker-source-labels.mjs';
import {
  dockerRunnerMaterializationIdentityDigest,
  dockerRunnerSourceBindingDigest,
  dockerRunnerSpecDigest,
  validateDockerRunnerMaterialization,
  validateDockerRunnerSourceBinding,
  validateDockerRunnerSpec,
} from './docker-runner-v2.mjs';

export const DOCKER_IMAGE_SOURCE_ATTESTATION_VERSION = 'docker-image-source-attestation/v1';
export { DOCKER_IMAGE_SOURCE_LABELS };

function digest(value) {
  const canonical = item => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => [key, canonical(item[key])]));
    }
    return item;
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value)) fail('docker_image_attestation_invalid');
  return value;
}

export function validateDockerImageSourceAttestation(attestation, { spec, sourceBinding, materialization } = {}) {
  assertKeys(attestation, [
    'schemaVersion','attestationKind','runnerId','runnerSpecDigest','sourceBindingDigest',
    'sourceSnapshotSha256','imageId','platform','materializationIdentityDigest','observedAt',
  ], [], 'docker_image_attestation_invalid');
  if (attestation.schemaVersion !== DOCKER_IMAGE_SOURCE_ATTESTATION_VERSION
      || attestation.attestationKind !== 'docker-image-labels-v1') fail('docker_image_attestation_invalid');
  id(attestation.runnerId);
  for (const key of ['runnerSpecDigest','sourceBindingDigest','sourceSnapshotSha256','imageId','materializationIdentityDigest']) {
    assertSha256(attestation[key]);
  }
  if (typeof attestation.platform !== 'string' || !/^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-z0-9_]+)?$/u.test(attestation.platform)) fail('docker_image_attestation_invalid');
  if (typeof attestation.observedAt !== 'string' || !Number.isFinite(Date.parse(attestation.observedAt))
      || new Date(attestation.observedAt).toISOString() !== attestation.observedAt) fail('docker_image_attestation_invalid');

  const checkedSpec = spec ? validateDockerRunnerSpec(spec) : null;
  const checkedBinding = sourceBinding
    ? validateDockerRunnerSourceBinding(sourceBinding, checkedSpec ? { spec: checkedSpec } : {})
    : null;
  const checkedMaterialization = materialization
    ? validateDockerRunnerMaterialization(materialization, {
      ...(checkedSpec ? { spec: checkedSpec } : {}),
      ...(checkedBinding ? { sourceBinding: checkedBinding } : {}),
    })
    : null;

  if (checkedSpec && (attestation.runnerId !== checkedSpec.id || attestation.runnerSpecDigest !== dockerRunnerSpecDigest(checkedSpec)
      || attestation.platform !== checkedSpec.platform)) fail('docker_image_attestation_mismatch');
  if (checkedBinding && (attestation.sourceBindingDigest !== dockerRunnerSourceBindingDigest(checkedBinding, checkedSpec ? { spec: checkedSpec } : {})
      || attestation.sourceSnapshotSha256 !== checkedBinding.sourceSnapshotSha256)) fail('docker_image_attestation_mismatch');
  if (checkedMaterialization && (attestation.imageId !== checkedMaterialization.imageId
      || attestation.materializationIdentityDigest !== dockerRunnerMaterializationIdentityDigest(checkedMaterialization, {
        ...(checkedSpec ? { spec: checkedSpec } : {}),
        ...(checkedBinding ? { sourceBinding: checkedBinding } : {}),
      }))) fail('docker_image_attestation_mismatch');

  return structuredClone(attestation);
}

export function dockerImageSourceAttestationIdentityDigest(attestation, options = {}) {
  const checked = validateDockerImageSourceAttestation(attestation, options);
  const { observedAt: _observedAt, ...identity } = checked;
  return digest(identity);
}
