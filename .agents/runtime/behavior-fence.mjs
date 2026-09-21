import {
  taskExecutionFenceIdentityDigest,
  validateActiveTaskExecutionFence,
} from '../../packages/harness-contracts/src/execution-fence.mjs';

function hold(code, extra = {}) {
  return {
    schemaVersion: 'task-execution-fence-observation/v1',
    status: 'HOLD',
    code,
    fence: null,
    fenceIdentityDigest: null,
    ...extra,
  };
}

export async function observeActiveTaskExecutionFence({
  store,
  runId,
  taskId,
  attempt,
  dispatchGeneration,
  fencingToken,
  leaseOwner = null,
  now = new Date(),
} = {}) {
  if (!store?.getTask || !runId || !taskId) return hold('task_execution_fence_store_or_identity_missing');
  const row = await store.getTask(taskId);
  if (!row) return hold('task_execution_fence_task_missing');
  if (String(row.run_id ?? '') !== String(runId)
      || Number(row.attempt) !== Number(attempt)
      || Number(row.dispatch_generation) !== Number(dispatchGeneration)
      || Number(row.fencing_token) !== Number(fencingToken)) {
    return hold('task_execution_fence_identity_mismatch');
  }
  if (row.status !== 'running') return hold('task_execution_fence_status_not_running', { taskStatus: row.status ?? null });
  if (!row.lease_owner || !row.lease_expires_at) return hold('task_execution_fence_lease_missing');
  if (leaseOwner && row.lease_owner !== leaseOwner) return hold('task_execution_fence_lease_owner_mismatch');

  const observedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const fence = {
    schemaVersion: 'task-execution-fence/v1',
    runId: String(runId),
    taskId: String(taskId),
    attempt: Number(attempt),
    dispatchGeneration: Number(dispatchGeneration),
    fencingToken: Number(fencingToken),
    leaseOwner: String(row.lease_owner),
    leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
    observedAt,
  };
  try {
    const checked = validateActiveTaskExecutionFence(fence, { now });
    return {
      schemaVersion: 'task-execution-fence-observation/v1',
      status: 'ACTIVE',
      code: 'task_execution_fence_active',
      fence: checked,
      fenceIdentityDigest: taskExecutionFenceIdentityDigest(checked),
    };
  } catch (error) {
    return hold(error?.code ?? error?.message ?? 'task_execution_fence_invalid');
  }
}

export async function executeBehaviorUnderTaskFence({
  store,
  identity,
  executeBehavior,
  now = () => new Date(),
} = {}) {
  if (typeof executeBehavior !== 'function') {
    return { schemaVersion: 'fenced-behavior-execution/v1', status: 'HOLD', code: 'behavior_executor_missing', executed: false };
  }
  const before = await observeActiveTaskExecutionFence({ store, ...identity, now: now() });
  if (before.status !== 'ACTIVE') {
    return { schemaVersion: 'fenced-behavior-execution/v1', status: 'HOLD', code: 'behavior_fence_not_active', executed: false, before };
  }

  let behaviorReceipt;
  try {
    behaviorReceipt = await executeBehavior({ executionFence: before.fence });
  } catch (error) {
    behaviorReceipt = {
      schemaVersion: 'behavior-execution-receipt/v1',
      status: 'HOLD',
      code: error?.code ?? 'behavior_executor_threw',
      executed: false,
      qualificationVerdict: null,
    };
  }

  const after = await observeActiveTaskExecutionFence({
    store,
    ...identity,
    leaseOwner: before.fence.leaseOwner,
    now: now(),
  });
  if (after.status !== 'ACTIVE') {
    return {
      schemaVersion: 'fenced-behavior-execution/v1',
      status: 'HOLD',
      code: 'behavior_fence_lost_after_execution',
      executed: behaviorReceipt?.executed === true,
      before,
      after,
      behaviorReceipt,
    };
  }
  if (after.fenceIdentityDigest !== before.fenceIdentityDigest) {
    return {
      schemaVersion: 'fenced-behavior-execution/v1',
      status: 'HOLD',
      code: 'behavior_fence_identity_changed',
      executed: behaviorReceipt?.executed === true,
      before,
      after,
      behaviorReceipt,
    };
  }
  return {
    schemaVersion: 'fenced-behavior-execution/v1',
    status: behaviorReceipt?.status ?? 'HOLD',
    code: behaviorReceipt?.code ?? 'behavior_receipt_missing',
    executed: behaviorReceipt?.executed === true,
    fenceVerified: true,
    fenceIdentityDigest: before.fenceIdentityDigest,
    before,
    after,
    behaviorReceipt,
  };
}
