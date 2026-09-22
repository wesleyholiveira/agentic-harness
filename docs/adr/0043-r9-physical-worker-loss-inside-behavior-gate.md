# ADR 0043 — R-9 physical worker loss must occur inside a real behavior-gateway window

Status: Accepted

## Context

ADR 0028 established deterministic physical Runtime-worker loss using a host PID
namespace helper and durable repair checkpoints. That proof killed worker PID 1
at the qualification checkpoint immediately after the full-agent invocation.

WAVE-10 introduced a second execution phase after the model-controlled child has
fully exited: a typed behavior CommandSpec is executed through the isolated
Docker behavior gateway under the same PostgreSQL lease/fence. Killing the
worker before that phase proves durable model recovery, but it does not prove
what happens when the worker owns an in-flight HTTP request to the gateway and
dies while the gateway owns a real Docker behavior container.

The WAVE-10 data-plane preflights separately proved:

- post-commit source-attested image materialization;
- capability/fence authorization;
- in-flight fence replacement revocation;
- PostgreSQL outage fail-closed behavior and same-gateway recovery;
- gateway outage fail-closed behavior.

The remaining boundary is the composition of physical worker loss with the
behavior data plane.

## Decision

R-9 remains the single authoritative physical-worker-loss qualification. It is
extended rather than duplicated.

For the R-9 semantic workload, qualification arms the internal boundary
`repair-checkpoint-before-behavior` for Technical Refinement attempt 1 and
injects the committed CommandSpec `qualification.behavior.delay`.

The qualification-only CommandSpec injection is deterministic and model
independent:

1. it activates only for the exact internal boundary;
2. task/stage and semantic attempt filters must match;
3. the CommandSpec id must use the `qualification.*` namespace;
4. command authority is derived from the same trusted committed project
   configuration used by normal Runtime admission;
5. any pre-existing command authority must equal the derived authority exactly;
6. all qualification environment controls default to blank.

The OpenCode executor writes the existing
`runtime-repair-checkpoint/v1` with
`repairKind=qualification-process-loss` after the completed full-agent
invocation. Under the new pre-behavior boundary it does not sleep or throw; the
executor completes normally so the Rust worker can enter the behavior phase.

The standalone qualification controller must not kill the worker based on the
checkpoint alone. It must first prove both:

- an authoritative `behavior.gateway.started` event for the source
  attempt/generation/fence; and
- the exact fence-derived Docker behavior container is physically
  `State.Running=true`.

Only then may it send SIGKILL to worker PID 1 using the existing host-PID
namespace helper.

After process loss, qualification requires:

- the source behavior container is physically removed;
- the behavior gateway container, PID and RestartCount are unchanged;
- only the exact killed execution lease is forced expired;
- worker RestartCount increases exactly once and host PID changes;
- replacement preserves the semantic task attempt;
- replacement dispatch generation and fencing token each advance exactly once;
- the durable repair checkpoint effect key is unchanged;
- `skippedFullAgentInvocation=true`;
- replacement behavior starts under the replacement fence;
- its physical container becomes running;
- `behavior.gateway.completed` returns
  `PASSED / docker_gateway_behavior_passed` with one receipt;
- the replacement behavior container is removed;
- the semantic run closes successfully.

After R-9, both Context Engine and Runtime worker are recreated with all
qualification-only controls disarmed before R-10 starts.

## Consequences

The physical-loss proof now covers the complete Runtime execution lifecycle,
not merely the model child.

A failed source behavior execution is retried under a new physical fence, while
the completed semantic model invocation is recovered from its durable
checkpoint rather than repeated.

No Docker socket is added to the worker and no production task receives an
implicit behavior CommandSpec. The behavior gateway remains the only Docker
authority.

The qualification still uses the same semantic R-9 workload and therefore does
not add another model run solely for WAVE-10 worker-loss coverage.

## Rejected alternatives

### Add a second independent worker-loss preflight

Rejected because it would duplicate Runtime setup, lease-recovery logic and
model cost while creating two competing physical-loss authorities.

### Kill the worker immediately after the repair checkpoint

Rejected because it proves process recovery before the behavior phase and
cannot establish client-disconnect revocation of a real behavior container.

### Let the model choose the qualification CommandSpec

Rejected because the physical-fault boundary must be deterministic. Model
selection of `commandSpecIds` is semantic plan content, not qualification
authority.

### Kill a behavior container directly

Rejected because that does not prove worker HTTP disconnect, worker restart,
lease expiry, checkpoint resume or replacement fencing.
