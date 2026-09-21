#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadCommittedProjectConfiguration, admitCommittedCommand } from '../src/trusted-config.mjs';

try {
  const args = process.argv.slice(2);
  let root = null, commit = 'HEAD', commandId = null;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!['--root','--commit','--command'].includes(flag) || seen.has(flag)) throw new Error('trusted_config_cli_argument_invalid');
    seen.add(flag);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('trusted_config_cli_argument_invalid');
    if (flag === '--root') root = value;
    else if (flag === '--commit') commit = value;
    else commandId = value;
  }
  if (!root) throw new Error('trusted_config_cli_root_required');
  const configuration = loadCommittedProjectConfiguration(resolve(root), { commit });
  const output = {
    schemaVersion: configuration.schemaVersion,
    sourceCommit: configuration.sourceCommit,
    sourceObjectFormat: configuration.sourceObjectFormat,
    sourceSnapshotSha256: configuration.sourceSnapshotSha256,
    descriptorPath: configuration.descriptorPath,
    descriptorSha256: configuration.descriptorSha256,
    policyPath: configuration.policyPath,
    policySha256: configuration.policySha256,
    descriptorDigest: configuration.descriptorDigest,
    policyDigest: configuration.policyDigest,
    sourceTrustVerified: configuration.sourceTrustVerified,
    policyTrustVerified: configuration.policyTrustVerified,
    workingTreeChecked: configuration.workingTreeChecked,
    workspaceBindingVerified: configuration.workspaceBindingVerified,
    runnerSourceBindings: configuration.runnerSourceBindings.map(binding => ({
      runnerId: binding.runnerId,
      runnerSpecDigest: binding.runnerSpecDigest,
      sourceCommit: binding.sourceCommit,
      sourceSnapshotSha256: binding.sourceSnapshotSha256,
      composeFiles: binding.composeFiles,
      dependencyFiles: binding.dependencyFiles,
      dependencyLockSha256: binding.dependencyLockSha256,
      trustKind: binding.trustKind,
    })),
    commandAdmission: commandId ? admitCommittedCommand({ configuration, commandId }) : null,
    qualificationVerdict: null,
  };
  console.log(JSON.stringify(output, null, 2));
  if (commandId && output.commandAdmission.status === 'HOLD') process.exitCode = 2;
} catch (error) {
  const candidate = error?.code ?? error?.message;
  const code = typeof candidate === 'string' && /^[a-z0-9_:-]+$/u.test(candidate) ? candidate : 'trusted_config_failed';
  console.error(JSON.stringify({ status: 'HOLD', code, qualificationVerdict: null }));
  process.exitCode = 2;
}
