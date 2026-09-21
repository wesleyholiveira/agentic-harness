# Implementation wave 08 — image/source attestation and execution-fence binding

Authorization: continuation of the approved SDD/TDD implementation.
Branch: `fix/agent-start-current-user-message-authority-20260919`.
Baseline: WAVE-07 corrected target, 226/226 PASS.

## Why this wave precedes active executor integration

WAVE-07 proved that a committed CommandSpec can be policy/workspace/toolchain
admitted and executed in a constrained one-off container. Two authority gaps
remain before that library may be wired into the active Runtime:

1. a pinned image ID does not by itself prove that the image corresponds to the
   same source snapshot being validated;
2. behavior execution must be scoped to the same Runtime attempt,
   dispatch-generation and fencing-token lease that owns the task.

Integrating before closing those gaps could validate stale image content or
execute after a replacement worker acquired authority.

## Delivered

### Docker image/source attestation

New contract:
`packages/harness-contracts/src/image-source-attestation.mjs`.

Required image labels:
- `org.agentic-harness.source-snapshot-sha256`
- `org.agentic-harness.runner-spec-digest`
- `org.agentic-harness.source-binding-digest`

`probeDockerImageSourceAttestation` reads only the materialized immutable image
ID and those labels. It binds:
- runner ID/spec digest;
- source-binding digest;
- source snapshot;
- image ID/platform;
- materialization identity.

A stale source label, different runner/source binding, different image or
different materialization returns HOLD.

### Task execution fence

New pure contract:
`packages/harness-contracts/src/execution-fence.mjs`.

Fence identity is:
- runId;
- taskId;
- attempt;
- dispatchGeneration;
- fencingToken;
- leaseOwner.

`leaseExpiresAt` and observation timestamp are freshness fields, not identity,
so a legitimate worker heartbeat can extend the lease without invalidating a
receipt.

### Runtime fence observation

New bridge:
`.agents/runtime/behavior-fence.mjs`.

It reuses the existing authoritative `agent_tasks` row via `store.getTask`.
A valid observation requires:
- matching run/task/attempt/generation/fence;
- task status = running;
- lease owner present;
- lease not expired.

`executeBehaviorUnderTaskFence` observes the fence immediately before
execution and again after it. It does not execute when the pre-fence is invalid.
A replacement generation/fence/owner after execution converts the result to HOLD.

### Behavior admission hardening

`evaluateBehaviorAdmission` now additionally requires:
- valid source-bound image attestation;
- active task execution fence.

The behavior receipt includes both identity digests.

This means WAVE-07's previously enforceable subset remains enforceable only when
the image is source-bound and the active worker still owns the same task fence.

## Runtime-worker integration decision

The current Rust worker container intentionally does not have Docker socket
authority. Giving `docker.sock` directly to the worker would also give
model-controlled child processes a host-root-equivalent capability.

Therefore WAVE-08 does **not** mount Docker socket into the worker and does not
auto-wire behavior execution yet.

The next integration must either:
- use a dedicated restricted Docker tooling gateway whose socket is not exposed
  to agent-controlled processes, or
- provide an equivalently isolated runner capability.

The Rust worker already owns lease heartbeat and cancellation; the final bridge
must execute under that same fence before `persist_execution_result` clears
`lease_owner/lease_expires_at`.

## TDD

New suite:
`tests/contracts/behavior-fence-attestation-v2.test.mjs`.

10 new cases cover:
- valid and stale image/source attestation;
- exact authority-label probing;
- label redaction/fail-closed behavior;
- behavior admission requiring attestation and active fence;
- fence identity across heartbeat renewal;
- exact task-row fence observation;
- no execution under expired fence;
- post-execution replacement detection;
- heartbeat expiry extension preserving fence identity.

Existing WAVE-07 behavior fixtures were updated to include valid attestation and
fence inputs.

Expected focused total: 236 (226 proven baseline + 10 new tests). This is not
GREEN until the target-host/Docker rerun executes it.

## Boundary

Still pending:
- restricted Docker tooling gateway or equivalent isolated Docker authority;
- active Rust worker behavior-gate dispatch before result persistence;
- process-tree cancellation for the behavior gate on fence replacement;
- build pipeline that stamps the required source labels;
- workspace-write/network/service/secret enforcement;
- full Runtime qualification and release closure.

No main, consumer pin, cache/memory or model-routing change is included.
