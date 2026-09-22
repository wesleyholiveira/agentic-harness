import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contractDigest, validateCommandSpec } from '../../packages/harness-contracts/src/project-descriptor.mjs';
import { projectDescriptorV2Digest, validateProjectDescriptorV2 } from '../../packages/harness-contracts/src/project-descriptor-v2.mjs';
import {
  dockerRunnerSpecDigest, dockerRunnerSourceBindingDigest, dependencyFileSetDigest,
  validateDockerRunnerMaterialization, validateDockerRunnerSpec,
} from '../../packages/harness-contracts/src/docker-runner-v2.mjs';
import { validateExecutionPolicyV2, evaluateExecutionPolicyV2 } from '../../packages/harness-contracts/src/execution-policy-v2.mjs';
import { loadCommittedProjectConfiguration, admitCommittedCommand } from '../../packages/project-adapters/src/trusted-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function runnerSpec(overrides = {}) {
  return {
    schemaVersion: 'docker-runner-spec/v2',
    id: 'tests',
    kind: 'docker-compose',
    dockerContext: 'default',
    composeProject: 'fixture',
    composeFiles: ['compose.yaml'],
    profiles: ['test'],
    service: 'tests',
    purpose: 'test',
    operation: 'exec',
    replica: 1,
    containerCwd: '/workspace',
    user: '1000:1000',
    platform: 'linux/amd64',
    buildTarget: 'test',
    image: { mode: 'running-service', reference: null },
    dependencyFiles: ['package-lock.json'],
    ...overrides,
  };
}
function command(overrides = {}) {
  return {
    schemaVersion: 'command-spec/v1',
    id: 'unit',
    moduleId: 'root',
    runnerId: 'tests',
    phase: 'behavior',
    executable: 'node',
    argv: ['--test'],
    cwd: '.',
    envAllowlist: [],
    secretRefs: [],
    requiredCapabilities: ['language.node'],
    networkPolicy: 'none',
    effects: ['workspace-write'],
    timeoutMs: 60000,
    dependencyPolicy: 'required',
    validationScope: 'workspace',
    ...overrides,
  };
}
function descriptor(overrides = {}) {
  return {
    schemaVersion: 'project-descriptor/v2',
    projectId: 'fixture-project',
    repositoryId: 'fixture-repository',
    policyRef: '.agent-harness/policy.json',
    modules: [{ id: 'root', root: '.', languages: ['node'], requiredCapabilities: ['language.node'] }],
    evidenceRoots: ['docs'],
    protectedPaths: ['.harness', '.env'],
    runners: [runnerSpec()],
    commands: [command()],
    ...overrides,
  };
}
function policy(d = descriptor(), overrides = {}) {
  const c = d.commands[0], r = d.runners[0];
  return {
    schemaVersion: 'execution-policy/v2',
    id: 'engineering-v2',
    projectId: d.projectId,
    descriptorDigest: projectDescriptorV2Digest(d),
    grants: [{
      commandId: c.id,
      commandDigest: contractDigest(validateCommandSpec(c)),
      runnerSpecDigest: dockerRunnerSpecDigest(r),
      allowedScopes: ['workspace'],
      allowedNetworkPolicies: ['none'],
      allowedEffects: ['workspace-write'],
      maxTimeoutMs: 60000,
      allowSecrets: false,
    }],
    ...overrides,
  };
}
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'trusted-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = args => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
    stdio: ['ignore','pipe','pipe'],
  }).trim();
  git(['init']);
  git(['config','user.name','Trusted Config Test']);
  git(['config','user.email','test@example.invalid']);
  git(['config','core.autocrlf','false']);
  git(['config','commit.gpgsign','false']);
  const put = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const commit = message => { git(['add','.']); git(['commit','-m',message]); return git(['rev-parse','HEAD']); };
  return { root, git, put, commit };
}
function seed(r, d = descriptor(), p = policy(d)) {
  r.put('.agent-harness/project.json', JSON.stringify(d));
  r.put('.agent-harness/policy.json', JSON.stringify(p));
  r.put('compose.yaml', 'services:\n  tests:\n    image: node@sha256:' + 'a'.repeat(64) + '\n');
  r.put('package-lock.json', '{"lockfileVersion":3}\n');
  r.put('docs/readme.md', '# fixture\n');
}

test('v2 runner spec excludes materialized source/daemon/image identities', () => {
  const spec = validateDockerRunnerSpec(runnerSpec());
  const serialized = JSON.stringify(spec);
  for (const forbidden of ['sourceSnapshotSha256','daemonId','imageId','configPublicSha256','mountsSha256','dependencyLockSha256']) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
  assert.throws(() => validateDockerRunnerSpec({ ...spec, imageId: sha('image') }));
  assert.throws(() => validateDockerRunnerSpec({ ...spec, sourceSnapshotSha256: sha('source') }));
});

test('one-off runner accepts immutable registry pins or a post-commit source-attested build', () => {
  assert.equal(validateDockerRunnerSpec(runnerSpec()).image.mode, 'running-service');
  assert.throws(() => validateDockerRunnerSpec(runnerSpec({ operation: 'one-off', replica: null })), /docker_runner_spec_image_invalid/);
  const pinned = validateDockerRunnerSpec(runnerSpec({
    operation: 'one-off',
    replica: null,
    image: { mode: 'pinned-reference', reference: 'example.invalid/tool@sha256:' + 'b'.repeat(64) },
  }));
  assert.equal(pinned.image.mode, 'pinned-reference');

  const attested = validateDockerRunnerSpec(runnerSpec({
    operation: 'one-off',
    replica: null,
    image: { mode: 'source-attested-build', reference: null },
  }));
  assert.equal(attested.image.mode, 'source-attested-build');
  assert.equal(attested.image.reference, null);
  assert.throws(() => validateDockerRunnerSpec(runnerSpec({
    operation: 'one-off',
    replica: null,
    buildTarget: null,
    image: { mode: 'source-attested-build', reference: null },
  })), /docker_runner_spec_image_invalid/);
});

test('committed loader binds descriptor and policy to Git blobs and source identity', t => {
  const r = repo(t); seed(r); const commit = r.commit('fixture');
  const config = loadCommittedProjectConfiguration(r.root, { commit });
  assert.equal(config.sourceCommit, commit);
  assert.equal(config.sourceTrustVerified, true);
  assert.equal(config.policyTrustVerified, true);
  assert.equal(config.workingTreeChecked, false);
  assert.equal(config.workspaceBindingVerified, false);
  assert.equal(config.qualificationVerdict, null);
  assert.equal(config.descriptor.schemaVersion, 'project-descriptor/v2');
  assert.equal(config.policy.schemaVersion, 'execution-policy/v2');
  assert.equal(config.runnerSourceBindings.length, 1);
  const binding = config.runnerSourceBindings[0];
  assert.equal(binding.runnerId, 'tests');
  assert.equal(binding.sourceSnapshotSha256, config.sourceSnapshotSha256);
  assert.deepEqual(binding.composeFiles.map(item => item.path), ['compose.yaml']);
  assert.deepEqual(binding.dependencyFiles.map(item => item.path), ['package-lock.json']);
  assert.equal(binding.dependencyLockSha256, dependencyFileSetDigest(binding.dependencyFiles));
});

test('working-tree tampering cannot rewrite committed descriptor/policy authority', t => {
  const r = repo(t); const d = descriptor(); seed(r, d); r.commit('fixture');
  const before = loadCommittedProjectConfiguration(r.root);
  const tampered = structuredClone(d); tampered.commands[0].argv = ['--test','MALICIOUS'];
  r.put('.agent-harness/project.json', JSON.stringify(tampered));
  r.put('.agent-harness/policy.json', '{"schemaVersion":"execution-policy/v2","id":"evil"}');
  const after = loadCommittedProjectConfiguration(r.root);
  assert.equal(after.descriptorDigest, before.descriptorDigest);
  assert.equal(after.policyDigest, before.policyDigest);
  assert.deepEqual(after.descriptor.commands[0].argv, ['--test']);
  assert.equal(after.workingTreeChecked, false);
});

test('unrelated committed source change advances source snapshot without circular descriptor mutation', t => {
  const r = repo(t); const d = descriptor(); seed(r, d); r.commit('first');
  const first = loadCommittedProjectConfiguration(r.root);
  r.put('docs/readme.md', '# changed\n'); r.commit('second');
  const second = loadCommittedProjectConfiguration(r.root);
  assert.equal(second.descriptorDigest, first.descriptorDigest);
  assert.equal(second.policyDigest, first.policyDigest);
  assert.notEqual(second.sourceSnapshotSha256, first.sourceSnapshotSha256);
  assert.notEqual(second.runnerSourceBindings[0].sourceSnapshotSha256, first.runnerSourceBindings[0].sourceSnapshotSha256);
});

test('compose and dependency file changes are source-bound without appearing inside descriptor', t => {
  const r = repo(t); seed(r); r.commit('first');
  const first = loadCommittedProjectConfiguration(r.root);
  r.put('package-lock.json', '{"lockfileVersion":3,"packages":{"x":{}}}\n'); r.commit('second');
  const second = loadCommittedProjectConfiguration(r.root);
  assert.notEqual(second.runnerSourceBindings[0].dependencyLockSha256, first.runnerSourceBindings[0].dependencyLockSha256);
  assert.equal(second.descriptorDigest, first.descriptorDigest);
  assert.ok(!JSON.stringify(second.descriptor).includes(second.sourceSnapshotSha256));
});

test('missing committed compose/dependency files fail closed', t => {
  const r = repo(t); const d = descriptor(); const p = policy(d);
  r.put('.agent-harness/project.json', JSON.stringify(d));
  r.put('.agent-harness/policy.json', JSON.stringify(p));
  r.put('package-lock.json', '{}'); r.commit('missing-compose');
  assert.throws(() => loadCommittedProjectConfiguration(r.root), /trusted_config_required_source_file_missing/);
});

test('policy descriptor mismatch fails before admission', t => {
  const r = repo(t); const d = descriptor(), p = policy(d); p.descriptorDigest = sha('wrong');
  seed(r, d, p); r.commit('bad-policy');
  assert.throws(() => loadCommittedProjectConfiguration(r.root), /trusted_config_descriptor_digest_mismatch/);
});

test('policy must live under .agent-harness and commands cannot target it', () => {
  const d = descriptor({ policyRef: 'docs/policy.json' });
  assert.throws(() => validateProjectDescriptorV2(d), /project_v2_policy_ref_invalid/);
  const e = descriptor(); e.modules[0].root = '.agent-harness'; e.commands[0].cwd = '.agent-harness';
  assert.throws(() => validateProjectDescriptorV2(e), /project_v2_module_protected/);
});

test('structural policy evaluation stays untrusted until committed loader supplies provenance', () => {
  const d = descriptor(), p = policy(d);
  const evaluation = evaluateExecutionPolicyV2({ policy: p, descriptor: d, commandId: 'unit' });
  assert.equal(evaluation.status, 'CONTRACT_SATISFIED');
  assert.equal(evaluation.sourceTrustVerified, false);
  assert.equal(evaluation.policyTrustVerified, false);
  assert.equal(evaluation.authorization, 'pending-committed-source-trust');
});

test('committed command admission remains non-executable until workspace/materialization/toolchain gates', t => {
  const r = repo(t); seed(r); r.commit('fixture');
  const config = loadCommittedProjectConfiguration(r.root);
  const admission = admitCommittedCommand({ configuration: config, commandId: 'unit' });
  assert.equal(admission.status, 'SOURCE_POLICY_TRUSTED');
  assert.equal(admission.sourceTrustVerified, true);
  assert.equal(admission.policyTrustVerified, true);
  assert.equal(admission.workspaceBindingVerified, false);
  assert.equal(admission.materializationVerified, false);
  assert.equal(admission.toolchainVerified, false);
  assert.equal(admission.behaviorAuthorized, false);
  assert.equal(admission.executableNow, false);
  assert.equal(admission.qualificationVerdict, null);
});

test('a policy grant mismatch produces HOLD even when its bytes are committed', t => {
  const r = repo(t); const d = descriptor(); const p = policy(d); p.grants[0].allowedEffects = ['read-only'];
  seed(r, d, p); r.commit('fixture');
  const config = loadCommittedProjectConfiguration(r.root);
  const admission = admitCommittedCommand({ configuration: config, commandId: 'unit' });
  assert.equal(admission.status, 'HOLD');
  assert.ok(admission.reasons.includes('effect-forbidden'));
  assert.equal(admission.executableNow, false);
});

test('source binding and materialization are separate identities and must agree', t => {
  const r = repo(t); seed(r); r.commit('fixture');
  const config = loadCommittedProjectConfiguration(r.root);
  const spec = config.descriptor.runners[0], binding = config.runnerSourceBindings[0];
  const materialization = {
    schemaVersion: 'docker-runner-materialization/v1',
    runnerId: spec.id,
    runnerSpecDigest: dockerRunnerSpecDigest(spec),
    sourceBindingDigest: dockerRunnerSourceBindingDigest(binding, { spec }),
    sourceSnapshotSha256: binding.sourceSnapshotSha256,
    daemonId: 'daemon-a',
    imageId: sha('image'),
    configPublicSha256: sha('config'),
    mountsSha256: sha('mounts'),
    platform: spec.platform,
    containerId: 'c'.repeat(64),
    observedAt: new Date(0).toISOString(),
  };
  assert.deepEqual(validateDockerRunnerMaterialization(materialization, { spec, sourceBinding: binding }), materialization);
  assert.throws(() => validateDockerRunnerMaterialization({ ...materialization, sourceSnapshotSha256: sha('other') }, { spec, sourceBinding: binding }), /docker_runner_materialization_mismatch/);
});

test('read-only trusted-config CLI emits identities/admission, not command argv or qualification', t => {
  const r = repo(t); seed(r); const commit = r.commit('fixture');
  const cli = resolve(ROOT, 'packages/project-adapters/bin/trust-config.mjs');
  const result = spawnSync(process.execPath, [cli, '--root', r.root, '--commit', commit, '--command', 'unit'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sourceCommit, commit);
  assert.equal(output.sourceTrustVerified, true);
  assert.equal(output.commandAdmission.status, 'SOURCE_POLICY_TRUSTED');
  assert.equal(output.commandAdmission.executableNow, false);
  assert.equal(output.qualificationVerdict, null);
  assert.ok(!result.stdout.includes('"argv"'));
  assert.ok(!result.stdout.includes('"executable"'));
});
