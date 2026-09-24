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
const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function iso(value) {
  if (typeof value !== 'string' || !RFC3339_TIMESTAMP.test(value)) {
    fail('task_execution_fence_invalid');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail('task_execution_fence_invalid');
  // Cross-runtime wire authority is RFC3339, not JavaScript's exact
  // Date.toISOString() byte shape. Rust/Chrono legitimately emits +00:00 and
  // sub-millisecond precision. Canonicalize only after validating the wire
  // representation so downstream comparisons remain deterministic.
  return new Date(timestamp).toISOString();
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
