# Implementation wave 01 — canonical identity and Docker evidence contracts

Authorization: user message 2026-09-20T19:50:53Z approved the documentation and
requested implementation to begin. This does not fabricate an agent run/review.
Branch: fix/agent-start-current-user-message-authority-20260919.
Source baseline: 3b05bcd0bab2689b602eed0a64c0666da2bdc08f.

## Delivered code, not a claim that the whole plan is complete

T01 initial slice: strict source identity and resolved DockerRunnerRef/evidence
contracts. Other T01 contracts and their runtime schema integrations are pending.
T02 initial slice: shared canonical v1 codec, independent v2 source identity,
bounded batch Git reader, read-only verifier/CLI, and integration with the
existing official manifest generator. Consumer reader migration, v2 distribution
activation, config/secret policy closure and release certificate integration are
pending; do not mark AP criteria fully accepted on unit evidence alone.

The independent foundation is implemented/tested while target-host portions of
T00/C00 remain unobserved. No unavailable target-host fact is assumed. Kernel,
cache, memory, runner dispatch and promotion are NOT activated by this wave.

## Reproduction and tests

The old official generator was materialized and checked against its exact Git
blob 5e520d94275f736f578e709be9b640f8f1710808. Six targeted tests against it gave
1 pass and 5 failures: extra per-file fields, unknown schema version, symlink-index
source, symlink-index manifest and forged fileCount were not rejected as required.

The new foundation tests also exposed hidden worktree changes under
assume-unchanged/skip-worktree and missing portable-path collision checks; those
were fixed before publication. The final focused suite passes 74 tests, 0 skips,
in a Linux sandbox using Node v22.16.0 and Git 2.47.3. It creates temporary local
Git repositories, including SHA-256 repositories; it does not use remote models.

Node/Git sandbox evidence is NOT evidence of the declared Docker execution target.
Docker CLI/daemon are unavailable here. Docker target, Windows matrix, aggregate
harness:test and full Runtime qualification are NOT_RUN, not PASS.

## Microbenchmark (not qualification latency)

Five samples over the same isolated 128-file fixture produced identical source
identities. Batch snapshot uses 6 Git processes total versus 128 per-file git-show
processes (the naive count excludes metadata). Local medians: 19.41ms batch and
238.40ms naive. This is not a measured reduction of the 30–50 minute qualification,
not a Docker benchmark and not a p95 claim. Raw samples are in the delivery bundle.

## Ownership and preservation

Code changes are confined to T01/T02 paths: packages/harness-contracts,
packages/source-identity, tests/contracts/portable-contracts.test.mjs,
tests/contracts/source-identity-v2.test.mjs and scripts/internal/source-manifest.mjs.
The Docker target lives inside the T02 package and is for these host-controller
libraries, not an invented product runtime. No package.json/lock registration is
added before the T13 owner integrates packages. Progress docs are host evidence.

L1/L2, semantic candidates, Redis pool, ProjectMemory, compact context, worker,
main-orchestrator policy, credentials, endpoints and deployed pin are untouched.
That proves no patch touched them, not that their runtime parity was re-executed.

## Next gate and manifest

Run the documented Docker test target in packages/source-identity/README.md.
Complete local T00/C00 observations and remaining contracts before widening scope.
Do not update .harness or promote main. The legacy MANIFEST.json remains unchanged
because no complete byte-verified source checkout was available in the sandbox;
no handcrafted replacement or previous qualification is reused. On the actual
clean checkout, use the official --write, review/commit, then --check when freezing
a candidate. This branch is implementation-in-progress, not a qualified release.

C01 continues to depend on T02/T10/T13 completion; the consumer received only a
C00 remote-observation handoff. Do not prematurely import a module absent from its
currently pinned harness.
