# Implementation wave 07 — committed CommandSpec IDs and bounded Docker behavior executor

Authorization: continuation of the approved SDD/TDD implementation.
Branch: `fix/agent-start-current-user-message-authority-20260919`.
Parent baseline: WAVE-06.

## Baseline evidence

WAVE-05 focused machine log: 203/203 PASS, 0 FAIL, 0 SKIP.
WAVE-06 Docker target: GREEN by operator confirmation; exact image/context/test
count were not supplied and are not inferred.

## Goal

Introduce real committed `CommandSpec.id` references into active Technical
Refinement and provide a behavior executor only for the subset whose effects,
network and secret boundaries are enforceable with current Docker primitives.

## Delivered

### Committed CommandSpec catalog

`packages/project-adapters/src/command-spec-catalog.mjs` loads the committed
ProjectDescriptor/v2 through the WAVE-04 trust path and projects a bounded
CommandSpec catalog.

- non-Git/legacy workspaces => catalog absent, existing path preserved;
- committed v2 config => exact source/policy-bound catalog;
- committed but invalid v2 config => fail closed;
- model-authored plans never create catalog authority.

### Technical Refinement `commandSpecIds`

Implementation Plan and Task Brief schemas now accept optional
`commandSpecIds`.

The dynamic Technical Refinement schema enumerates IDs only from the committed
CommandSpec catalog. Unknown IDs are deterministic plan issues.
The prompt receives the bounded committed catalog and is instructed to select
only materially relevant IDs.

The DAG and Task Brief propagate these IDs. The Task Brief explicitly states
that selection is not execution authorization.

Legacy projects with no committed v2 descriptor continue to use the existing
`validation` + `validationCommandIds` bridge.

### Behavior admission

`evaluateBehaviorAdmission` starts from WAVE-05 `TOOLCHAIN_READY` and the
exact CommandSpec.

WAVE-07 authorizes behavior only when all of the following are true:

- CommandSpec.phase = behavior;
- Docker runner is one-off;
- networkPolicy = none;
- effects = [read-only];
- secretRefs = [];
- envAllowlist = [];
- dependencyPolicy = none;
- validationScope is workspace or container;
- source/policy/workspace/materialization/toolchain identities all match.

Anything broader returns HOLD. In particular, Docker exec is not considered
enforceable yet because it inherits service network/env/mount state.

### Docker behavior executor

`executeDockerBehaviorCommandV2` executes only an admitted CommandSpec using
native Docker argv and the immutable materialized image.

Enforcement:
- no shell;
- --pull never;
- --network none;
- --read-only;
- bounded tmpfs;
- cap-drop ALL;
- no-new-privileges;
- bounded pids;
- declared platform/user/workdir;
- exact CommandSpec executable + argv;
- no env/secrets;
- bounded output.

The receipt contains output hashes/byte counts, exit code and all authority
identities but not raw stdout/stderr. Nonzero exit is BEHAVIOR_FAILED, not an
authorization error.

The runner is re-observed after execution; materialization drift yields HOLD.

## TDD

New suite: `tests/contracts/command-spec-execution-v2.test.mjs`.

It covers:
- legacy/non-Git absence;
- committed catalog discovery;
- dynamic schema enum;
- unauthorized CommandSpec IDs;
- enforceable one-off admission;
- HOLD for exec/workspace-write/network/secrets/env/dependencies;
- native immutable-image behavior execution;
- nonzero behavior result;
- post-execution materialization drift;
- receipt/workspace mismatch.

15 new tests are added. If the WAVE-06 focused suite is 210 as expected from the
203 proven WAVE-05 baseline plus 7 WAVE-06 cases, the next expected focused total
is 225. This remains an expectation until executed.

## Boundary

The new behavior executor is a library and is not automatically invoked by the
current Runtime executor in this wave. Active runs therefore do not gain new
execution behavior before target validation.

Still pending:
- active executor bridge;
- workspace lease/fence binding immediately around behavior execution;
- enforceable exec-service network/env/mount policy;
- secret resolution;
- workspace-write effect enforcement;
- T10 reusable trusted receipts;
- T13 public CLI/profile integration;
- T21 context-economy parity and full qualification.

No main, consumer pin, L1/L2, semantic cache, ProjectMemory, worker or model-routing
changes are included.
