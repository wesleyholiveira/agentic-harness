import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDockerRunnerRef, dockerRunnerDigest, assessDockerToolchainEvidence } from '../../packages/harness-contracts/src/docker-runner.mjs';

const hash = ch => `sha256:${ch.repeat(64)}`;
function runner() {
  return { schemaVersion: 'docker-runner-ref/v1', id: 'tests', kind: 'docker-compose', dockerContext: 'desktop-linux', daemonId: 'daemon-A', composeProject: 'engineering-a', composeFiles: [{ path: 'compose.yaml', sha256: hash('a') }, { path: 'compose.test.yaml', sha256: hash('b') }], profiles: ['test'], service: 'test-runner', purpose: 'test', operation: 'one-off', replica: null, containerCwd: '/workspace/project', user: '1000:1000', platform: 'linux/amd64', buildTarget: 'test', imageId: hash('c'), configPublicSha256: hash('d'), sourceSnapshotSha256: hash('e'), mountsSha256: hash('f'), dependencyLockSha256: hash('0') };
}
function evidence(r = runner()) {
  return { schemaVersion: 'docker-toolchain-evidence/v1', runnerId: r.id, runnerDigest: dockerRunnerDigest(r), dockerContext: r.dockerContext, daemonId: r.daemonId, composeProject: r.composeProject, service: r.service, purpose: r.purpose, operation: r.operation, replica: r.replica, imageId: r.imageId, sourceSnapshotSha256: r.sourceSnapshotSha256, configPublicSha256: r.configPublicSha256, mountsSha256: r.mountsSha256, dependencyLockSha256: r.dependencyLockSha256, platform: r.platform, containerCwd: r.containerCwd, user: r.user, containerIdBefore: 'a'.repeat(64), containerIdAfter: 'a'.repeat(64), startedAt: '2026-09-20T00:00:00.000Z', finishedAt: '2026-09-20T00:00:01.000Z', phases: ['declared', 'materialized', 'toolchain', 'behavior'].map(phase => ({ phase, result: 'passed', exitCode: 0, commandId: `${phase}-probe`, logSha256: hash('1') })) };
}

test('Docker runner contracts never infer a host toolchain or grant effects', () => {
  const r = runner(); assert.deepEqual(validateDockerRunnerRef(r), r);
  const result = assessDockerToolchainEvidence({ runner: r, evidence: evidence(r), validationScope: 'workspace', allowedScopes: ['workspace'] });
  assert.equal(result.contractSatisfied, true);
  assert.equal(result.qualificationVerdict, null);
  assert.equal(result.trustVerified, false, 'an input record is not proof that Docker was run');
});

test('compose file ordering changes runner identity; object key order does not', () => {
  const r = runner();
  assert.equal(dockerRunnerDigest(r), dockerRunnerDigest(Object.fromEntries(Object.entries(r).reverse())));
  assert.notEqual(dockerRunnerDigest(r), dockerRunnerDigest({ ...r, composeFiles: r.composeFiles.toReversed() }));
});

for (const field of ['service', 'dockerContext', 'daemonId', 'composeProject', 'purpose', 'operation', 'platform', 'containerCwd', 'user', 'imageId', 'mountsSha256', 'dependencyLockSha256', 'sourceSnapshotSha256', 'configPublicSha256']) {
  test(`wrong Docker ${field} cannot satisfy declared target`, () => {
    const r = runner(); const e = evidence(r);
    e[field] = field.endsWith('Sha256') || field === 'imageId' ? hash('9') : `different-${field}`;
    assert.throws(() => assessDockerToolchainEvidence({ runner: r, evidence: e, validationScope: 'workspace', allowedScopes: ['workspace'] }), /docker_evidence_(identity|shape)_invalid/);
  });
}

test('an exec target requires a replica and a one-off is not a live exec proof', () => {
  assert.throws(() => validateDockerRunnerRef({ ...runner(), operation: 'exec' }), /docker_runner_replica_invalid/);
  assert.throws(() => validateDockerRunnerRef({ ...runner(), replica: 1 }), /docker_runner_replica_invalid/);
  const r = { ...runner(), operation: 'exec', replica: 2 };
  const e = evidence(r); e.replica = 1;
  assert.throws(() => assessDockerToolchainEvidence({ runner: r, evidence: e, validationScope: 'workspace', allowedScopes: ['workspace'] }), /docker_evidence_identity_invalid/);
});

test('toolchain or behavior failed is failure even with valid materialized image', () => {
  const r = runner(); const e = evidence(r); e.phases[3] = { ...e.phases[3], result: 'failed', exitCode: 1 };
  assert.equal(assessDockerToolchainEvidence({ runner: r, evidence: e, validationScope: 'workspace', allowedScopes: ['workspace'] }).status, 'FAIL');
});

test('config-only and missing toolchain evidence are HOLD, not success', () => {
  const r = runner(); const e = evidence(r); e.phases = e.phases.slice(0, 1);
  const result = assessDockerToolchainEvidence({ runner: r, evidence: e, validationScope: 'workspace', allowedScopes: ['workspace'] });
  assert.equal(result.status, 'HOLD'); assert.equal(result.contractSatisfied, false);
  assert.deepEqual(result.missingPhases, ['materialized', 'toolchain', 'behavior']);
});

test('container replacement during probe rejects attribution', () => {
  const r = runner(); const e = evidence(r); e.containerIdAfter = 'b'.repeat(64);
  assert.throws(() => assessDockerToolchainEvidence({ runner: r, evidence: e, validationScope: 'workspace', allowedScopes: ['workspace'] }), /docker_evidence_instance_changed/);
});

test('container selection does not authorize authoritative-host or live scope', () => {
  const r = runner();
  for (const scope of ['authoritative-host', 'live']) assert.throws(() => assessDockerToolchainEvidence({ runner: r, evidence: evidence(r), validationScope: scope, allowedScopes: ['workspace'] }), /docker_validation_scope_forbidden/);
});

test('contracts reject unknown fields including env values and privileged flags', () => {
  for (const field of ['environment', 'privileged', 'hostFallback']) assert.throws(() => validateDockerRunnerRef({ ...runner(), [field]: true }), /docker_runner_shape_invalid/);
  const r = runner(); assert.throws(() => assessDockerToolchainEvidence({ runner: r, evidence: { ...evidence(r), Config: { Env: ['SECRET=x'] } }, validationScope: 'workspace', allowedScopes: ['workspace'] }), /docker_evidence_shape_invalid/);
});

test('invalid container cwd and image tags are not accepted as immutable authority', () => {
  for (const cwd of ['relative', '/workspace/../private', '/a//b', 'C:/project']) assert.throws(() => validateDockerRunnerRef({ ...runner(), containerCwd: cwd }), /docker_runner_cwd_invalid/);
  assert.throws(() => validateDockerRunnerRef({ ...runner(), imageId: 'node:latest' }), /docker_runner_image_invalid/);
});

test('invalid or contradictory phase receipts fail closed', () => {
  const r = runner(); const e = evidence(r);
  e.phases[0].exitCode = 1;
  assert.throws(() => assessDockerToolchainEvidence({ runner: r, evidence: e, validationScope: 'workspace', allowedScopes: ['workspace'] }), /docker_evidence_phase_invalid/);
  const duplicate = evidence(r); duplicate.phases.push(duplicate.phases[0]);
  assert.throws(() => assessDockerToolchainEvidence({ runner: r, evidence: duplicate, validationScope: 'workspace', allowedScopes: ['workspace'] }), /docker_evidence_phase_duplicate/);
});
