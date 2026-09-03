# Test Plan — Standalone Agentic Harness

The distribution gate is layered:

1. contract suite — catalog discovery, dynamic DAG, dual-root, stale inherited project-root recovery, submodule-safe containerized migrations, skill references, portable config, project-agnostic boundary and bounded public scripts;
2. source syntax — Node syntax and TypeScript transpile diagnostics;
3. generated-config smoke — produce and parse the effective OpenCode config for a different project root;
4. static coupling audit — no product/domain identifiers in operational source and no `.agents/registry.json`;
5. Rust gate — `cargo check --manifest-path apps/runtime-worker/Cargo.toml` on a Rust-enabled host;
6. Compose gate — `docker compose --profile runtime config`, prove two distinct consumer roots derive distinct Compose project names/resources, and perform service startup on a Docker-enabled host;
7. integration gate — from a real external Git consumer, invoke `.harness/bin/harness.mjs` with a deliberately stale inherited `AGENT_HARNESS_PROJECT_ROOT=<consumer>/.harness` and prove bootstrap/doctor still select the consumer root, create no `.agent-harness`/`.runtime` under the submodule, then run `node .harness/bin/harness.mjs migrate` with no `.harness/node_modules` present and prove it executes the consumer-scoped `database-migrate` service successfully/idempotently before validating Context Engine health, Rust worker heartbeat and an OpenCode-connected runtime smoke. When Context Engine uses a non-default qualification port, prove the first live Runtime provenance registration targets that same effective endpoint (not `127.0.0.1:8789`) and that the Context Engine image validates the SHA of the current packaged provenance plugin source. Cleanup must target only the current consumer-scoped Compose project and must not delete legacy/unrelated volumes.

A distribution may report environment-unavailable gates separately, but must never claim they executed locally.
