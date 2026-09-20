# Implementation wave 02 — explicit projects and Docker-first inspection

Authorization: the user requested continuation of the approved implementation.
Branch: fix/agent-start-current-user-message-authority-20260919.
Harness parent: 119484ea08378f7e4a2c2765df0682b87296f2e6.
Consumer observed parent: a2b6b7e49cd9c2ed34e5257b87f2992c7a818bbb.
No agent run, design review, runtime acceptance or target-host fact is fabricated.

## Delivered implementation

T01 additional slice: strict ProjectDescriptor/v1 and CommandSpec/v1 validators,
reference/cwd/protected-path consistency, stable identity and an explicit absence
of authorization. DockerRunnerRef/v1 from wave 01 is reused, not duplicated.

T03 initial slice: bounded read-only project inspection; known metadata markers
for Node, Python, Go, Rust, JVM, .NET and docs, with explicit module roots and
caller-assigned project/repository IDs. It reports suggestions, not complete
adapter/toolchain conformance. Conflicting manager metadata remains unresolved.
Project metadata is never executed and host SDKs are not discovery prerequisites.

An independent CLI loads `.agent-harness/project.json` or discovers proposals.
It builds exact native Docker argv plans with admission still pending, and can
optionally query Docker identity read-only. That probe does not evaluate Compose
YAML/env files, start containers, exec product code, install dependencies or
fall back to host toolchains. It observes daemon/image/platform and precise
Compose labels/replica/instance/restart; its successful result remains PARTIAL.
Source, mounts, config, toolchain, behavior and trust are not certified by it.

The CLI is an actual caller of the libraries, not a new harness:* alias. Existing
runtime schemas, broker/command execution, and T13 integration remain unchanged.
Commands are never executableNow, irrespective of descriptor validity.

## SDD/TDD and evidence

Initial RED: the requested API/module did not exist (import failure). This is
feature absence, not claimed reproduction of a bug in the preexisting runtime.
After the first implementation, 64 new tests passed. Additional behavioral
hardening tests produced 70 pass / 4 fail: explicit project cwd was not forwarded
to the probe executor, JSON null metadata was treated as absent, nested reserved
module roots were accepted, and container mapping was not rechecked. These defects
in the new implementation were fixed before publication.
A further targeted RED exposed unnecessary Compose config evaluation in the
identity probe; querying exact engine labels replaces it, avoiding interpolation
of private env/includes during this read-only observation.

Final result: 77 new tests plus the 74 wave-01 tests = 151 PASS, 0 FAIL, 0 SKIP.
Tests run in Linux sandbox Node v22.16.0 / Git 2.47.3, no remote model calls.
They include filesystem/JSON/CLI behaviors and simulated Docker responses.
A native CLI test with empty PATH also confirms Docker-unavailable HOLD and
absence of silent host fallback. This is NOT successful live Docker evidence.
Syntax checks of the added .mjs files also pass.

Docker CLI/daemon are unavailable in this sandbox. The dedicated Docker target,
real daemon/container tests, Windows matrix, aggregate harness:test and full
Runtime qualification are NOT_RUN. No qualification-speed gain is claimed.
The Dockerfile tests controller libraries; it does not represent a Python/ML
product target nor run a Docker daemon nested in the test container.

## Boundaries, ownership and preservation

Code is confined to T01/T03 paths: packages/harness-contracts/src/project-descriptor,
packages/project-adapters/** and tests/contracts/project-descriptor.test.mjs.
Progress documents are host handoff artifacts. No root dependency registration
or package-lock edits precede T13. No edits to caches, memory, worker, routing,
credentials, endpoints, .harness, consumer lock or main. That is patch scope,
not a fresh operational parity proof of P01-P16.

This is not completion of T01/T03. Outstanding: authenticated descriptor/policy
admission, general/noncontainer/Windows runner adapters, full metadata grammars,
module discovery policy, toolchain dependency checks, approved execution,
source/config/mount/secret/network/entrypoint enforcement, active schema and CLI
integration, target-host T00/C00, performance and release/consumer proofs.

## Local validation and next implementation boundary

Run packages/project-adapters/Dockerfile target `test` with the selected Git
archive context described in its README. Capture the exact image ID and output.
Do not mount Docker socket or product credentials into the test container.
The independent read-only CLI is documented in that README; --docker-identity
requires a supplied resolved runner declaration and an explicit opt-in.
Never turn a PARTIAL observation or generated argv into permission to execute.

MANIFEST.json is intentionally unchanged: a full byte-verified checkout is not
available here. Use only the official generator on the complete checkout when
freezing a candidate, review/commit then check. No hand-calculated manifest and
no inheritance of earlier PASS. Do not promote main or move the consumer gitlink.
C01/C02 remain gated by T02/T10/T13/T21; consumer receives a dependency handoff only.
