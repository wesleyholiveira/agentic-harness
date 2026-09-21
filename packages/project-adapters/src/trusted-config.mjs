import { createHash } from 'node:crypto';
import { readGitSourceFiles } from '../../source-identity/src/git-snapshot.mjs';
import { parseProjectJson, projectRoot } from './safe-files.mjs';
import { validateProjectDescriptorV2, projectDescriptorV2Digest } from '../../harness-contracts/src/project-descriptor-v2.mjs';
import { validateExecutionPolicyV2, evaluateExecutionPolicyV2, executionPolicyV2Digest } from '../../harness-contracts/src/execution-policy-v2.mjs';
import {
  dependencyFileSetDigest, dockerRunnerSourceBindingDigest, dockerRunnerSpecDigest,
  validateDockerRunnerSourceBinding,
} from '../../harness-contracts/src/docker-runner-v2.mjs';
import { fail } from '../../harness-contracts/src/source-identity.mjs';

const DESCRIPTOR_PATH = '.agent-harness/project.json';

function selectedFile(result, path) {
  const file = result.files.find(item => item.path === path);
  if (!file) fail('trusted_config_selected_file_missing');
  return file;
}
function sourceEntry(identity, path) {
  const entry = identity.entries.find(item => item.path === path);
  if (!entry || entry.kind !== 'file') fail('trusted_config_required_source_file_missing');
  return entry;
}
function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sourceBindingForRunner({ runner, source }) {
  const composeFiles = runner.composeFiles.map(path => {
    const entry = sourceEntry(source.identity, path);
    return { path, sha256: entry.sha256 };
  });
  const dependencyFiles = runner.dependencyFiles.map(path => {
    const entry = sourceEntry(source.identity, path);
    return { path, sha256: entry.sha256 };
  });
  const binding = {
    schemaVersion: 'docker-runner-source-binding/v1',
    runnerId: runner.id,
    runnerSpecDigest: dockerRunnerSpecDigest(runner),
    sourceCommit: source.commit,
    sourceObjectFormat: source.objectFormat,
    sourceSnapshotSha256: source.identity.treeSha256,
    composeFiles,
    dependencyFiles,
    dependencyLockSha256: dependencyFileSetDigest(dependencyFiles),
    trustKind: 'git-commit',
  };
  return validateDockerRunnerSourceBinding(binding, { spec: runner });
}

/**
 * Loads project execution configuration from immutable Git blobs, never from the
 * mutable worktree. "trusted" here means source-bound to one Git commit; it is
 * not release qualification and does not prove the task workspace matches it.
 */
export function loadCommittedProjectConfiguration(root, {
  commit = 'HEAD',
  descriptorPath = DESCRIPTOR_PATH,
  symlinkPolicy = 'record-only',
} = {}) {
  const repositoryRoot = projectRoot(root);
  if (descriptorPath !== DESCRIPTOR_PATH) fail('trusted_config_descriptor_path_unsupported');

  const descriptorRead = readGitSourceFiles(repositoryRoot, {
    commit,
    paths: [descriptorPath],
    symlinkPolicy,
  });
  const descriptorFile = selectedFile(descriptorRead, descriptorPath);
  const descriptor = validateProjectDescriptorV2(parseProjectJson(descriptorFile.bytes));

  const policyRead = readGitSourceFiles(repositoryRoot, {
    commit: descriptorRead.commit,
    paths: [descriptorPath, descriptor.policyRef],
    symlinkPolicy,
  });
  if (policyRead.commit !== descriptorRead.commit
      || policyRead.identity.treeSha256 !== descriptorRead.identity.treeSha256) {
    fail('trusted_config_source_changed');
  }
  const policyFile = selectedFile(policyRead, descriptor.policyRef);
  const policy = validateExecutionPolicyV2(parseProjectJson(policyFile.bytes));
  if (policy.projectId !== descriptor.projectId) fail('trusted_config_project_mismatch');
  if (policy.descriptorDigest !== projectDescriptorV2Digest(descriptor)) fail('trusted_config_descriptor_digest_mismatch');

  const runnerSourceBindings = descriptor.runners.map(runner => sourceBindingForRunner({
    runner,
    source: policyRead,
  }));
  const commandEvaluations = Object.fromEntries(descriptor.commands.map(command => [
    command.id,
    evaluateExecutionPolicyV2({ policy, descriptor, commandId: command.id }),
  ]));

  return {
    schemaVersion: 'committed-project-configuration/v1',
    repositoryRoot,
    sourceCommit: policyRead.commit,
    sourceObjectFormat: policyRead.objectFormat,
    sourceSnapshotSha256: policyRead.identity.treeSha256,
    descriptorPath,
    descriptorSha256: sha256(descriptorFile.bytes),
    policyPath: descriptor.policyRef,
    policySha256: sha256(policyFile.bytes),
    descriptorDigest: projectDescriptorV2Digest(descriptor),
    policyDigest: executionPolicyV2Digest(policy),
    sourceTrustVerified: true,
    policyTrustVerified: true,
    trustKind: 'git-commit-config',
    workingTreeChecked: false,
    workspaceBindingVerified: false,
    qualificationVerdict: null,
    descriptor,
    policy,
    runnerSourceBindings,
    commandEvaluations,
  };
}

export function admitCommittedCommand({ configuration, commandId }) {
  if (!configuration || configuration.schemaVersion !== 'committed-project-configuration/v1'
      || configuration.sourceTrustVerified !== true || configuration.policyTrustVerified !== true) {
    fail('command_admission_trusted_configuration_required');
  }
  const command = configuration.descriptor.commands.find(item => item.id === commandId) ?? null;
  const runner = command ? configuration.descriptor.runners.find(item => item.id === command.runnerId) ?? null : null;
  const sourceBinding = runner
    ? configuration.runnerSourceBindings.find(item => item.runnerId === runner.id) ?? null
    : null;
  const evaluation = evaluateExecutionPolicyV2({
    policy: configuration.policy,
    descriptor: configuration.descriptor,
    commandId,
  });
  if (evaluation.status !== 'CONTRACT_SATISFIED' || !command || !runner || !sourceBinding) {
    return {
      schemaVersion: 'committed-command-admission/v1',
      status: 'HOLD',
      reasons: evaluation.reasons.length ? evaluation.reasons : ['source-binding-missing'],
      commandId: String(commandId ?? ''),
      sourceCommit: configuration.sourceCommit,
      sourceSnapshotSha256: configuration.sourceSnapshotSha256,
      qualificationVerdict: null,
      executableNow: false,
    };
  }
  return {
    schemaVersion: 'committed-command-admission/v1',
    status: 'SOURCE_POLICY_TRUSTED',
    reasons: [],
    projectId: configuration.descriptor.projectId,
    commandId: command.id,
    runnerId: runner.id,
    runnerSpecDigest: dockerRunnerSpecDigest(runner),
    sourceBindingDigest: dockerRunnerSourceBindingDigest(sourceBinding, { spec: runner }),
    sourceCommit: configuration.sourceCommit,
    sourceSnapshotSha256: configuration.sourceSnapshotSha256,
    descriptorDigest: configuration.descriptorDigest,
    policyDigest: configuration.policyDigest,
    sourceTrustVerified: true,
    policyTrustVerified: true,
    workspaceBindingVerified: false,
    materializationVerified: false,
    toolchainVerified: false,
    behaviorAuthorized: false,
    executableNow: false,
    qualificationVerdict: null,
  };
}
