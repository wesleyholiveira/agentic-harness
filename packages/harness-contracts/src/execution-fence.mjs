import { createHash } from 'node:crypto';
import { assertKeys, fail } from './source-identity.mjs';

export const TASK_EXECUTION_FENCE_VERSION = 'task-execution-fence/v1';

function text(value, code = 'task_execution_fence_invalid') {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}
function positive(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) fail('task_execution_fence_invalid');
  return n;
}
function iso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('task_execution_fence_invalid');
  }
  return value;
}
function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function validateTaskExecutionFence(fence) {
  assertKeys(fence, [
    'schemaVersion','runId','taskId','attempt','dispatchGeneration','fencingToken',
    'leaseOwner','leaseExpiresAt','observedAt',
  ], [], 'task_execution_fence_invalid');
  if (fence.schemaVersion !== TASK_EXECUTION_FENCE_VERSION) fail('task_execution_fence_invalid');
  return {
    schemaVersion: fence.schemaVersion,
    runId: text(fence.runId),
    taskId: text(fence.taskId),
    attempt: positive(fence.attempt),
    dispatchGeneration: positive(fence.dispatchGeneration),
    fencingToken: positive(fence.fencingToken),
    leaseOwner: text(fence.leaseOwner),
    leaseExpiresAt: iso(fence.leaseExpiresAt),
    observedAt: iso(fence.observedAt),
  };
}

export function validateActiveTaskExecutionFence(fence, { now = new Date() } = {}) {
  const checked = validateTaskExecutionFence(fence);
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) fail('task_execution_fence_now_invalid');
  if (Date.parse(checked.leaseExpiresAt) <= at.getTime()) fail('task_execution_fence_expired');
  if (Date.parse(checked.observedAt) > at.getTime() + 5_000) fail('task_execution_fence_observed_in_future');
  return checked;
}

export function taskExecutionFenceIdentityDigest(fence) {
  const checked = validateTaskExecutionFence(fence);
  return digest({
    schemaVersion: checked.schemaVersion,
    runId: checked.runId,
    taskId: checked.taskId,
    attempt: checked.attempt,
    dispatchGeneration: checked.dispatchGeneration,
    fencingToken: checked.fencingToken,
    leaseOwner: checked.leaseOwner,
  });
}
