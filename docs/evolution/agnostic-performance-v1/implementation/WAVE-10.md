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
- places model-owned handoff/repair artifacts under a dedicated
  `agent-output-attempt-N/` subdirectory;
- validates that log/result/change-set remain in the root-owned parent task
  directory and grants UID 10001 write authority only to the per-attempt model
  output subdirectory;
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

### Constructible post-commit source-attested images

Target validation exposed a pre-runtime authority defect in the WAVE-08 local
image model. A one-off descriptor that embeds its future image digest cannot
also be part of the source snapshot stamped into that same image without
creating a self-reference.

ADR 0042 adds `image.mode=source-attested-build` for locally built one-off
runners. In this mode:
- the committed descriptor carries no future image digest;
- `buildTarget` is mandatory;
- the image is built only after the consumer commit exists;
- the trusted builder stamps the existing sourceSnapshot/runnerSpec/sourceBinding
  authority labels from that commit;
- materialization resolves exactly one image matching all three labels;
- missing or ambiguous matches HOLD;
- subsequent toolchain and behavior execution use only the immutable materialized
  image ID.

The standalone qualification fixture now commits a real ProjectDescriptor/v2
and execution policy, builds a Node behavior runner after the exact harness
gitlink commit, proves materialization + source attestation in R-3, and starts
the isolated behavior gateway in R-4 on the same Runtime workspace volume.

### Gateway Docker CLI compatibility

The first deterministic live preflight on candidate
`3e091f1083509758971aaa1c14e5f73a9b972713` reached the real Docker behavior
executor and failed only at container creation with Docker exit code 125.

Evidence proved that command authority, committed config, workspace binding,
source-attested image materialization, image attestation, toolchain readiness,
HMAC capability verification and execution-fence admission had all succeeded
before the failure.

Root cause: `apps/docker-gateway/Dockerfile` inherited Debian Bookworm's
`docker.io` package (20.10.24), while the behavior executor requires
`--mount ... volume-subpath=...`. Docker added `volume-subpath` support in
CLI/Engine 26.0 / API 1.45.

Correction:
- gateway now copies the official Docker CLI 27.5.1 from
  `docker:27.5.1-cli`;
- the Debian `docker.io` package is no longer installed in the gateway;
- the live preflight probes the gateway's actual Docker client version and
  daemon API before behavior execution;
- client major <26 or server API <1.45 fails with
  `wave10_preflight_docker_subpath_runtime_unsupported`;
- contracts pin this compatibility boundary so a base-image/package regression
  cannot silently reintroduce exit 125.

### Deterministic live preflight before LLM qualification

A dedicated host-side preflight now exercises the complete behavior data plane
without invoking OpenCode or any model:

`scripts/qualification/wave10-live-preflight.mjs`.

It:
- requires a clean exact harness HEAD;
- creates a disposable Git consumer and pins that exact harness as a gitlink;
- builds the `source-attested-build` runner after the consumer commit;
- proves image materialization and source attestation;
- starts only PostgreSQL, migrations and the isolated Docker behavior gateway;
- copies the committed consumer workspace into the real shared Runtime volume;
- inserts a real running task fence plus HMAC capability checkpoint into
  PostgreSQL;
- sends the raw capability to the gateway through process stdin so ProcessRunner
  evidence never serializes it in argv or command logs;
- executes `qualification.behavior.tests` through the real gateway;
- requires one `BEHAVIOR_PASSED` receipt bound to the expected source snapshot;
- verifies the exact fence-derived Docker container name no longer exists;
- performs compose-volume/image/temp-workspace cleanup and converts cleanup
  failure to HOLD.

The behavior CommandSpec is intentionally scoped to
`node --test test/format-name.test.mjs`; it cannot accidentally traverse the
pinned `.harness` submodule and relabel harness-contract execution as consumer
behavior evidence.

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
- attempt-scoped model-output write authority without write access to Task Brief,
  context, descriptor, log or result authority files;
- behavior result/finalizer projection.

The actual TAP count is authoritative; do not gate on the older approximate
WAVE-09/WAVE-10 test-count estimate.

Rust:
`cargo test --locked --manifest-path apps/runtime-worker/Cargo.toml`

must pass. `cargo fmt --manifest-path apps/runtime-worker/Cargo.toml -- --check`
must also pass after the Rust hardening changes.

Because source identity hashes all committed tracked files, qualification is
always exact-SHA. Candidate `e6dd924745c396ec03a05372b87c0d89bd23888e`
was operator-confirmed GREEN for focused Node contracts, Rust fmt +
`cargo test --locked`, Compose config, Docker contract target (264/264), and
the worker/gateway image builds. That evidence closes the preceding static
REDs, but it became historical-only when ADR 0042 and the source-attested
runtime fixture changed tracked source. The next candidate must rerun the cheap
source/build gates before live WAVE-10 faults are armed.

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
