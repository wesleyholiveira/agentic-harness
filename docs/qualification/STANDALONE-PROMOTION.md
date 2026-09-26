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
- `R-3` — two external Git consumers, deterministic fixture, local submodule parity, dual-root/stale-root recovery and Compose identity isolation. Source-attested Docker runner materialization uses a bounded overall observation budget with a practical per-call Docker CLI allowance instead of a hidden 4-second ceiling; timeout/unavailable-daemon observations are classified as environment failures and include the exact probe operation/call budget in evidence.
- `R-4` — consumer-scoped runtime stack, readiness, migrations/idempotency, PostgreSQL worker heartbeat and resource isolation.
- `R-5` — effective OpenCode config, exact absolute wheel-bundled Headroom 0.36.5 standalone transport entry authority, telemetry-disabled Headroom proxy baseline, and mandatory Context Engine/Serena/Headroom/CBM MCP connectivity.
- `R-6` — fresh OpenCode host launched directly by the qualification controller (never through `headroom wrap opencode`), `headroom_retrieve` tool-id proof that the bundled transport plugin actually initialized, provenance SHA authority and noReply history probe with zero Runtime run. Qualification ports come from the stable 20000–29999 bank rather than the OS ephemeral allocator; R-6 rechecks the OpenCode port immediately before spawn and fails fast with child exit/stdout/stderr evidence if `opencode serve` exits before health.
- `R-7` — the one intentional model-facing gate: normal consumer workload must enter Runtime via `agent_start`, server-enforced provenance and `runId` before implementation. The 90-second pre-ingress mark is a diagnostic soft boundary, not a blind failure deadline. OpenCode assistant steps ending in `finish=tool-calls` or `finish=unknown`, or carrying loop-owned tool calls such as `runtime-continuation`, are non-terminal and must be allowed to continue to the subsequent `agent_start`; only a genuinely completed terminal assistant without Runtime ingress is fail-closed. Qualification records session status, assistant/provider/model/tool-state errors, Headroom request progress and host diagnostics, while a bounded 10-minute safety ceiling protects against indefinite host stalls. The accepted current-turn provenance must still be durably recorded in PostgreSQL with `historySource=chat-message-hook`, and Headroom `/stats.requests.total` must increase across the real workload.
- `R-8` — durable continuation identity/materialization/acceptance.
- `R-9` — first prove the qualification fault controls are present in the recreated Runtime worker environment, then inject physical Rust worker process loss at the exact qualification repair checkpoint via host-PID-namespace SIGKILL, followed by lease expiry and exactly-one generation/fencing replacement. Resume authority is proven first from the durable `runtime-repair-resume-receipt/v1` file written by the replacement executor (including `sameTaskAttempt=true` and `skippedFullAgentInvocation=true`), then the Runtime is allowed to finish under its normal progress-aware liveness budget, after which the semantic finalizer must have projected exactly one matching `repair.resume_checkpoint_loaded` event; disarmed worker environment is re-proven before R-10.
- `R-10` — bounded dependency/restart faults plus an unavailable OpenCode continuation endpoint and recovery. A dedicated code-and-test fixture must first cross an integrated Technical Refinement boundary while the host OpenCode endpoint is healthy; a semantic failure before that boundary is reported separately as `r10_pre_outage_semantic_run_failed` and never mislabeled as an outage failure. Only then is the host endpoint stopped. The outage half is proven pre-dispatch: zero prompt-dispatch attempts, no `dispatch_started_at`, a recognized transport error, published continuation outbox identity and matching deferred Runtime inbox; after host recovery the normal progress-aware continuation observer must reach accepted/observed terminal delivery.
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
