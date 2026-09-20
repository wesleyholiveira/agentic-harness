# Implementation wave 03 — policy contract and Docker image toolchain probe

Authorization: continuation of the approved SDD/TDD implementation.
Branch: `fix/agent-start-current-user-message-authority-20260919`.
Parent: `e64d25346b810f9dd5390f897a0ff2f29a1f933c`.

## Operator feedback from WAVE-02

The supplied log reports 151 tests, 151 PASS, 0 FAIL, 0 SKIP. It ends after the TAP summary with a Bash parse error near a closing parenthesis. That confirms the focused suite result, but the pasted excerpt does not include Docker context/image/build/run identity. Therefore this document records the focused suite as operator-GREEN and keeps the Docker-target identity proof NOT_VERIFIED rather than relabeling it.

## Delivered slice

T01/T04 foundation adds `execution-policy/v1`. A policy binds an exact ProjectDescriptor digest, CommandSpec digest and Docker runner digest and constrains validation scope, network declaration, effects, timeout and whether opaque secret references are permitted. Structural satisfaction returns `CONTRACT_SATISFIED` but explicitly keeps `trustVerified=false` and `authorization=pending-source-trust`. A caller cannot turn a JSON boolean into trusted policy through this API.

T03 toolchain slice adds `probeDockerImageToolchain`. It accepts the previously observed Docker target identity and verifies runtime-language tools by executing adapter-owned version probes in the immutable image ID. It never dispatches CommandSpec executable/argv. The Docker invocation is native argv (no shell), `--pull never`, `--network none`, read-only root, bounded tmpfs, dropped capabilities, no-new-privileges, bounded pids, declared platform/user/workdir and immutable image ID. Python has the deterministic python→python3 fallback; Rust requires rustc+cargo. Node/Go/Java/.NET have fixed probes. Unknown/docs-only languages HOLD until an adapter declares a safe probe.

The probe never returns raw stdout/stderr. It returns parsed version + output SHA-256, remoteCalls=0, and no qualification verdict. A TOOLCHAIN_VERIFIED receipt proves the fixed version probe in that image, not service mounts/config/source trust, behavior tests, release qualification or policy trust.

The read-only inspection CLI gains `--toolchain`, which requires `--docker-identity`. It can perform the fixed probe after target identity is observed. It still does not execute the project's behavior command and does not make the command executable.

## TDD status

New test source: `tests/contracts/command-admission-v2.test.mjs`.
The tests cover exact grants, changed descriptor/command/runner, scopes/network/effects/timeouts/secrets, absence of source trust, fixed Docker argv, no use of project behavior argv, Python fallback, target mismatch without spawning, redacted malformed output, Docker absence without host fallback, unsupported/docs-only languages, Rust dual capability and Java stderr version parsing.

These new tests have NOT been executed by this remote publication environment. The dedicated Docker target now includes them. Expected aggregate if WAVE-01/WAVE-02 remain green is 173 tests, but only actual execution may establish the count/result.

## Boundaries

This wave does NOT yet load/trust an execution policy from the committed source, enforce network/effects for arbitrary behavior commands, execute validation commands, replace the active string validation schema, or integrate Technical Refinement/executor. Those remain T02/T04/T13 slices. The current v1 DockerRunnerRef includes materialized identity fields; the next source-trust slice must resolve declaration-vs-materialization identity without circular source hashing before policy activation.

No cache/memory/worker/model-routing code, consumer pin, lock, manifest or main is changed. Manifest regeneration and source qualification remain deferred to source freeze.
