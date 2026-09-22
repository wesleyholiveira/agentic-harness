# Implementation wave 10 — Rust worker gateway integration under fence

Authorization: continuation of the approved SDD/TDD implementation.
Branch: `fix/agent-start-current-user-message-authority-20260919`.
Parent: `5184ac3c604530ad024fd09b7d66818b480f2080`.

## Goal

Activate committed CommandSpec behavior validation in the event-driven Rust
worker without exposing Docker socket authority, Runtime control-plane
credentials or a reusable gateway bearer credential to model-controlled
processes.

## Delivered

### Behavior-gate descriptor

`event-driven-preparation.mjs` emits `behaviorGate` only when an implementation
Task Brief carries non-empty committed `commandSpecIds`.

The descriptor contains only:
- commandAuthority/v1;
- commandSpecIds;
- isolated workspacePath.

It does not contain capability material, PostgreSQL credentials or Docker access.

Typed behavior execution requires workspace mode `copy`; `none` fails closed.

### Model-wide restricted executor boundary

Every model-controlled `executionMode=agent` now executes through the
restricted model boundary, whether or not the task has a behavior gate.

The Rust worker:
- requires an isolated `copy` workspace for model-controlled execution;
- creates UID/GID 10001 (`agentexec`) at image build time;
- chowns the isolated task workspace and a task-scoped temporary HOME;
- validates that handoff/log/result/change-set paths share one task output
  directory and grants UID 10001 write authority only at that directory root;
- copies OpenCode auth into the temporary HOME;
- removes PostgreSQL, RabbitMQ, Redis/cache, behavior-gateway/HMAC and OpenCode
  continuation credentials from the child environment;
- spawns the child as UID/GID 10001;
- starts every model-controlled child in a dedicated Unix process group.

The worker image installs a UID-scoped egress guard. At startup it:
- allows UID 10001 to reach the exact `context-engine` service address on TCP
  8789;
- rejects private/link-local IPv4 and private/link-local IPv6 destinations for
  UID 10001;
- leaves public provider/model endpoints reachable;
- installs the rules while the container has `NET_ADMIN`;
- drops `NET_ADMIN` from the long-lived worker bounding/inheritable/ambient
  capability sets before the Rust worker starts;
- enables `no-new-privs` for the worker and descendants.

After a model executor exits, the worker drains bounded output and terminates
the isolated process group. For behavior-gated tasks, the temporary HOME is
removed and only then is gateway capability material minted.

This prevents a model child or surviving descendant from reading the root
worker environment or reaching PostgreSQL/RabbitMQ/Redis/the Docker gateway
through the worker network.

### Fence-bound ephemeral capability

The worker generates two UUIDv4 values concatenated into a 64-hex capability
only after model execution.

The persisted checkpoint never contains the raw capability. Its proof is:

HMAC-SHA256(
  secret,
  runId || taskId || attempt || dispatchGeneration || fencingToken ||
  leaseOwner || capability
)

The HMAC key:
- is optional for legacy/non-behavior execution;
- must be at least 32 bytes for typed behavior execution;
- has no default;
- is present only in the trusted worker/gateway service environment;
- is explicitly removed from model child environments;
- is not serialized into descriptor, checkpoint payload, result or logs.

### Gateway PostgreSQL verification

The gateway lazily creates one bounded PostgreSQL pool per process.

Before loading committed configuration or using Docker, it verifies:
- run is running;
- task is running;
- attempt matches;
- dispatch generation matches;
- fencing token matches;
- lease owner matches;
- lease has not expired;
- checkpoint HMAC proof matches the supplied raw capability.

Connection/query/statement timeouts are bounded so PostgreSQL degradation
fails closed instead of leaving behavior execution unsupervised.

A capability mismatch, stale fence, expired lease or capability-store outage
returns HOLD before Docker.

The prior long-lived bearer-token constructor remains removed.

### In-flight Docker revocation

Behavior Docker execution is asynchronous and receives a deterministic,
fence-bound container name.

While a behavior command is running, the gateway:
- re-verifies capability/fence authority against PostgreSQL on a bounded poll;
- verifies authority again after the Docker command exits and before accepting
  the receipt;
- aborts the Docker CLI and force-removes the named container when the fence is
  replaced, expires or becomes unverifiable;
- aborts and removes the named container when the worker HTTP client disconnects;
- performs repeated post-abort `docker rm -f` cleanup to cover daemon/create
  races.

Therefore losing authority is no longer only an observation in the Rust
worker: it actively revokes the already-started behavior container.

### Rust gateway client with lease supervision

Module:
`apps/runtime-worker/src/behavior_gateway.rs`.

While waiting for the gateway:
- lease heartbeat continues every 15 seconds;
- heartbeat update is owner/generation/fence scoped;
- the worker checks cancellation/fence every second;
- gateway HTTP timeout is bounded by configuration;
- after response, the worker verifies the same active fence again.

Transport/fence failures become a redacted HOLD receipt.

### Result/finalizer integration

`AgentExecutionResult` optionally carries `behaviorGate`.

The event-driven finalizer:
- records `behavior.gateway.result`;
- writes non-reusable `behavior.gateway.receipt` checkpoint evidence;
- maps FAILED to `behavior_validation_failed` (retryable code failure);
- maps HOLD to `behavior_gateway_hold` (fail-closed contract/authority failure).

The original model executor exit code is preserved separately.

### Docker authority remains isolated

Only `docker-behavior-gateway` receives `/var/run/docker.sock`.
The Rust worker still has no Docker socket.

The gateway profile uses:
- read-only root;
- read-only project/workspace mounts;
- dropped capabilities;
- no-new-privileges;
- no published host port.

## Tests and exact-SHA qualification

The focused Node suite includes `runtime-regressions.test.mjs` and now covers:
- capability rejection before config/Docker;
- HMAC/fence mismatch and expiration behavior;
- in-flight fence replacement abort;
- worker/client disconnect abort;
- deterministic fence-bound container naming;
- repeated revoked-container cleanup;
- bounded PostgreSQL verification;
- model-wide UID/process-group/temporary-HOME isolation;
- model child control-plane credential removal;
- UID-scoped private-network rejection with exact Context Engine exception;
- scoped task-output write authority;
- behavior result/finalizer projection.

The actual TAP count is authoritative; do not gate on the older approximate
WAVE-09/WAVE-10 test-count estimate.

Rust:
`cargo test --locked --manifest-path apps/runtime-worker/Cargo.toml`

must pass. `cargo fmt --manifest-path apps/runtime-worker/Cargo.toml -- --check`
must also pass after the Rust hardening changes.

Because source identity hashes all committed tracked files, the earlier
operator-confirmed gateway/worker image builds from 2026-09-21 are historical
evidence only. They predate the in-flight revocation, model-wide isolation and
task-output permission fixes. Both images and the Docker contract target must
be rebuilt on the exact frozen WAVE-10 candidate SHA.

## Remaining promotion gates

WAVE-10 remains fail-closed and is not promoted until all of the following are
green on one exact source SHA:

1. focused Node syntax/contracts;
2. Rust fmt and `cargo test --locked`;
3. `docker compose --profile runtime --profile behavior-gateway config`;
4. exact-SHA Docker contract target;
5. exact-SHA `agent-runtime-worker` and `docker-behavior-gateway` builds;
6. normal non-behavior model task regression under UID 10001;
7. end-to-end typed behavior task using a WAVE-08 source-attested runner image;
8. live in-flight fence replacement proving the named behavior container is
   removed and the old receipt cannot become authoritative;
9. gateway outage and PostgreSQL outage proving deterministic HOLD/fail-closed;
10. physical worker process loss while behavior execution is in-flight, proving
    client-disconnect revocation plus replacement-fence recovery;
11. no regression in existing L1/L2, semantic cache, ProjectMemory, model routing,
    durable continuation or Runtime qualification.

A dedicated least-privilege PostgreSQL role for the gateway remains optional
defense-in-depth: the gateway already owns the Docker socket and the model UID
cannot reach the private control-plane network. It is not used as a substitute
for any gate above.

No main or consumer qualified pin is changed by this wave. Clip Compass adoption
remains pending until WAVE-10 target qualification is green; its qualified
`.harness` pin/lock/certificate stays on the prior qualified release until T17
produces the next exact qualified harness release.
