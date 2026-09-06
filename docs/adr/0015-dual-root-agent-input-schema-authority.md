# ADR 0015 — Dual-root Agent Input schema authority

## Status

Accepted.

## Context

The standalone harness has two explicit filesystem authorities:

- `AGENT_HARNESS_PROJECT_ROOT` / `repositoryRoot`: the consuming project. It owns product source, PRDs/ADRs, workspaces and `.runtime/**` evidence.
- `AGENT_HARNESS_ROOT` / `harnessRoot`: the harness/submodule. It owns agent definitions, Runtime source, schemas, policies, skills and executor implementation.

A live standalone qualification proved a Runtime stall before physical dispatch. `product-discovery` repeatedly emitted `task.preparation.started` followed by `runtime.reconcile_failed`, while remaining `routed` at attempt 0 with no execution lease, model or executor heartbeat.

The preparation path still constructed `handoff-result.schema.json` and `implementation-plan.schema.json` as `<repositoryRoot>/.agents/schemas/...`. A standalone consumer intentionally has no copied `.agents` tree: those schemas exist under `<harnessRoot>/.agents/schemas/...`. `manifestEntryFromFile()` performs an exact `readFile`, so the stale monorepo assumption fails before `dispatchPreparedTask()`.

The Runtime child executor contained the same assumption for `agent-input-manifest.schema.json` and Technical Refinement implementation-plan validation, which would fail after dispatch even if preparation were repaired.

## Decision

Harness-owned schema bytes are always resolved from `harnessRoot`.

Consumer-owned artifacts remain resolved from `repositoryRoot` / execution workspace.

Specifically:

1. `prepareAgentInputManifest()` receives `harnessRoot` and attaches handoff/implementation schemas from `<harnessRoot>/.agents/schemas`.
2. `prepareTaskExecution()` projects `options.harnessRoot` into Agent Input preparation.
3. `opencode-task-executor.mjs` resolves `AGENT_HARNESS_ROOT` once and uses it for Agent Input Manifest and implementation-plan schemas.
4. Runtime-generated Task Brief/Context Packet/manifest/workspace paths remain under the consumer root.
5. `runtime.reconcile_failed` persists both structured `code` and `message`; qualification observations retain that message so future preparation failures are directly attributable.

No harness `.agents` tree is copied into the consumer as a compatibility workaround.

## Consequences

- Standalone consumers remain clean submodule consumers rather than shadow copies of harness metadata.
- Schema identity is single-source and byte-exact.
- Runtime preparation can progress from `routed` to physical dispatch without depending on a monorepo layout.
- Technical Refinement repair/synthesis uses the same harness-owned implementation-plan schema as the Runtime compiler.
- Future reconcile failures expose the actual exception instead of only a generic scheduler stall.

## Verification

A contract creates an external consumer with no `.agents` directory, prepares a Technical Refinement Agent Input Manifest with a separate `harnessRoot`, and proves that both schema entries resolve to the harness tree. A source contract also rejects executor reads of harness schemas from the consumer/workspace root.
