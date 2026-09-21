import { createHash } from 'node:crypto';
import { assertKeys, assertObjectFormat, assertObjectId, assertRepositoryPath, assertSha256, fail } from './source-identity.mjs';

export const DOCKER_RUNNER_SPEC_VERSION = 'docker-runner-spec/v2';
export const DOCKER_RUNNER_SOURCE_BINDING_VERSION = 'docker-runner-source-binding/v1';
export const DOCKER_RUNNER_MATERIALIZATION_VERSION = 'docker-runner-materialization/v1';

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const IMAGE_DIGEST_REF = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(key => [key, stable(value[key])]));
  }
  return value;
}
function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}
function name(value) {
  if (typeof value !== 'string' || !NAME.test(value)) fail('docker_runner_spec_shape_invalid');
  return value;
}
function cwd(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || !value.isWellFormed()
      || /[\\\u0000-\u001f\u007f]/u.test(value)
      || (value !== '/' && value.slice(1).split('/').some(part => !part || part === '.' || part === '..'))) {
    fail('docker_runner_spec_cwd_invalid');
  }
  return value;
}
function uniquePaths(values, { min = 0, max = 64 } = {}) {
  if (!Array.isArray(values) || values.length < min || values.length > max) fail('docker_runner_spec_shape_invalid');
  const seen = new Set();
  for (const value of values) {
    try { assertRepositoryPath(value); } catch { fail('docker_runner_spec_shape_invalid'); }
    if (seen.has(value)) fail('docker_runner_spec_shape_invalid');
    seen.add(value);
  }
  return [...values];
}
function names(values) {
  if (!Array.isArray(values) || values.length > 32 || new Set(values).size !== values.length) fail('docker_runner_spec_shape_invalid');
  values.forEach(name);
  return [...values];
}

export function validateDockerRunnerSpec(spec) {
  assertKeys(spec, [
    'schemaVersion','id','kind','dockerContext','composeProject','composeFiles','profiles',
    'service','purpose','operation','replica','containerCwd','user','platform','buildTarget',
    'image','dependencyFiles',
  ], [], 'docker_runner_spec_shape_invalid');
  if (spec.schemaVersion !== DOCKER_RUNNER_SPEC_VERSION || spec.kind !== 'docker-compose') fail('docker_runner_spec_version_unsupported');
  for (const key of ['id','dockerContext','service']) name(spec[key]);
  if (typeof spec.composeProject !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(spec.composeProject)) fail('docker_runner_spec_shape_invalid');
  const composeFiles = uniquePaths(spec.composeFiles, { min: 1, max: 32 });
  const dependencyFiles = uniquePaths(spec.dependencyFiles, { max: 64 });
  const profiles = names(spec.profiles);
  if (!['build','test','runtime'].includes(spec.purpose) || !['exec','one-off'].includes(spec.operation)) fail('docker_runner_spec_shape_invalid');
  if (spec.operation === 'exec' ? !Number.isSafeInteger(spec.replica) || spec.replica < 1 : spec.replica !== null) fail('docker_runner_spec_replica_invalid');
  cwd(spec.containerCwd);
  if (typeof spec.user !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/u.test(spec.user)) fail('docker_runner_spec_shape_invalid');
  if (typeof spec.platform !== 'string' || !/^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-z0-9_]+)?$/u.test(spec.platform)) fail('docker_runner_spec_shape_invalid');
  if (spec.buildTarget !== null) name(spec.buildTarget);
  assertKeys(spec.image, ['mode','reference'], [], 'docker_runner_spec_image_invalid');
  if (spec.operation === 'exec') {
    if (spec.image.mode !== 'running-service' || spec.image.reference !== null) fail('docker_runner_spec_image_invalid');
  } else if (spec.image.mode !== 'pinned-reference' || typeof spec.image.reference !== 'string' || !IMAGE_DIGEST_REF.test(spec.image.reference)) {
    fail('docker_runner_spec_image_invalid');
  }
  return structuredClone({ ...spec, composeFiles, dependencyFiles, profiles });
}

export function dockerRunnerSpecDigest(spec) {
  return digest(validateDockerRunnerSpec(spec));
}

function assertHashEntries(entries, expectedPaths, code) {
  if (!Array.isArray(entries) || entries.length !== expectedPaths.length) fail(code);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    assertKeys(entry, ['path','sha256'], [], code);
    if (entry.path !== expectedPaths[index]) fail(code);
    assertSha256(entry.sha256);
  }
}

export function validateDockerRunnerSourceBinding(binding, { spec } = {}) {
  assertKeys(binding, [
    'schemaVersion','runnerId','runnerSpecDigest','sourceCommit','sourceObjectFormat',
    'sourceSnapshotSha256','composeFiles','dependencyFiles','dependencyLockSha256','trustKind',
  ], [], 'docker_runner_source_binding_invalid');
  if (binding.schemaVersion !== DOCKER_RUNNER_SOURCE_BINDING_VERSION || binding.trustKind !== 'git-commit') fail('docker_runner_source_binding_invalid');
  name(binding.runnerId);
  assertSha256(binding.runnerSpecDigest);
  assertObjectFormat(binding.sourceObjectFormat);
  assertObjectId(binding.sourceCommit, binding.sourceObjectFormat);
  assertSha256(binding.sourceSnapshotSha256);
  assertSha256(binding.dependencyLockSha256);
  const checkedSpec = spec ? validateDockerRunnerSpec(spec) : null;
  if (checkedSpec) {
    if (binding.runnerId !== checkedSpec.id || binding.runnerSpecDigest !== dockerRunnerSpecDigest(checkedSpec)) fail('docker_runner_source_binding_mismatch');
    assertHashEntries(binding.composeFiles, checkedSpec.composeFiles, 'docker_runner_source_binding_mismatch');
    assertHashEntries(binding.dependencyFiles, checkedSpec.dependencyFiles, 'docker_runner_source_binding_mismatch');
  } else {
    uniquePaths(binding.composeFiles.map(entry => entry?.path), { min: 1, max: 32 });
    binding.composeFiles.forEach(entry => assertSha256(entry.sha256));
    uniquePaths(binding.dependencyFiles.map(entry => entry?.path), { max: 64 });
    binding.dependencyFiles.forEach(entry => assertSha256(entry.sha256));
  }
  return structuredClone(binding);
}

export function dockerRunnerSourceBindingDigest(binding, options = {}) {
  return digest(validateDockerRunnerSourceBinding(binding, options));
}

export function dependencyFileSetDigest(entries) {
  if (!Array.isArray(entries)) fail('docker_dependency_files_invalid');
  for (const entry of entries) {
    assertKeys(entry, ['path','sha256'], [], 'docker_dependency_files_invalid');
    try { assertRepositoryPath(entry.path); } catch { fail('docker_dependency_files_invalid'); }
    assertSha256(entry.sha256);
  }
  return digest({ schemaVersion: 'docker-dependency-file-set/v1', entries });
}

export function validateDockerRunnerMaterialization(materialization, { spec, sourceBinding } = {}) {
  assertKeys(materialization, [
    'schemaVersion','runnerId','runnerSpecDigest','sourceBindingDigest','sourceSnapshotSha256',
    'daemonId','imageId','configPublicSha256','mountsSha256','platform','containerId','observedAt',
  ], [], 'docker_runner_materialization_invalid');
  if (materialization.schemaVersion !== DOCKER_RUNNER_MATERIALIZATION_VERSION) fail('docker_runner_materialization_invalid');
  name(materialization.runnerId);
  for (const key of ['runnerSpecDigest','sourceBindingDigest','sourceSnapshotSha256','imageId','configPublicSha256','mountsSha256']) assertSha256(materialization[key]);
  name(materialization.daemonId);
  if (typeof materialization.platform !== 'string' || !/^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-z0-9_]+)?$/u.test(materialization.platform)) fail('docker_runner_materialization_invalid');
  if (materialization.containerId !== null && (typeof materialization.containerId !== 'string' || !/^[a-f0-9]{64}$/u.test(materialization.containerId))) fail('docker_runner_materialization_invalid');
  if (typeof materialization.observedAt !== 'string' || !Number.isFinite(Date.parse(materialization.observedAt))
      || new Date(materialization.observedAt).toISOString() !== materialization.observedAt) fail('docker_runner_materialization_invalid');

  const checkedSpec = spec ? validateDockerRunnerSpec(spec) : null;
  const checkedBinding = sourceBinding ? validateDockerRunnerSourceBinding(sourceBinding, checkedSpec ? { spec: checkedSpec } : {}) : null;
  if (checkedSpec) {
    if (materialization.runnerId !== checkedSpec.id || materialization.runnerSpecDigest !== dockerRunnerSpecDigest(checkedSpec)
        || materialization.platform !== checkedSpec.platform
        || (checkedSpec.operation === 'exec' && materialization.containerId === null)
        || (checkedSpec.operation === 'one-off' && materialization.containerId !== null)) {
      fail('docker_runner_materialization_mismatch');
    }
  }
  if (checkedBinding) {
    if (materialization.sourceBindingDigest !== dockerRunnerSourceBindingDigest(checkedBinding, checkedSpec ? { spec: checkedSpec } : {})
        || materialization.sourceSnapshotSha256 !== checkedBinding.sourceSnapshotSha256) fail('docker_runner_materialization_mismatch');
  }
  return structuredClone(materialization);
}

export function dockerRunnerMaterializationDigest(materialization, options = {}) {
  return digest(validateDockerRunnerMaterialization(materialization, options));
}
