# Test Plan — Standalone Agentic Harness

The distribution gate is layered:

1. contract suite — catalog discovery, dynamic DAG, dual-root, stale inherited project-root recovery, submodule-safe containerized migrations, skill references, portable config, project-agnostic boundary and bounded public scripts;
2. source syntax — Node syntax and TypeScript transpile diagnostics;
3. generated-config smoke — produce and parse the effective OpenCode config for a different project root;
4. static coupling audit — no product/domain identifiers in operational source and no `.agents/registry.json`;
5. Rust gate — `cargo check --manifest-path apps/runtime-worker/Cargo.toml` on a Rust-enabled host;
6. Compose gate — `docker compose --profile runtime config`, prove two distinct consumer roots derive distinct Compose project names/resources, prove Context Engine and the Rust worker mount the same consumer-scoped `agent-harness-agent-workspaces` volume at `/workspace/agent-workspaces` with identical `AGENT_HARNESS_AGENT_WORKSPACE_ROOT`, and perform service startup on a Docker-enabled host;
7. integration gate — from a real external Git consumer, invoke `.harness/bin/harness.mjs` with a deliberately stale inherited `AGENT_HARNESS_PROJECT_ROOT=<consumer>/.harness` and prove bootstrap/doctor still select the consumer root, create no `.agent-harness`/`.runtime` under the submodule, then run `node .harness/bin/harness.mjs migrate` with no `.harness/node_modules` present and prove it executes the consumer-scoped `database-migrate` service successfully/idempotently before validating Context Engine health, Rust worker heartbeat and an OpenCode-connected runtime smoke. When Context Engine uses a non-default qualification port, prove before the first live `agent_start` that `/runtime-invocation-provenance/identity` reports `ready=true` and identical expected/configured/bundled SHA values matching the OpenCode live plugin identity; then prove the live registration targets that same effective endpoint (not `127.0.0.1:8789`). Cleanup must target only the current consumer-scoped Compose project and must not delete legacy/unrelated volumes.

A distribution may report environment-unavailable gates separately, but must never claim they executed locally.

8. Main Orchestrator runtime-ingress gate — generate the effective OpenCode config and prove the persistent Main Orchestrator denies `edit`, `bash`, built-in `task` and `serena_*`; invoke the host provenance plugin against representative direct-execution tools and prove typed fail-closed rejection, while proving `AGENT_HARNESS_OPENCODE_RUNTIME_CHILD=1` specialists are not fenced. A live consumer change request must create `agent_start` provenance and a Runtime `runId` before any implementation occurs.


9. deterministic qualification-controller gate — `harness:qualify -- --self-test` must pass without invoking Docker/OpenCode/model execution, preserve the ten-command public surface, prove the controller is a host process rather than an operational agent, and emit the versioned qualification report contract. Full target-host promotion uses that controller for Q-ENTRY/PRE-R0/R-0–R-11; only R-7 sends a normal consumer request to the qualified Main Orchestrator.

10. R-7 progress-aware terminal watchdog — prove a healthy non-governance task may run beyond 45 minutes while still below its persisted hard timeout; prove governance soft/stall overruns, stale worker/lease authority, unclaimed queue state and scheduler inactivity fail closed with structured evidence; prove long-running observation emits stderr checkpoints without contaminating the final stdout JSON contract.

### Dual-root Agent Input schema proof

Create a temporary consumer with no `.agents` tree and use the real harness as a separate `harnessRoot`. Prepare a Technical Refinement Agent Input Manifest and require both `schema:handoff-result` and `schema:implementation-plan` entries to resolve to the harness tree. The Runtime child executor contract must likewise resolve `agent-input-manifest.schema.json` and implementation-plan schemas from `AGENT_HARNESS_ROOT`, never the consumer/workspace root.


### Host / Runtime-child OpenCode config isolation

- Prove host generation still writes `<consumer>/.runtime/opencode.effective.json`.
- Seed that host file, generate a Runtime-child config through `AGENT_HARNESS_OPENCODE_CONFIG_OUTPUT`, and prove the host file is byte/JSON unchanged.
- Prove the worker entrypoint pins the child config outside `/workspace/repository`.
- Live R-7 must reach Runtime child OpenCode without host-native `{file:...}` references being resolved inside the Linux container.

### Worktree integration materialization proof

Create a clean temporary Git consumer, fork a real detached implementation worktree, create brand-new `src/**` and `test/**` files, and require `inspectWorkspaceChanges()` to report them. Integrate the reconciled change-set and prove the exact bytes exist in the consumer root before integration succeeds. The Runtime must record conflicts/fail closed if any changed path is absent or fingerprint-divergent after integration; downstream QA must never receive a task marked `integrated` without the corresponding materialized source/test files.


## Shared event-driven workspace proof

On a Docker-enabled host, create a Runtime task whose worker workspace is outside `/workspace/repository`. Before live R-7 execution, R-4 must inspect `context-engine` and `agent-runtime-worker` and prove both mount the same Docker volume source at `/workspace/agent-workspaces`. A worker-created workspace file must be readable by Context Engine finalization before cleanup; copy-workspace integration must then materialize an implementation file into the consumer root and make it visible to the next QA workspace.

### Phantom reuse normalization contracts

The contract suite must prove all of the following:

- a zero-file bootstrap governance review may drop an owned path that is absent from both workspace and baseline when the path appears only in `reusedPaths`;
- the same phantom path remains invalid when any handoff evidence references it;
- a path that existed in baseline but is missing from the workspace remains invalid;
- implementation/non-review tasks never receive phantom-reuse normalization;
- the bootstrap governance executor prompt explicitly forbids invented `changedPaths`/`reusedPaths` artifacts.

## R-8 continuation liveness contracts

The qualification contract suite must prove that a continuation accepted at ten minutes is still eligible when the Rust worker completion budget is fifteen minutes; that explicit ambiguous/manual-review delivery fails immediately; that completion beyond the Runtime deadline is rejected; and that success requires ordered `acceptedAt <= observedAt`. The live gate must also prove exactly one deterministic wake message, one wake-materialized event, one delivered event, and a completed assistant child parented by the deterministic wake message.
