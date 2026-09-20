import { createHash } from 'node:crypto';
import { assertKeys, assertRepositoryPath, fail } from './source-identity.mjs';

export const DOCKER_RUNNER_VERSION = 'docker-runner-ref/v1';
export const DOCKER_EVIDENCE_VERSION = 'docker-toolchain-evidence/v1';
export const TOOLCHAIN_PHASES = Object.freeze(['declared', 'materialized', 'toolchain', 'behavior']);
const SCOPES = ['workspace', 'container', 'authoritative-host', 'live'];
const HASH = /^sha256:[a-f0-9]{64}$/u;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u;
const RUNNER_FIELDS = [
  'schemaVersion', 'id', 'kind', 'dockerContext', 'daemonId', 'composeProject',
  'composeFiles', 'profiles', 'service', 'purpose', 'operation', 'replica',
  'containerCwd', 'user', 'platform', 'buildTarget', 'imageId',
  'configPublicSha256', 'sourceSnapshotSha256', 'mountsSha256', 'dependencyLockSha256',
];
const IDENTITY_FIELDS = ['dockerContext', 'daemonId', 'composeProject', 'service', 'purpose', 'operation', 'replica', 'imageId', 'sourceSnapshotSha256', 'configPublicSha256', 'mountsSha256', 'dependencyLockSha256', 'platform', 'containerCwd', 'user'];
function hash(value) { return typeof value === 'string' && HASH.test(value); }
function name(value) { return typeof value === 'string' && NAME.test(value); }
function cwd(value) {
  return typeof value === 'string' && value.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(value)
    && value.isWellFormed() && (value === '/' || value.slice(1).split('/').every(part => part && part !== '.' && part !== '..'));
}
function names(values) { return Array.isArray(values) && values.every(name) && new Set(values).size === values.length; }

/** Structural validation ONLY: a descriptor is not permission to invoke Docker. */
export function validateDockerRunnerRef(runner) {
  assertKeys(runner, RUNNER_FIELDS, [], 'docker_runner_shape_invalid');
  if (runner.schemaVersion !== DOCKER_RUNNER_VERSION || runner.kind !== 'docker-compose') fail('docker_runner_version_unsupported');
  for (const key of ['id', 'dockerContext', 'daemonId', 'service']) if (!name(runner[key])) fail('docker_runner_shape_invalid');
  if (typeof runner.composeProject !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(runner.composeProject)) fail('docker_runner_shape_invalid');
  if (!Array.isArray(runner.composeFiles) || !runner.composeFiles.length || runner.composeFiles.length > 32) fail('docker_runner_shape_invalid');
  const paths = new Set();
  for (const entry of runner.composeFiles) {
    assertKeys(entry, ['path', 'sha256'], [], 'docker_runner_shape_invalid');
    try { assertRepositoryPath(entry.path); } catch { fail('docker_runner_shape_invalid'); }
    if (!hash(entry.sha256) || paths.has(entry.path)) fail('docker_runner_shape_invalid');
    paths.add(entry.path);
  }
  if (!names(runner.profiles) || !['build', 'test', 'runtime'].includes(runner.purpose)
      || !['exec', 'one-off'].includes(runner.operation)) fail('docker_runner_shape_invalid');
  if (runner.operation === 'exec' ? !Number.isSafeInteger(runner.replica) || runner.replica < 1 : runner.replica !== null) fail('docker_runner_replica_invalid');
  if (!cwd(runner.containerCwd)) fail('docker_runner_cwd_invalid');
  if (typeof runner.user !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]*)?$/u.test(runner.user)) fail('docker_runner_shape_invalid');
  if (typeof runner.platform !== 'string' || !/^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-z0-9_]+)?$/u.test(runner.platform)) fail('docker_runner_shape_invalid');
  if (runner.buildTarget !== null && !name(runner.buildTarget)) fail('docker_runner_shape_invalid');
  if (!hash(runner.imageId)) fail('docker_runner_image_invalid');
  for (const key of ['configPublicSha256', 'sourceSnapshotSha256', 'mountsSha256', 'dependencyLockSha256']) if (!hash(runner[key])) fail('docker_runner_shape_invalid');
  return structuredClone(runner);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
export function dockerRunnerDigest(runner) {
  const canonical = stable(validateDockerRunnerRef(runner));
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

/**
 * Checks supplied evidence consistency; it neither probes Docker nor verifies the
 * issuer's trust. Even complete records cannot authorize execution or promotion.
 * The future runner/receipt admission layer must establish both independently.
 */
export function assessDockerToolchainEvidence({ runner, evidence, validationScope, allowedScopes }) {
  validateDockerRunnerRef(runner);
  if (!SCOPES.includes(validationScope) || !Array.isArray(allowedScopes)
      || allowedScopes.some(scope => !SCOPES.includes(scope)) || !allowedScopes.includes(validationScope)) fail('docker_validation_scope_forbidden');
  assertKeys(evidence, ['schemaVersion', 'runnerId', 'runnerDigest', ...IDENTITY_FIELDS, 'containerIdBefore', 'containerIdAfter', 'startedAt', 'finishedAt', 'phases'], [], 'docker_evidence_shape_invalid');
  if (evidence.schemaVersion !== DOCKER_EVIDENCE_VERSION) fail('docker_evidence_shape_invalid');
  if (evidence.runnerId !== runner.id || evidence.runnerDigest !== dockerRunnerDigest(runner)
      || IDENTITY_FIELDS.some(key => evidence[key] !== runner[key])) fail('docker_evidence_identity_invalid');
  const instance = value => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value));
  if (!instance(evidence.containerIdBefore) || !instance(evidence.containerIdAfter)) fail('docker_evidence_shape_invalid');
  if (evidence.containerIdBefore !== evidence.containerIdAfter) fail('docker_evidence_instance_changed');
  const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (!date(evidence.startedAt) || !date(evidence.finishedAt) || Date.parse(evidence.finishedAt) < Date.parse(evidence.startedAt)) fail('docker_evidence_shape_invalid');
  if (!Array.isArray(evidence.phases)) fail('docker_evidence_shape_invalid');
  const phases = new Map();
  for (const phase of evidence.phases) {
    assertKeys(phase, ['phase', 'result', 'exitCode', 'commandId', 'logSha256'], [], 'docker_evidence_phase_invalid');
    if (!TOOLCHAIN_PHASES.includes(phase.phase) || !['passed', 'failed', 'unavailable', 'not-run'].includes(phase.result)) fail('docker_evidence_phase_invalid');
    if (phases.has(phase.phase)) fail('docker_evidence_phase_duplicate');
    const executed = ['passed', 'failed'].includes(phase.result);
    if (executed) {
      if (!Number.isSafeInteger(phase.exitCode) || phase.exitCode < 0 || phase.exitCode > 255 || !name(phase.commandId) || !hash(phase.logSha256)) fail('docker_evidence_phase_invalid');
      if ((phase.result === 'passed') !== (phase.exitCode === 0)) fail('docker_evidence_phase_invalid');
      if (['toolchain', 'behavior'].includes(phase.phase) && evidence.containerIdBefore === null) fail('docker_evidence_phase_invalid');
    } else if (phase.exitCode !== null || phase.logSha256 !== null || (phase.commandId !== null && !name(phase.commandId))) fail('docker_evidence_phase_invalid');
    phases.set(phase.phase, phase);
  }
  const missingPhases = TOOLCHAIN_PHASES.filter(phase => phases.get(phase)?.result !== 'passed');
  const failed = [...phases.values()].some(phase => phase.result === 'failed');
  return {
    contractSatisfied: missingPhases.length === 0,
    status: failed ? 'FAIL' : missingPhases.length ? 'HOLD' : 'CONTRACT_SATISFIED',
    missingPhases,
    proofKind: 'container-evidence-contract-check',
    trustVerified: false,
    qualificationVerdict: null,
  };
}
