import { assertKeys, assertSha256, fail } from './source-identity.mjs';
import { contractDigest, validateCommandSpec } from './project-descriptor.mjs';
import { projectDescriptorV2Digest, validateProjectDescriptorV2 } from './project-descriptor-v2.mjs';
import { dockerRunnerSpecDigest } from './docker-runner-v2.mjs';

export const EXECUTION_POLICY_V2 = 'execution-policy/v2';
const SCOPES = new Set(['workspace','container','authoritative-host','live']);
const NETWORK = new Set(['none','service-only','declared-external']);
const EFFECTS = new Set(['read-only','workspace-write','external-write']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;

function uniqueList(value, allowed) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32 || new Set(value).size !== value.length
      || value.some(item => typeof item !== 'string' || !allowed.has(item))) fail('execution_policy_v2_grant_invalid');
}
function commandDigest(command) { return contractDigest(validateCommandSpec(command)); }

export function validateExecutionPolicyV2(policy) {
  assertKeys(policy, ['schemaVersion','id','projectId','descriptorDigest','grants'], [], 'execution_policy_v2_shape_invalid');
  if (policy.schemaVersion !== EXECUTION_POLICY_V2) fail('execution_policy_v2_version_unsupported');
  if (typeof policy.id !== 'string' || !ID.test(policy.id)) fail('execution_policy_v2_id_invalid');
  if (typeof policy.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(policy.projectId)) fail('execution_policy_v2_project_invalid');
  assertSha256(policy.descriptorDigest);
  if (!Array.isArray(policy.grants) || policy.grants.length > 2048) fail('execution_policy_v2_grants_invalid');
  const ids = new Set();
  for (const grant of policy.grants) {
    assertKeys(grant, [
      'commandId','commandDigest','runnerSpecDigest','allowedScopes','allowedNetworkPolicies',
      'allowedEffects','maxTimeoutMs','allowSecrets',
    ], [], 'execution_policy_v2_grant_invalid');
    if (typeof grant.commandId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(grant.commandId) || ids.has(grant.commandId)) fail('execution_policy_v2_grant_invalid');
    ids.add(grant.commandId);
    assertSha256(grant.commandDigest);
    assertSha256(grant.runnerSpecDigest);
    uniqueList(grant.allowedScopes, SCOPES);
    uniqueList(grant.allowedNetworkPolicies, NETWORK);
    uniqueList(grant.allowedEffects, EFFECTS);
    if (!Number.isSafeInteger(grant.maxTimeoutMs) || grant.maxTimeoutMs < 1 || grant.maxTimeoutMs > 3600000 || typeof grant.allowSecrets !== 'boolean') fail('execution_policy_v2_grant_invalid');
  }
  return structuredClone(policy);
}

export function executionPolicyV2Digest(policy) {
  return contractDigest(validateExecutionPolicyV2(policy));
}

export function evaluateExecutionPolicyV2({ policy, descriptor, commandId }) {
  const checkedDescriptor = validateProjectDescriptorV2(descriptor);
  const checkedPolicy = validateExecutionPolicyV2(policy);
  const reasons = [];
  const command = checkedDescriptor.commands.find(item => item.id === commandId) ?? null;
  const runner = command ? checkedDescriptor.runners.find(item => item.id === command.runnerId) ?? null : null;
  if (checkedPolicy.projectId !== checkedDescriptor.projectId) reasons.push('project-mismatch');
  if (checkedPolicy.descriptorDigest !== projectDescriptorV2Digest(checkedDescriptor)) reasons.push('descriptor-digest-mismatch');
  if (!command) reasons.push('command-unknown');
  const grant = command ? checkedPolicy.grants.find(item => item.commandId === command.id) ?? null : null;
  if (command && !grant) reasons.push('grant-missing');
  if (command && runner && grant) {
    if (grant.commandDigest !== commandDigest(command)) reasons.push('command-digest-mismatch');
    if (grant.runnerSpecDigest !== dockerRunnerSpecDigest(runner)) reasons.push('runner-spec-digest-mismatch');
    if (!grant.allowedScopes.includes(command.validationScope)) reasons.push('scope-forbidden');
    if (!grant.allowedNetworkPolicies.includes(command.networkPolicy)) reasons.push('network-forbidden');
    if (command.effects.some(effect => !grant.allowedEffects.includes(effect))) reasons.push('effect-forbidden');
    if (command.timeoutMs > grant.maxTimeoutMs) reasons.push('timeout-exceeds-policy');
    if (command.secretRefs.length > 0 && !grant.allowSecrets) reasons.push('secrets-forbidden');
  }
  return {
    schemaVersion: 'execution-policy-v2-evaluation/v1',
    status: reasons.length ? 'HOLD' : 'CONTRACT_SATISFIED',
    reasons,
    projectId: checkedDescriptor.projectId,
    commandId: command?.id ?? String(commandId ?? ''),
    runnerId: runner?.id ?? null,
    descriptorDigest: projectDescriptorV2Digest(checkedDescriptor),
    policyDigest: executionPolicyV2Digest(checkedPolicy),
    sourceTrustVerified: false,
    policyTrustVerified: false,
    authorization: 'pending-committed-source-trust',
    qualificationVerdict: null,
  };
}
