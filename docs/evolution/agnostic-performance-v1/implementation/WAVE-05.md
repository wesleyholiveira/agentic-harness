# Implementation wave 05 — workspace authority binding and Docker v2 materialization/toolchain chain

Authorization: continuation of the approved SDD/TDD implementation.
Branch: `fix/agent-start-current-user-message-authority-20260919`.
Parent: `604286ec452698c26a0a8da3683c290a90610124`.

## Status before this wave

The operator confirmed the earlier WAVE-03 Windows correction run completed correctly. The later Clip Compass rebase/push also completed correctly. WAVE-04 focused/Docker suites have not yet been supplied as machine evidence and therefore remain NOT_RUN rather than inferred PASS.

## Goal

Join committed source/policy trust to the actual mutable task workspace and the actual Docker target without yet executing a project behavior command. The result must be a readiness state that proves the toolchain in the declared container while keeping effects/network/secrets/behavior execution disabled.

## Delivered slice

### Workspace authority-input binding

`bindWorkspaceAuthorityInputs` observes only command-authority inputs inside a task workspace:
- `.agent-harness/project.json`;
- the committed policy file;
- declared Compose files;
- declared dependency files.

Each physical workspace file must be regular/non-symlink and match the hash from the committed source binding. Owned implementation files may legitimately differ from the source commit. This avoids an impossible requirement that a post-implementation validation workspace be globally byte-identical to the base commit.

The result is a point-in-time `workspace-authority-binding/v1` with its own digest. It is never a reusable capability token and never sets executableNow=true.

### DockerRunnerMaterialization/v1 production observer

`probeDockerRunnerMaterialization` resolves the live Docker target from a DockerRunnerSpec/v2 + DockerRunnerSourceBinding/v1.

For `exec` runners it:
- verifies Docker context/daemon;
- selects exact Compose project/service/replica by labels;
- requires a single running non-oneoff container;
- verifies configured user/workdir and image platform;
- binds immutable image ID, container ID, public config digest and redacted mount projection;
- re-inspects the container and membership to reject restart/replacement/drift.

For `one-off` runners it resolves only the digest-pinned image and never creates a container.

The mount projection deliberately omits raw bind-source paths and environment values from emitted evidence.

### Docker toolchain v2

`probeDockerToolchainV2` requires:
- committed project configuration with source/policy trust;
- a valid workspace authority binding;
- a valid DockerRunnerMaterialization bound to the same source/spec.

For `exec`, fixed adapter-owned probes run **inside the exact observed container ID** using native `docker exec` argv. For `one-off`, probes run from the immutable image using `--pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges`.

It never dispatches the project CommandSpec executable/argv. After probing, it re-observes the runner; materialization identity ignores only observation timestamp and rejects changed daemon/image/container/config/mount identity.

### Command readiness

`evaluateCommandReadiness` joins:
committed source/policy admission + workspace binding + materialization + trusted toolchain receipt.

The strongest success in this wave is `TOOLCHAIN_READY`, with:
- sourceTrustVerified=true;
- policyTrustVerified=true;
- workspaceBindingVerified=true;
- materializationVerified=true;
- toolchainVerified=true;
- effectsEnforced=false;
- networkEnforced=false;
- secretsResolved=false;
- behaviorAuthorized=false;
- executableNow=false;
- qualificationVerdict=null.

This prevents the new chain from being mistaken for permission to execute behavior.

## TDD

New suite: `tests/contracts/command-readiness-v2.test.mjs`.

Coverage includes:
- authority-input binding while arbitrary implementation files change;
- tampered descriptor/policy/Compose/lock rejection;
- workspace-binding digest forgery rejection;
- exact exec materialization and redacted mount evidence;
- wrong user and restart/replacement HOLD;
- one-off image materialization without container creation;
- fixed Node toolchain probe inside exact container;
- untrusted configuration preventing process spawn;
- materialization drift after toolchain probe;
- materialization identity timestamp semantics;
- TOOLCHAIN_READY remaining non-executable;
- receipt/workspace identity mismatch HOLD.

The foundation Docker target includes all WAVE-01..WAVE-05 focused suites. Expected total is 204 tests if prior suites remain unchanged, but this is only an expectation; actual host/Docker execution must establish the result.

## Boundaries and next slice

Still not implemented:
- behavior command execution;
- workspace lease enforcement immediately around command execution;
- network/effects/secret enforcement;
- active Technical Refinement schema migration from arbitrary command strings to commandId;
- Runtime executor bridge consuming TOOLCHAIN_READY;
- T10 trusted reusable receipts;
- T13 public profile/subject CLI integration;
- full context-economy parity/qualification.

No L1/L2/semantic cache/ProjectMemory/worker/model-routing/consumer pin/main changes are included. The consumer continues to use its qualified harness pin until a later release candidate is actually qualified.
