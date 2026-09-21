# Implementation wave 10 — Rust worker gateway integration under fence

Authorization: continuation of the approved SDD/TDD implementation.
Branch: `fix/agent-start-current-user-message-authority-20260919`.
Parent: `5184ac3c604530ad024fd09b7d66818b480f2080`.

## Goal

Activate committed CommandSpec behavior validation in the event-driven Rust
worker without exposing Docker socket authority or a reusable gateway bearer
credential to the model-controlled process.

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

### Restricted model process

For behavior-gated tasks the Rust worker:
- creates UID/GID 10001 (`agentexec`) at image build time;
- chowns only the isolated task workspace and a task-scoped temporary HOME;
- copies OpenCode auth into that temporary HOME;
- removes PostgreSQL/RabbitMQ/gateway/HMAC env variables from the child;
- spawns the child as UID/GID 10001;
- starts it in a dedicated Unix process group.

After the main executor exits, the worker drains bounded output, terminates the
isolated process group (TERM then KILL), removes the temporary HOME and only then
mints gateway capability material.

This prevents surviving model descendants from observing the post-agent gateway
capability or root worker environment.

Legacy/non-typed tasks retain the prior execution UID behavior.

### Fence-bound one-time-style capability

The worker generates two UUIDv4 values concatenated into a 64-hex capability
after model execution.

The persisted checkpoint never contains the raw capability. Its fingerprint is:

HMAC-SHA256(
  secret,
  runId || taskId || attempt || dispatchGeneration || fencingToken ||
  leaseOwner || capability
)

The HMAC key:
- is optional for legacy tasks;
- must be at least 32 bytes for typed behavior execution;
- has no default;
- is present only in worker/gateway service environment;
- is explicitly removed from the model child environment;
- is not serialized into descriptor, checkpoint payload, result or logs.

### Gateway PostgreSQL verification

The gateway now lazily creates one PostgreSQL pool per process.

Before loading committed configuration or using Docker, it verifies:
- run is running;
- task is running;
- attempt matches;
- dispatch generation matches;
- fencing token matches;
- lease owner matches;
- lease has not expired;
- checkpoint HMAC proof matches the supplied raw capability.

A capability mismatch, stale fence or expired lease returns HOLD before Docker.

The prior long-lived bearer-token constructor was removed.

### Rust gateway client with lease supervision

New module:
`apps/runtime-worker/src/behavior_gateway.rs`.

While waiting for the gateway:
- lease heartbeat continues every 15 seconds;
- heartbeat update is owner/generation/fence scoped;
- the worker checks cancellation/fence every second;
- gateway HTTP timeout is bounded by configuration;
- after response, the worker verifies the same active fence again.

Transport/fence failures become a redacted HOLD receipt.

### Result/finalizer integration

`AgentExecutionResult` now optionally carries `behaviorGate`.

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

## Tests

Node focused suite additionally includes `runtime-regressions.test.mjs`.
Compared with the WAVE-09 focused suite, WAVE-10 adds:
- capability rejection before config/Docker;
- HMAC/fence mismatch and expiration behavior;
- Rust/source execution-order contracts;
- sensitive child-env removal;
- capability/HMAC PostgreSQL contracts;
- UID/process-group/temporary-HOME teardown contracts.

Expected focused total is approximately 257 based on the prior 247 expectation;
the actual test runner output is authoritative.

Rust:
`cargo test --locked --manifest-path apps/runtime-worker/Cargo.toml`

must also pass, including new capability/HMAC unit tests.

Docker builds for both `agent-runtime-worker` and `docker-behavior-gateway`
are required because this wave changes compiled Rust and both images.

## Residual risks / next gates

Before release promotion:
- prove WAVE-10 focused/Docker/Rust build gates;
- run an end-to-end typed behavior task with behavior-gateway profile enabled;
- stamp real runner images with WAVE-08 source-attestation labels;
- inject a fence replacement during an in-flight gateway command;
- inject gateway/PostgreSQL outage;
- qualify process-loss recovery with behaviorGate present;
- consider a separate model execution network namespace and least-privilege DB
  credentials to remove remaining control-plane network reachability.

No main, consumer pin, L1/L2, semantic cache, ProjectMemory or model-routing
changes are included.
