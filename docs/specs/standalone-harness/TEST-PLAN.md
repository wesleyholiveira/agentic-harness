# Test Plan — Standalone Agentic Harness

The distribution gate is layered:

1. contract suite — catalog discovery, dynamic DAG, dual-root, stale inherited project-root recovery, submodule-safe containerized migrations, skill references, portable config, project-agnostic boundary and bounded public scripts;
2. source syntax — Node syntax and TypeScript transpile diagnostics;
3. generated-config smoke — produce and parse the effective OpenCode config for a different project root;
4. static coupling audit — no product/domain identifiers in operational source and no `.agents/registry.json`;
5. Rust gate — `cargo check --manifest-path apps/runtime-worker/Cargo.toml` on a Rust-enabled host;
6. Compose gate — `docker compose --profile runtime config`, prove two distinct consumer roots derive distinct Compose project names/resources, and perform service startup on a Docker-enabled host;
7. integration gate — from a real external Git consumer, invoke `.harness/bin/harness.mjs` with a deliberately stale inherited `AGENT_HARNESS_PROJECT_ROOT=<consumer>/.harness` and prove bootstrap/doctor still select the consumer root, create no `.agent-harness`/`.runtime` under the submodule, then run `node .harness/bin/harness.mjs migrate` with no `.harness/node_modules` present and prove it executes the consumer-scoped `database-migrate` service successfully/idempotently before validating Context Engine health, Rust worker heartbeat and an OpenCode-connected runtime smoke. When Context Engine uses a non-default qualification port, prove before the first live `agent_start` that `/runtime-invocation-provenance/identity` reports `ready=true` and identical expected/configured/bundled SHA values matching the OpenCode live plugin identity; then prove the live registration targets that same effective endpoint (not `127.0.0.1:8789`). Cleanup must target only the current consumer-scoped Compose project and must not delete legacy/unrelated volumes.

A distribution may report environment-unavailable gates separately, but must never claim they executed locally.

8. Main Orchestrator runtime-ingress gate — generate the effective OpenCode config and prove the persistent Main Orchestrator denies `edit`, `bash`, built-in `task` and `serena_*`; invoke the host provenance plugin against representative direct-execution tools and prove typed fail-closed rejection, while proving `AGENT_HARNESS_OPENCODE_RUNTIME_CHILD=1` specialists are not fenced. A live consumer change request must create `agent_start` provenance and a Runtime `runId` before any implementation occurs.


9. deterministic qualification-controller gate — `harness:qualify -- --self-test` must pass without invoking Docker/OpenCode/model execution, preserve the ten-command public surface, prove the controller is a host process rather than an operational agent, and emit the versioned qualification report contract. Full target-host promotion uses that controller for Q-ENTRY/PRE-R0/R-0–R-11; only R-7 sends a normal consumer request to the qualified Main Orchestrator.

10. R-7 progress-aware terminal watchdog — prove a healthy non-governance task may run beyond 45 minutes while still below its persisted hard timeout; prove governance soft/stall overruns, stale worker/lease authority, unclaimed queue state and scheduler inactivity fail closed with structured evidence; prove long-running observation emits stderr checkpoints without contaminating the final stdout JSON contract.
