# ADR 0029 — R-9 worker fault-environment projection

Status: Accepted

## Context

The first fresh target-host qualification after ADR 0028 passed Q-ENTRY through R-8, including a closed R-7 semantic delivery and Durable Continuation. R-9 then held with `qualification_wait_timeout:r9-process-loss-boundary:1200000` before any worker process loss was injected.

ADR 0028 correctly changed the physical-loss mechanism to the promoted host-PID-namespace SIGKILL path and correctly armed four qualification-only controls through the Compose command environment. However, the Compose source projected those controls into the `context-engine` service rather than `agent-runtime-worker`:

- `AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_BOUNDARY`
- `AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_TASK_MATCH`
- `AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_ATTEMPT`
- `AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_WAIT_MS`

`opencode-task-executor.mjs` executes as a child of the Runtime worker and reads those values from its inherited process environment. Because the worker container never received them, `resolveQualificationProcessLossBoundary()` always returned `null`; the `qualification-process-loss` repair checkpoint was therefore impossible to materialize. The controller then waited the full twenty-minute boundary timeout for an unreachable state.

This was a qualification-procedure wiring defect, not a Runtime recovery failure. The target-host report confirms R-7 and R-8 PASS and shows R-9 failing only while waiting for the process-loss boundary.

## Decision

1. The four R-9 process-loss qualification variables are projected only into `agent-runtime-worker`. They are not Context Engine configuration.
2. Their normal/default values remain disabled, so ordinary consumer Runtime execution is unaffected.
3. Before R-9 creates its semantic OpenCode session, the controller must inspect the recreated worker's Docker `Config.Env` and prove exact equality with the armed values. A missing or mismatched projection is an immediate `QUALIFICATION PROCEDURE` HOLD: `r9_process_loss_boundary_not_projected_to_worker`.
4. Only after worker-side projection is proven may the semantic R-9 run begin.
5. If the exact qualification repair checkpoint still does not materialize after worker-side projection has been proven, the divergence is classified as `RUNTIME` (`r9_process_loss_boundary_not_materialized`) and includes the R-9 run id, current Technical Refinement task row and bounded boundary-related events.
6. After successful R-9 recovery and before R-10, the controller force-recreates the worker with the fault controls disarmed and proves the exact disarmed `Config.Env`. A mismatch is an immediate `QUALIFICATION PROCEDURE` HOLD: `r9_process_loss_boundary_not_disarmed_on_worker`.
7. Contracts must prove that the process-loss variables occur in the `agent-runtime-worker` Compose service and do not occur in the `context-engine` service.
8. ADR 0028 remains authoritative for physical SIGKILL, lease expiry, generation/fencing replacement and checkpoint-resume semantics. ADR 0029 corrects only the environment-projection boundary and its diagnostics.

## Consequences

The R-9 controller can no longer spend twenty minutes waiting for a fault boundary that the worker was never configured to execute. Compose/source wiring failures are detected before model work begins, while a failure after exact worker-side arming is attributed to Runtime behavior with useful evidence.

The process-loss controls remain qualification-only and fail-closed. No production or consumer execution path receives an armed boundary unless the external deterministic R-9 controller explicitly recreates the worker with those values.
