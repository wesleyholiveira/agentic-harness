import { admitCommittedCommand } from './trusted-config.mjs';
import { workspaceBindingMatchesRunner } from './workspace-binding.mjs';
import {
  dockerRunnerMaterializationIdentityDigest, validateDockerRunnerMaterialization,
  validateDockerRunnerSourceBinding,
} from '../../harness-contracts/src/docker-runner-v2.mjs';

export function evaluateCommandReadiness({
  configuration, commandId, workspaceBinding, materialization, toolchainReceipt,
}) {
  const admission = admitCommittedCommand({ configuration, commandId });
  const command = configuration?.descriptor?.commands?.find(item => item.id === commandId) ?? null;
  const spec = command ? configuration.descriptor.runners.find(item => item.id === command.runnerId) ?? null : null;
  const sourceBinding = spec ? configuration.runnerSourceBindings.find(item => item.runnerId === spec.id) ?? null : null;
  const reasons = [];
  if (admission.status !== 'SOURCE_POLICY_TRUSTED') reasons.push(...(admission.reasons ?? ['source-policy-not-trusted']));
  if (!spec || !sourceBinding) reasons.push('runner-source-binding-missing');
  const workspaceOk = Boolean(spec) && workspaceBindingMatchesRunner({ configuration, workspaceBinding, runnerId: spec.id });
  if (spec && !workspaceOk) reasons.push('workspace-binding-invalid');

  let materializationIdentityDigest = null;
  if (spec && sourceBinding) {
    try {
      const checkedBinding = validateDockerRunnerSourceBinding(sourceBinding, { spec });
      const checkedMaterialization = validateDockerRunnerMaterialization(materialization, { spec, sourceBinding: checkedBinding });
      materializationIdentityDigest = dockerRunnerMaterializationIdentityDigest(checkedMaterialization, { spec, sourceBinding: checkedBinding });
    } catch {
      reasons.push('materialization-invalid');
    }
  }
  if (!toolchainReceipt || toolchainReceipt.status !== 'TOOLCHAIN_VERIFIED'
      || toolchainReceipt.trustVerified !== true
      || toolchainReceipt.projectId !== configuration?.descriptor?.projectId
      || toolchainReceipt.commandId !== commandId
      || toolchainReceipt.workspaceBindingDigest !== workspaceBinding?.workspaceBindingDigest
      || toolchainReceipt.materializationIdentityDigest !== materializationIdentityDigest) reasons.push('toolchain-receipt-invalid');

  return {
    schemaVersion: 'command-readiness/v1',
    status: reasons.length ? 'HOLD' : 'TOOLCHAIN_READY',
    reasons: [...new Set(reasons)],
    projectId: configuration?.descriptor?.projectId ?? null,
    commandId: String(commandId ?? ''),
    sourceCommit: configuration?.sourceCommit ?? null,
    sourceSnapshotSha256: configuration?.sourceSnapshotSha256 ?? null,
    workspaceBindingDigest: workspaceBinding?.workspaceBindingDigest ?? null,
    materializationIdentityDigest,
    sourceTrustVerified: admission.status === 'SOURCE_POLICY_TRUSTED',
    policyTrustVerified: admission.status === 'SOURCE_POLICY_TRUSTED',
    workspaceBindingVerified: workspaceOk,
    materializationVerified: materializationIdentityDigest !== null,
    toolchainVerified: !reasons.includes('toolchain-receipt-invalid'),
    effectsEnforced: false,
    secretsResolved: false,
    networkEnforced: false,
    behaviorAuthorized: false,
    executableNow: false,
    qualificationVerdict: null,
  };
}
