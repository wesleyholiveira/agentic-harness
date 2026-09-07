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
- `R-9` — physical Rust worker process loss at the exact qualification repair checkpoint via host-PID-namespace SIGKILL, followed by lease expiry, exactly-one generation/fencing replacement and repair-resume evidence with no second full agent invocation.
- `R-10` — bounded dependency/restart faults plus an unavailable OpenCode continuation endpoint and recovery.
- `R-11` — cleanup, qualification-resource absence, port release and exact source equality.

## Fail-closed behavior

The first failed gate becomes the authoritative divergence. Remaining gates are NOT RUN. R-11 still executes. Source/runtime classification comes from the deterministic gate that observed the failure; the controller does not mutate the source candidate to continue a failed qualification.

## Reports

The controller writes:

- `qualification-report.json` — machine-readable `agentic-harness-standalone-qualification/v1` evidence;
- `qualification-report.md` — concise promotion report;
- `logs/*.log` — per-command captured evidence.

## Long-running R-7 behavior

R-7 does not use a fixed 45-minute whole-run timeout. The controller observes the Runtime's own PostgreSQL liveness authorities and emits a concise progress checkpoint to stderr every 60 seconds with the current task/stage, attempt, model, elapsed time and heartbeat/idle state.

A healthy task may continue while its persisted Runtime hard/soft/stall budgets remain valid. A HOLD is produced when the Runtime violates one of those budgets or when worker/lease, queue, scheduler or post-execution finalization liveness becomes invalid. The HOLD evidence includes the exact `runId`, task states, worker heartbeat, recent Runtime events, outbox state and pending execution results.

The final machine-readable qualification JSON remains on stdout.

## Source manifest after applying a differential

`MANIFEST.json` is derived from the **Git-tracked worktree**. When a differential adds new files, those paths must be staged before manifest generation or they are intentionally invisible to the manifest script.

Use this order:

```bash
git add -A
node scripts/internal/source-manifest.mjs --write
git add MANIFEST.json
node scripts/internal/source-manifest.mjs --check
git diff --cached --check
git commit -m "<candidate change>"
```

Running `--write` before staging newly added files produces a manifest that becomes stale as soon as those files are committed.

## Progress-aware R-8 Durable Continuation behavior

R-8 must not use a fixed wall-clock deadline shorter than the Runtime's own continuation assistant-completion budget. It reads the effective worker `AGENT_HARNESS_OPENCODE_CONTINUATION_COMPLETION_TIMEOUT_MS` (default 900000 ms), observes the durable delivery/session/assistant state, and emits a stderr checkpoint every 30 seconds. `acceptedAt` proves exact deterministic wake materialization; `observedAt` proves terminal assistant-child completion. Explicit `dead`/`ambiguous`/`manual_review` dispositions fail immediately; a healthy accepted/pending assistant remains eligible through the Runtime completion window. The PostgreSQL delivery projection must be JSON-framed because continuation prompt text is multiline. Exactly one user wake is required, but assistant cardinality is not one: mirror the Rust latest-parented-assistant rule and require the `continuation.delivered` event to persist the same terminal assistant message id.
