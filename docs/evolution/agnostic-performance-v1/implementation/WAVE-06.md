# Implementation wave 06 — typed validation command authority bridge

Authorization: continuation of the approved SDD/TDD implementation.
Branch: `fix/agent-start-current-user-message-authority-20260919`.

## Baseline

The operator supplied a machine log proving the focused WAVE-04/05 contract suite at 203/203 PASS, 0 FAIL, 0 SKIP. Docker target identity was not present in that pasted log and remains a separate proof.

## Problem

The active Technical Refinement contract still serializes implementation validation as shell command strings. The Runtime already builds an independent deterministic validation catalog, but persisted plans/tasks have no stable identity connecting a selected command back to that authority.

Replacing strings in one big step would break compatibility with current Task Brief/handoff/executor paths. This wave introduces a fail-closed typed bridge without granting any new behavior execution permission.

## Delivered

### validationCommandId

`.agents/runtime/validation-command.mjs` now derives:

`vcmd:sha256:<sha256(trimmed-byte-exact-command)>`

Only command-shaped values accepted by the existing validation-command contract can receive an ID. IDs are byte-sensitive apart from existing outer trim and are not semantic command IDs from ProjectDescriptor.

`validationCommandProjectionIssues` verifies index-for-index ID↔command projection.

### Independent catalog IDs

`buildValidationCommandCatalog` now emits `{id, command, source}`. The ID is created by the Runtime from independently discovered catalog evidence, never copied from the model-authored implementation plan.

This remains the LEGACY bridge catalog. A later executor wave will map committed ProjectDescriptor CommandSpec IDs to behavior execution. A `vcmd:sha256:...` must never be confused with `CommandSpec.id`.

### Technical Plan canonicalization

Implementation-plan schema accepts optional `validationCommandIds`.

Technical-plan normalization:
- upgrades a legacy byte-exact catalog command to its deterministic ID locally;
- when known IDs already exist, uses the catalog ID projection as authority instead of a conflicting model string;
- appends exact Product Owner verification commands only when independently present in the catalog;
- persists both IDs and the byte-exact legacy projection.

Missing IDs, unauthorized IDs and ID↔string projection mismatches are deterministic plan issues. Mechanical ID upgrades happen before semantic repair so a correct legacy plan does not spend a model call just to add IDs. Technical review repair applies the same mechanical canonicalization before deciding semantic scope.

### DAG and Task Brief

The DAG compiler verifies any supplied ID projection and propagates `validationCommandIds` into implementation tasks.

Task Brief v2 accepts the optional ID array and validates the ID↔command projection before writing the brief. This keeps the existing `validation` field compatible with current agents while adding a typed runtime-owned integrity link.

### Execution boundary

This wave DOES NOT replace behavior execution or the legacy pre-executor toolchain path. It does not turn validation IDs into capability tokens. In particular:
- `validationCommandIds` are not ProjectDescriptor `CommandSpec.id`;
- effects/network/secrets enforcement is unchanged;
- no new command can execute because it has a hash ID;
- WAVE-05 `TOOLCHAIN_READY` remains non-executable.

The next executor slice must consume committed ProjectDescriptor command IDs and the WAVE-05 readiness chain before removing the legacy shell projection from execution authority.

## TDD

New suite: `tests/contracts/validation-command-authority-v2.test.mjs`.

It covers:
- deterministic/byte-sensitive IDs;
- projection mismatch/reordering;
- catalog IDs and exclusion of non-validation scripts;
- model-free legacy upgrade;
- known IDs overriding conflicting model-authored projection;
- dynamic Technical Plan schema ID enum;
- fail-closed missing/forged/unauthorized IDs.

Expected focused count is 210 (203 proven baseline + 7 new cases). This is an expectation only until target-host execution.

No L1/L2/semantic cache/ProjectMemory/worker/model-routing/main/consumer pin changes are part of this wave.
