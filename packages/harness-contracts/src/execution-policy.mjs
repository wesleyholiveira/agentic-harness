import { createHash } from 'node:crypto';
import { assertKeys, assertSha256, fail } from './source-identity.mjs';
import { contractDigest, projectDescriptorDigest, validateCommandSpec, validateProjectDescriptor } from './project-descriptor.mjs';
import { dockerRunnerDigest } from './docker-runner.mjs';

export const EXECUTION_POLICY_VERSION = 'execution-policy/v1';
const SCOPES = new Set(['workspace','container','authoritative-host','live']);
const NETWORK = new Set(['none','service-only','declared-external']);
const EFFECTS = new Set(['read-only','workspace-write','external-write']);
const REF = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;

function uniqueList(value, allowed, code) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32 || new Set(value).size !== value.length
      || value.some(item => typeof item !== 'string' || !allowed.has(item))) fail(code);
}
function ref(value) {
  if (typeof value !== 'string' || !REF.test(value) || value.split('/').some(part => part === '..')) fail('execution_policy_reference_invalid');
}
function commandDigest(command) { return contractDigest(validateCommandSpec(command)); }

export function validateExecutionPolicy(policy) {
  assertKeys(policy, ['schemaVersion','id','projectId','descriptorDigest','grants'], [], 'execution_policy_shape_invalid');
  if (policy.schemaVersion !== EXECUTION_POLICY_VERSION) fail('execution_policy_version_unsupported');
  ref(policy.id);
  if (typeof policy.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(policy.projectId)) fail('execution_policy_project_invalid');
  assertSha256(policy.descriptorDigest);
  if (!Array.isArray(policy.grants) || policy.grants.length > 2048) fail('execution_policy_grants_invalid');
  const ids = new Set();
  for (const grant of policy.grants) {
    assertKeys(grant, ['commandId','commandDigest','runnerDigest','allowedScopes','allowedNetworkPolicies','allowedEffects','maxTimeoutMs','allowSecrets'], [], 'execution_policy_grant_invalid');
    if (typeof grant.commandId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(grant.commandId) || ids.has(grant.commandId)) fail('execution_policy_grant_invalid');
    ids.add(grant.commandId);
    if (!HASH.test(grant.commandDigest) || !HASH.test(grant.runnerDigest)) fail('execution_policy_grant_invalid');
    uniqueList(grant.allowedScopes, SCOPES, 'execution_policy_grant_invalid');
    uniqueList(grant.allowedNetworkPolicies, NETWORK, 'execution_policy_grant_invalid');
    uniqueList(grant.allowedEffects, EFFECTS, 'execution_policy_grant_invalid');
    if (!Number.isSafeInteger(grant.maxTimeoutMs) || grant.maxTimeoutMs < 1 || grant.maxTimeoutMs > 3600000 || typeof grant.allowSecrets !== 'boolean') fail('execution_policy_grant_invalid');
  }
  return structuredClone(policy);
}

export function executionPolicyDigest(policy) {
  return contractDigest(validateExecutionPolicy(policy));
}

/**
 * Structural grant evaluation only. It proves that a committed-looking policy
 * would cover the exact descriptor/command/runner shape. It deliberately does
 * NOT establish that the policy bytes came from a trusted source snapshot.
 */
export function evaluateExecutionPolicy({ policy, descriptor, commandId }) {
  const checkedDescriptor = validateProjectDescriptor(descriptor);
  const checkedPolicy = validateExecutionPolicy(policy);
  const reasons = [];
  const command = checkedDescriptor.commands.find(item => item.id === commandId) ?? null;
  const runner = command ? checkedDescriptor.runners.find(item => item.id === command.runnerId) ?? null : null;
  if (checkedPolicy.projectId !== checkedDescriptor.projectId) reasons.push('project-mismatch');
  if (checkedPolicy.id !== checkedDescriptor.policyRef) reasons.push('policy-ref-mismatch');
  if (checkedPolicy.descriptorDigest !== projectDescriptorDigest(checkedDescriptor)) reasons.push('descriptor-digest-mismatch');
  if (!command) reasons.push('command-unknown');
  const grant = command ? checkedPolicy.grants.find(item => item.commandId === command.id) ?? null : null;
  if (command && !grant) reasons.push('grant-missing');
  if (command && runner && grant) {
    if (grant.commandDigest !== commandDigest(command)) reasons.push('command-digest-mismatch');
    if (grant.runnerDigest !== dockerRunnerDigest(runner)) reasons.push('runner-digest-mismatch');
    if (!grant.allowedScopes.includes(command.validationScope)) reasons.push('scope-forbidden');
    if (!grant.allowedNetworkPolicies.includes(command.networkPolicy)) reasons.push('network-forbidden');
    if (command.effects.some(effect => !grant.allowedEffects.includes(effect))) reasons.push('effect-forbidden');
    if (command.timeoutMs > grant.maxTimeoutMs) reasons.push('timeout-exceeds-policy');
    if (command.secretRefs.length > 0 && !grant.allowSecrets) reasons.push('secrets-forbidden');
  }
  return {
    schemaVersion: 'execution-policy-evaluation/v1',
    status: reasons.length ? 'HOLD' : 'CONTRACT_SATISFIED',
    reasons,
    projectId: checkedDescriptor.projectId,
    commandId: command?.id ?? String(commandId ?? ''),
    runnerId: runner?.id ?? null,
    descriptorDigest: projectDescriptorDigest(checkedDescriptor),
    policyDigest: executionPolicyDigest(checkedPolicy),
    grantDigest: grant ? `sha256:${createHash('sha256').update(JSON.stringify(grant)).digest('hex')}` : null,
    trustVerified: false,
    authorization: 'pending-source-trust',
    qualificationVerdict: null,
  };
}

export function commandContractDigest(command) { return commandDigest(command); }
