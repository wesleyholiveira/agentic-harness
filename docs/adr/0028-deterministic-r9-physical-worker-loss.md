# ADR 0028 — Deterministic R-9 physical worker loss

Status: Accepted

## Context

The first fresh target-host qualification after ADR 0027 passed Q-ENTRY through R-8. R-7 closed a complete consumer delivery and R-8 proved the durable terminal continuation. R-9 then held with `qualification_wait_timeout:r9-worker-restart:120000` while waiting for the Runtime worker container to restart.

The Runtime worker Compose service uses `restart: unless-stopped`, but the standalone R-9 controller injected process loss with `docker kill <container>`. Docker treats an explicit container stop/kill issued through its management API as a manual stop for restart-policy purposes; `unless-stopped` therefore does not provide the unexpected-process-loss restart that R-9 was waiting to observe. The controller had created a qualification procedure that contradicted the restart semantics it intended to prove.

Source review also found that standalone R-9 had drifted from the promoted R17.4.5 process-loss proof in two additional ways:

1. it waited for an arbitrary `executor.spawned` event joined to any reusable database checkpoint rather than arming the existing `repair-checkpoint-after-full-agent` qualification boundary; and
2. it checked only that generation/fencing increased, instead of proving the exact same semantic attempt, `dispatchGeneration + 1`, `fencingToken + 1`, checkpoint identity preservation, one replacement preparation/dispatch, and `skippedFullAgentInvocation=true`.

The existing Runtime source already contains two promoted helpers for those stronger invariants: `.agents/runtime/h9r-process-loss.mjs` builds an isolated Docker host-PID-namespace helper that sends `SIGKILL` directly to the worker's container-init host PID, and `.agents/runtime/h9r-evidence.mjs` evaluates replacement/repair evidence. The OpenCode task executor also already supports a qualification-only repair checkpoint boundary after the full model invocation.

## Decision

1. R-9 must not use `docker kill` or `docker restart` as process-loss evidence.
2. Before creating the R-9 semantic run, the controller force-recreates only `agent-runtime-worker` with the qualification boundary armed for:
   - boundary `repair-checkpoint-after-full-agent`;
   - task match `technical-refinement`;
   - semantic task attempt `1`;
   - a bounded wait long enough for controller fault injection.
3. Qualification fault variables are default-off in the normal consumer environment and Compose topology. They are armed only by R-9 and explicitly disarmed before R-10.
4. The process-loss executor boundary is attempt-scoped. A replacement execution with a repair checkpoint never re-arms the boundary, and a legitimate Technical Refinement true retry at attempt 2+ also cannot receive a second qualification crash.
5. R-9 waits for the exact atomically materialized `runtime-repair-checkpoint/v1` file with:
   - `repairKind=qualification-process-loss`;
   - `status=repair-started`;
   - exact run/task/attempt identity; and
   - a non-empty checkpoint effect key.
   An arbitrary reusable checkpoint is not sufficient.
6. The controller inspects the running worker's Docker identity and invokes `buildWorkerProcessLossCommand()` to run an isolated helper with host PID namespace and only the `KILL` capability. The helper sends `SIGKILL` to the worker init host PID while leaving Docker itself unaware of a manual stop request.
7. Immediately after physical process loss, the controller expires only the exact killed task identity (`runId`, `taskId`, semantic attempt, dispatch generation, fencing token) and emits `pg_notify('agent_harness_runtime_wakeup', runId)`. This reproduces the Runtime qualification lease-expiry boundary without changing semantic attempt identity.
8. Docker restart evidence must prove the same container restarted exactly once and that the host PID changed.
9. Replacement evidence must prove:
   - semantic attempt unchanged;
   - `dispatchGeneration` advanced exactly once;
   - `fencingToken` advanced exactly once;
   - exactly one matching replacement preparation;
   - exactly one matching replacement dispatch;
   - exactly one matching repair-resume receipt;
   - checkpoint effect-key preservation;
   - `sameTaskAttempt=true`;
   - `skippedFullAgentInvocation=true`; and
   - no duplicated repair effect keys.
   `evaluateH9RRecoveryEvidence()` remains the source authority for that aggregate proof.
10. R-9 still requires the full semantic run to close and the consumer validation command to pass. Physical restart alone is never sufficient for PASS.
11. Once R-9 is terminal and all evidence passes, the worker is recreated with the qualification fault controls explicitly disarmed before R-10.

## Consequences

R-9 now proves an unexpected physical worker-process loss instead of an administrative container restart. Docker's own restart policy performs the replacement, while PostgreSQL lease/fencing authority determines whether the lost physical execution can be safely replaced.

The proof is stronger than the failed standalone procedure and restores the promoted R17.4.5 semantics: one semantic attempt may survive one physical worker replacement only through the exact repair checkpoint, with new dispatch/fencing identity and no second full model invocation.

The additional attempt scope prevents the test control from becoming a hidden crash loop if Technical Refinement legitimately advances to a later semantic retry. R-10 therefore begins from an explicitly disarmed worker rather than inheriting R-9 fault state.

This ADR changes qualification mechanics and qualification-only executor controls. It does not change normal Runtime retry/recovery behavior when the qualification environment variables are absent.
