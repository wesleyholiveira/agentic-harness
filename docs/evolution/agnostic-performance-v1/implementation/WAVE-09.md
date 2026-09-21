# Implementation wave 09 — restricted Docker gateway and command-authority propagation

Authorization: continuation of the approved SDD/TDD implementation.
Branch: `fix/agent-start-current-user-message-authority-20260919`.
Parent: `83b517606f889a35d126bf9f55cde0b917292ad8`.

## Goal

Prepare active typed behavior execution without giving the Rust worker or
model-controlled process direct access to the Docker socket.

## Delivered

### commandAuthority/v1 propagation

Technical Refinement now mechanically binds the committed CommandSpec catalog to:

- projectId;
- repositoryId;
- sourceCommit;
- sourceSnapshotSha256;
- descriptorDigest;
- policyDigest.

This `commandAuthority/v1` value is Runtime-canonicalized from the committed
ProjectDescriptor/ExecutionPolicy loader.

It is:
- represented in the Implementation Plan schema;
- injected/canonicalized before semantic repair;
- fixed as a const in the dynamic Technical Plan schema;
- propagated into implementation DAG tasks;
- propagated into Task Brief v2.

Legacy workspaces without committed ProjectDescriptor/v2 have no commandAuthority
and retain the legacy bridge.

### Workspace mounting semantics

The WAVE-08 behavior executor now accepts an optional explicit named-volume
workspace mount.

For the gateway path it uses:

`--mount type=volume,src=<volume>,dst=<containerCwd>,readonly,volume-subpath=<task-subpath>`

and resolves `CommandSpec.cwd` below `DockerRunnerSpec.containerCwd`.

This avoids passing a path that exists only inside the gateway container as a
host bind-source to the Docker daemon.

### Restricted Docker behavior gateway

New application:
- `apps/docker-gateway/server.mjs`
- `apps/docker-gateway/Dockerfile`

Narrow endpoint:
`POST /v1/behavior`

The request may contain only:
- commandAuthority;
- commandSpecIds;
- executionFence;
- workspacePath.

The gateway independently:
1. reloads the exact committed config at commandAuthority.sourceCommit;
2. compares all command-authority identity fields;
3. verifies task workspace authority inputs;
4. resolves the gateway's exact shared Docker volume by inspecting its own mount;
5. materializes the declared runner;
6. verifies source-bound image attestation;
7. probes the declared container/image toolchain;
8. executes each authorized CommandSpec through the WAVE-08 admission chain.

Any mismatch returns HOLD. Behavior nonzero exit returns FAILED. Raw command
stdout/stderr are not returned.

### Compose isolation

`docker-behavior-gateway` uses the separate `behavior-gateway` profile.

Only that service receives `/var/run/docker.sock`.
The `agent-runtime-worker` still has no socket and receives no gateway token.

The gateway:
- exposes port 8792 only on the Compose network, not the host;
- uses read-only project/workspace mounts;
- uses a read-only root filesystem;
- drops all capabilities;
- enables no-new-privileges;
- requires a bearer token of at least 32 bytes.

This is deliberate staging: the gateway can now be qualified in isolation before
the token/client is introduced into the worker.

## TDD

New:
`tests/contracts/docker-behavior-gateway-v1.test.mjs`

Coverage:
- strict request envelope and duplicate-ID rejection;
- workspace subpath escape rejection;
- exact named-volume resolution;
- command-authority mismatch before any Docker activity;
- end-to-end gateway orchestration using controlled dependency seams;
- behavior failure propagation;
- token minimum;
- Compose proves socket only on gateway;
- Runtime mechanical commandAuthority propagation;
- dynamic Technical Plan commandAuthority const.

Existing `command-spec-execution-v2.test.mjs` gains a test proving
`CommandSpec.cwd` resolves below the read-only mounted workspace, and its
behavior-argv test now checks the named-volume subpath mount.

11 new cases total.

If the WAVE-08 baseline is 236 as expected by its published suite, the WAVE-09
focused total is expected to be 247. This is an expectation only until executed.

## Boundary

Not yet active:
- Rust worker HTTP client/token;
- gateway call under the worker's live heartbeat/cancellation loop;
- behavior receipt in AgentExecutionResult;
- failure projection in event-driven finalization;
- build pipeline stamping source-attestation image labels.

No main, consumer pin, caches, ProjectMemory, semantic cache or model routing
changes are included.
