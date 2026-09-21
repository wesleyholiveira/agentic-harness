import { createHash } from 'node:crypto';
import { readProjectFile, projectRoot } from './safe-files.mjs';
import { dockerRunnerSourceBindingDigest, dockerRunnerSpecDigest, validateDockerRunnerSourceBinding } from '../../harness-contracts/src/docker-runner-v2.mjs';
import { fail } from '../../harness-contracts/src/source-identity.mjs';

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function expectedFileMap(configuration) {
  const expected = new Map();
  const add = (path, sha256, kind) => {
    const prior = expected.get(path);
    if (prior && prior.sha256 !== sha256) fail('workspace_binding_conflicting_expected_hash');
    expected.set(path, { path, sha256, kinds: [...new Set([...(prior?.kinds ?? []), kind])] });
  };
  add(configuration.descriptorPath, configuration.descriptorSha256, 'descriptor');
  add(configuration.policyPath, configuration.policySha256, 'policy');
  for (const binding of configuration.runnerSourceBindings ?? []) {
    for (const entry of binding.composeFiles ?? []) add(entry.path, entry.sha256, 'compose');
    for (const entry of binding.dependencyFiles ?? []) add(entry.path, entry.sha256, 'dependency');
  }
  return [...expected.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

/**
 * Point-in-time authority-input observation. It intentionally does NOT require
 * the entire workspace to equal sourceCommit because implementation workspaces
 * are expected to contain owned changes. Only command-authority inputs are bound.
 */
export function bindWorkspaceAuthorityInputs(root, configuration, { maxBytesPerFile = 32 * 1024 * 1024 } = {}) {
  if (!configuration || configuration.schemaVersion !== 'committed-project-configuration/v1'
      || configuration.sourceTrustVerified !== true || configuration.policyTrustVerified !== true) {
    fail('workspace_binding_trusted_configuration_required');
  }
  if (!Number.isSafeInteger(maxBytesPerFile) || maxBytesPerFile < 1 || maxBytesPerFile > 128 * 1024 * 1024) {
    fail('workspace_binding_limit_invalid');
  }
  const workspaceRoot = projectRoot(root);
  const expected = expectedFileMap(configuration);
  const observations = [];
  const mismatches = [];
  for (const item of expected) {
    let observed = null;
    try {
      observed = readProjectFile(workspaceRoot, item.path, { maxBytes: maxBytesPerFile });
    } catch (error) {
      mismatches.push({ path: item.path, reason: error?.code ?? 'workspace-input-unreadable' });
      continue;
    }
    if (observed.evidence.sha256 !== item.sha256) {
      mismatches.push({ path: item.path, reason: 'workspace-input-hash-mismatch' });
      continue;
    }
    observations.push({ path: item.path, sha256: item.sha256, bytes: observed.evidence.bytes, kinds: item.kinds });
  }
  const core = {
    schemaVersion: 'workspace-authority-binding/v1',
    projectId: configuration.descriptor.projectId,
    repositoryId: configuration.descriptor.repositoryId,
    sourceCommit: configuration.sourceCommit,
    sourceSnapshotSha256: configuration.sourceSnapshotSha256,
    descriptorDigest: configuration.descriptorDigest,
    policyDigest: configuration.policyDigest,
    observations,
  };
  return {
    ...core,
    status: mismatches.length ? 'HOLD' : 'AUTHORITY_INPUTS_BOUND',
    mismatches,
    workspaceBindingDigest: digest(core),
    sourceTrustVerified: configuration.sourceTrustVerified,
    policyTrustVerified: configuration.policyTrustVerified,
    pointInTimeOnly: true,
    executableNow: false,
    qualificationVerdict: null,
  };
}

export function workspaceBindingMatchesRunner({ configuration, workspaceBinding, runnerId }) {
  if (!workspaceBinding || workspaceBinding.schemaVersion !== 'workspace-authority-binding/v1'
      || workspaceBinding.status !== 'AUTHORITY_INPUTS_BOUND'
      || workspaceBinding.projectId !== configuration?.descriptor?.projectId
      || workspaceBinding.repositoryId !== configuration?.descriptor?.repositoryId
      || workspaceBinding.sourceCommit !== configuration?.sourceCommit
      || workspaceBinding.sourceSnapshotSha256 !== configuration?.sourceSnapshotSha256
      || workspaceBinding.descriptorDigest !== configuration?.descriptorDigest
      || workspaceBinding.policyDigest !== configuration?.policyDigest
      || !Array.isArray(workspaceBinding.observations)
      || !Array.isArray(workspaceBinding.mismatches)
      || workspaceBinding.mismatches.length !== 0) return false;
  const core = {
    schemaVersion: workspaceBinding.schemaVersion,
    projectId: workspaceBinding.projectId,
    repositoryId: workspaceBinding.repositoryId,
    sourceCommit: workspaceBinding.sourceCommit,
    sourceSnapshotSha256: workspaceBinding.sourceSnapshotSha256,
    descriptorDigest: workspaceBinding.descriptorDigest,
    policyDigest: workspaceBinding.policyDigest,
    observations: workspaceBinding.observations,
  };
  if (workspaceBinding.workspaceBindingDigest !== digest(core)) return false;
  const spec = configuration.descriptor.runners.find(runner => runner.id === runnerId) ?? null;
  const binding = configuration.runnerSourceBindings.find(item => item.runnerId === runnerId) ?? null;
  if (!spec || !binding) return false;
  try {
    validateDockerRunnerSourceBinding(binding, { spec });
    return binding.runnerSpecDigest === dockerRunnerSpecDigest(spec)
      && typeof dockerRunnerSourceBindingDigest(binding, { spec }) === 'string';
  } catch {
    return false;
  }
}
