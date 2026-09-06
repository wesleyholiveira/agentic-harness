# Agentic Harness v1.0.0 standalone promotion qualification

The promotion qualification is executed by the deterministic host controller, not by the Main Orchestrator and not by Runtime V2 itself.

## Entry point

From a committed, Git-clean source candidate:

```bash
npm run harness:qualify
```

Optional explicit evidence directory:

```bash
npm run harness:qualify -- --output <external-directory>
```

Controller wiring self-test only:

```bash
npm run harness:qualify -- --self-test
```

The default report location is an OS temporary directory. The controller prints the exact JSON and Markdown report paths at completion.

## Authority boundary

The controller executes host-level qualification operations directly with Git, Docker/Compose, Node/npm, Cargo, HTTP and read-only PostgreSQL evidence. It is not one of the operational agents and does not inherit the Main Orchestrator permission policy.

The persistent Main Orchestrator remains control-plane only:

```text
consumer request
  -> qualified OpenCode session
  -> Main Orchestrator
  -> Context Engine agent_start
  -> Runtime V2 runId
  -> specialist execution
```

The qualification controller never calls `agent_start` directly.

## Gate map

- `Q-ENTRY` — host execution capability and checkout visibility.
- `PRE-R0` — clean source, doctor/npm/toolchain, isolated ports, DNS/HTTPS, Compose service discovery and fresh TEI `/embed`.
- `R-0` — source/manifest freeze, structural invariants, generic namespace and Main Orchestrator Runtime-ingress fence.
- `R-1` — standalone contracts, syntax and inventory.
- `R-2` — TypeScript, Rust fmt/check/test/clippy, Compose config and runtime image build.
- `R-3` — two external Git consumers, deterministic fixture, local submodule parity, dual-root/stale-root recovery and Compose identity isolation.
- `R-4` — consumer-scoped runtime stack, readiness, migrations/idempotency, PostgreSQL worker heartbeat and resource isolation.
- `R-5` — effective OpenCode config and mandatory Context Engine/Serena/Headroom/CBM MCP connectivity.
- `R-6` — fresh OpenCode host, provenance SHA authority and noReply history probe with zero Runtime run.
- `R-7` — the one intentional model-facing gate: normal consumer workload must enter Runtime via `agent_start`, provenance and `runId` before implementation.
- `R-8` — durable continuation identity/materialization/acceptance.
- `R-9` — physical Rust worker loss after a reusable checkpoint and repair-resume evidence without a second full agent invocation.
- `R-10` — bounded dependency/restart faults plus an unavailable OpenCode continuation endpoint and recovery.
- `R-11` — cleanup, qualification-resource absence, port release and exact source equality.

## Fail-closed behavior

The first failed gate becomes the authoritative divergence. Remaining gates are NOT RUN. R-11 still executes. Source/runtime classification comes from the deterministic gate that observed the failure; the controller does not mutate the source candidate to continue a failed qualification.

## Reports

The controller writes:

- `qualification-report.json` — machine-readable `agentic-harness-standalone-qualification/v1` evidence;
- `qualification-report.md` — concise promotion report;
- `logs/*.log` — per-command captured evidence.
