# Agentic Harness v1 — standalone source distribution report

## Status

This archive is a **standalone source candidate** for the official Agentic Harness repository. It is derived from the Runtime V2 R17.4.5 source that reached `R17.4.5 PROMOTION PASS`, but the genericized standalone tree is a new distribution boundary and does not reuse the R17.4.5 promotion verdict as if no source changed.

Promoted lineage fingerprint:

`sha256:2030a87202a3dc5b877c7860f5374edeb97ca52f83ea9d324dc82b13ce2b5abf`

The immutable qualification evidence retained in this repository lives under `qualification/baseline/r17.4.5/`.

## Standalone boundary

The harness owns:

- reusable specialist-agent definitions and capability discovery;
- SDD workflow, generic PRD/design/test/implementation templates and schemas;
- dynamic DAG planning/compilation and Runtime V2 orchestration;
- PostgreSQL durable Runtime/ProjectMemory/continuation authority;
- RabbitMQ at-least-once transport and Rust physical worker;
- Context Engine, Redis exact/semantic cache integration and optional TEI embeddings;
- OpenCode configuration, project plugins, durable-continuation provenance and live progress;
- Headroom, Serena, Context7, codebase-memory and optional Caveman wiring;
- RTK project configuration and skill guidance;
- pinned Superpowers metadata/vendor boundary;
- bootstrap/doctor/up/down/migrate/test/qualify/OpenCode entrypoints.

The consuming project owns its product code and project-specific PRDs, ADRs, designs, test plans, runbooks, Task Briefs, Context Packets and policies.

## Architecture changes made for standalone use

1. `AGENT_HARNESS_ROOT` and `AGENT_HARNESS_PROJECT_ROOT` are distinct authorities. Harness source comes from the submodule; project source/workspaces/evidence remain in the consumer repository.
2. The former monolithic `.agents/registry.json` is removed. Capabilities are discovered from `.agents/agents/<agent>/agent.json`; dependency order is compiled at runtime from Technical Refinement `implementationPlan`.
3. Product-specific specialists and upstream application/runtime surfaces are excluded from the operational harness.
4. Historical R12–R17 qualification scripts are not public package scripts. The public operational surface is intentionally bounded to ten stable `harness:*` commands.
5. Generic SDD authority for the harness itself is in `docs/specs/standalone-harness/`; historical qualification material is provenance only.
6. Docker Compose runtime resources are consumer-scoped. The launcher derives a deterministic project name from the canonical `AGENT_HARNESS_PROJECT_ROOT`, preventing unrelated consumers from sharing containers, networks or named durable volumes.
7. Public launcher root resolution is consumer-safe: a stale inherited `AGENT_HARNESS_PROJECT_ROOT` that resolves to harness source, including another outer checkout, cannot override an external Git consumer cwd containing the active harness submodule. The correction is surfaced by bootstrap/doctor diagnostics.
8. Public migration is submodule-safe: `harness:migrate` runs the existing migrator in the consumer-scoped `database-migrate` Compose service instead of importing host `pg` from a clean `.harness` checkout.
9. Runtime invocation provenance shares the effective Context Engine endpoint authority with OpenCode MCP traffic; the launcher projects one plugin-source SHA authority to OpenCode and Context Engine, and the container bundle must match it before readiness.

## Distribution inventory

- Generic specialist agents: 20
- Harness-owned skill directories: 22
- Artifact schemas: 11
- PostgreSQL harness migrations: 11
- Public `package.json` scripts: 10
- Standalone contract files: 12 (81 current Node subtests)
- Superpowers expected by lock: 14
- Superpowers skill trees physically vendorized in this archive: 14

## Superpowers vendor status

The complete Superpowers `v5.1.0` set pinned by `vendor/superpowers/lock.json` is physically present: **14/14** directories with `SKILL.md`, including the four that were absent from the earliest extraction checkpoint (`dispatching-parallel-agents`, `requesting-code-review`, `using-git-worktrees`, and `using-superpowers`). `scripts/vendor-superpowers.mjs` remains a pinned refresh/verification utility; consumers do not need it to resolve the committed skills.

## OpenCode configuration portability hardening

The reusable OpenCode template lives at `config/opencode.template.jsonc`, intentionally outside every filename/location that OpenCode auto-discovers as a project config. This is required on Windows: OpenCode performs `{env:...}` substitution while loading project configs, so a value such as `D:\\agentic-harness` can become an invalid JSON escape before parsing. The harness generator expands paths itself, normalizes Windows separators to `/`, serializes the effective config with `JSON.stringify`, and writes only `<AGENT_HARNESS_PROJECT_ROOT>/.runtime/opencode.effective.json`. Generated runtime state never belongs to the reusable harness root.

`opencode.json` and `opencode.jsonc` at the harness root are forbidden legacy artifacts. The launcher fails closed if either is present. Context7 is disabled in the generated config when `CONTEXT7_API_KEY` is absent; Context Engine defaults to `http://127.0.0.1:8789/mcp` when no explicit URL is configured. Host executable launchers use `shell: false` so Windows paths containing spaces are not truncated by `cmd.exe`.

## MCP launch portability hardening

The generated OpenCode config no longer relies on a bare `codebase-memory-mcp` command when the executable can be resolved. `scripts/internal/tool-resolution.mjs` resolves `CODEBASE_MEMORY_MCP_COMMAND`, the standard per-user cache location and finally the host PATH without using a shell; the effective config receives the absolute normalized executable path. This mirrors the reliable Windows installation shape while remaining user-agnostic.

Headroom uses two distinct pinned surfaces: `headroom-ai[proxy]==0.36.5` for the wrapper proxy and the canonical `headroom-ai[mcp]==0.36.5` package for `headroom mcp serve`. The generated MCP command receives the same explicit `--proxy-url http://127.0.0.1:${HEADROOM_PROXY_PORT:-8793}` owned by the wrapper, so MCP retrieval/stats cannot silently point at Headroom's unrelated default proxy port.

A plain `opencode mcp list` outside `harness:opencode` may exercise the user's global OpenCode config instead of the consumer-owned `.runtime/opencode.effective.json`; standalone qualification must therefore prove MCP connectivity from the harness-launched OpenCode process/config, not infer it from the global list.

## Target-host R-5 remediation

The first independent Windows target-host qualification of this standalone tree passed PRE-R0 and R-0 through R-4, then correctly held at R-5 because `scripts/generate-opencode-config.mjs` wrote generated OpenCode state under `AGENT_HARNESS_ROOT/.runtime`. That violated ADR 0001: `.runtime` evidence belongs to the consuming project.

This source revision fixes the ownership boundary by writing the effective config to `<AGENT_HARNESS_PROJECT_ROOT>/.runtime/opencode.effective.json`, strengthens the contract test to prove no harness-root output is created, aligns persistent provenance identity with harness-plugin/project-evidence dual roots, and makes `harness:clean` remove the generated effective config from the project runtime directory. Because this is a source change, R-0 onward must be rerun before promotion; R-6 through R-10 are not claimed by this report.

## Target-host R-4 consumer isolation remediation

A subsequent target-host qualification reached R-4 after PRE-R0 through R-3 passed. The first R-4 attempt experienced transient Docker DNS failures (`postgres` service discovery and external Hugging Face resolution); a fresh bounded Docker-network preflight later proved host DNS, container DNS/HTTPS, Compose service discovery and fresh TEI model initialization all healthy. No DNS workaround is encoded in source.

That preflight also exposed three residual volumes with the legacy fixed `agentic-harness` Compose namespace. A fixed top-level project name is incompatible with independent submodule consumers because Docker would scope containers, the default network and named PostgreSQL/RabbitMQ/Redis volumes to the same project. This revision removes the fixed Compose `name:` and makes `bin/harness.mjs` derive `agentic-harness-<sha256-prefix>` from the canonical consuming-project root, pass it explicitly with `docker compose -p`, and override inherited generic `COMPOSE_PROJECT_NAME`. `AGENT_HARNESS_COMPOSE_PROJECT_NAME` is the explicit operator override. Legacy volumes are preserved rather than deleted automatically.

Because this is another tracked source change, the standalone qualification must restart before R-0; no R-4+ PASS is claimed by this report.

## Target-host R-3 inherited-root remediation

A later fresh target-host qualification passed PRE-R0 through R-2 and then correctly held at R-3. The external consumer and `.harness` submodule were created correctly, but the Outer Qualification Controller inherited `AGENT_HARNESS_PROJECT_ROOT` from its parent harness session. `bin/harness.mjs` previously gave that stale environment value unconditional precedence over the consumer invocation cwd, so bootstrap wrote `.agent-harness/` into reusable harness source and every downstream project/runtime identity would have collapsed to the submodule.

This revision centralizes public-launcher project-root resolution. An explicit `AGENT_HARNESS_PROJECT_ROOT` outside the harness remains authoritative. When the inherited value resolves to the harness (or a descendant) and the current cwd is an external Git consumer that contains that harness, the launcher instead selects the consumer cwd and records `projectRootResolution.source=consumer-cwd-over-stale-harness-env`. A focused integration contract copies the launcher into a temporary `.harness`, deliberately injects the stale self-root environment, and proves `.agent-harness/config.json` is created only in the consumer.

Because this is tracked source remediation after an R-3 HOLD, the full standalone qualification must restart at PRE-R0/R-0; no R-3+ PASS is claimed by this report.

## Target-host R-4B submodule migration remediation

A subsequent fresh qualification passed PRE-R0, R-0 through R-3B, R-4 and R-4A, then correctly held at R-4B. From the external consumer, `node .harness/bin/harness.mjs migrate` spawned `<consumer>/.harness/scripts/harness-migrate.mjs` directly on the host. That clean Git submodule intentionally had no `node_modules`, so the migrator's `import pg from "pg"` failed with `ERR_MODULE_NOT_FOUND`. Installing/copying dependencies into every submodule would violate the reusable-source boundary.

This revision routes the public migration command through the consumer-scoped Compose `database-migrate` service. The image is built from the harness lockfile, runs `npm ci`, contains the same migration implementation and reaches PostgreSQL through the internal `postgres` service name. A focused contract prevents the launcher from regressing to host-spawning the migrator. Migration SQL remains single-sourced; only the execution boundary changes.

Because this is tracked source remediation after an R-4B HOLD, the full standalone qualification must restart at PRE-R0/R-0; no R-4B+ PASS is claimed by this report.

## Validation performed in the build environment

The distribution is checked with `node scripts/harness-test.mjs`, syntax/JSON/TypeScript-transpile checks, OpenCode effective-config generation and YAML parsing of `compose.yaml`.

The build sandbox did not provide Docker, Cargo, OpenCode, RTK or the codebase-memory executable, so live Compose build, Rust compilation, OpenCode plugin execution and external-tool probes cannot be claimed from this environment. `harness:doctor` reports these as host prerequisites rather than source-contract failures.

A target development host should run:

```bash
node .harness/bin/harness.mjs bootstrap
node .harness/bin/harness.mjs doctor
node .harness/bin/harness.mjs test
node .harness/bin/harness.mjs qualify
```

before the first stable repository tag is promoted.

## Package-lock policy

`package-lock.json` is committed source authority for the standalone candidate and must remain byte-identical throughout a qualification run. Direct npm dependencies are exact-pinned in `package.json`; dependency changes require an intentionally regenerated lockfile followed by a completely fresh qualification.

## Concrete source-candidate results

| Check | Result |
|---|---|
| Standalone contracts | PASS — 81/81 current subtests |
| Node syntax | PASS — 134 files |
| JSON parse | PASS — 70 files |
| TypeScript transpile/syntax | PASS — 108 files, 0 parse errors |
| `tsc --noEmit` | BLOCKED_ENVIRONMENT — `node_modules` / `@types/node` unavailable |
| Compose YAML parse | PASS — 7 services |
| OpenCode effective config generation | PASS — 20 agents / 2 local skill paths |
| Project-specific operational-source scan | PASS — 0 matches |
| User-specific absolute-path scan | PASS — 0 matches |
| Credential-token scan | PASS — 0 matches |
| `harness:qualify` | contracts PASS, then BLOCKED_ENVIRONMENT because Cargo is unavailable |

Machine-readable evidence: `validation/source-candidate-20260902.json`. That file is retained as historical pre-target-host extraction evidence and therefore still records the earlier 10/14 Superpowers snapshot and 14-subtest run; it is not rewritten to pretend those observations occurred after the R-5 source fix.

## Operational namespace genericization closure

A fresh standalone R-0 qualification detected pre-standalone product-lineage identifiers that survived genericization in operational MCP tool names, Prometheus metric families and a Runtime validation marker. The standalone namespace is now `agent_harness_*` for all three surfaces. No compatibility aliases are retained because this is the first standalone stable-tag candidate; historical identifiers remain only in immutable `qualification/baseline/**` provenance. The project-agnostic source contract now detects the legacy product namespace case-insensitively across operational source without embedding it as a supported public identifier.

This is a tracked source remediation after an R-0 HOLD. Full standalone qualification must restart at PRE-R0/R-0; no downstream PASS is inherited.

## Target-host R-7 Main Orchestrator Runtime-ingress remediation

A fresh standalone qualification passed PRE-R0 through R-6 and reached the first real consumer workload at R-7. The qualified persistent Main Orchestrator performed direct file/tool work and returned an assistant handoff without invoking Context Engine `agent_start`; therefore no Runtime invocation provenance or `runId` existed. This is a source/runtime boundary defect, not a qualification-procedure failure.

This revision makes the persistent Main Orchestrator control-plane only. Its OpenCode permissions deny edit/write/apply-patch, shell, built-in task delegation and Serena tool access. The provenance plugin independently rejects those same direct-execution paths on the persistent host and exempts Runtime child OpenCode processes. Prompt/skill contracts now require delivery workloads to enter through `agent_start` and fail closed when Runtime ingress is unavailable.

Because this is tracked source remediation after an R-7 HOLD, the complete standalone qualification must restart from PRE-R0/R-0. No R-7+ PASS is inherited from the failed run.

## Deterministic standalone qualification controller

The natural-language outer-controller runbook has been replaced as the execution authority by the versioned host CLI behind `npm run harness:qualify`. The controller runs outside the 20-agent catalog and therefore does not require restoring shell/edit permissions to the persistent Main Orchestrator. PRE-R0–R-6 and R-8–R-11 are deterministic host/code gates; R-7 is the deliberate live OpenCode/Main-Orchestrator boundary and must produce `agent_start` provenance plus a Runtime `runId` before implementation. The controller writes a versioned JSON report, Markdown summary and per-command logs outside tracked source by default, stops at first divergence, and always runs isolated cleanup/source-equality checks.

## Windows qualification-controller command resolution

The first live run of the deterministic controller on Windows exposed a portability defect before `npm ci` executed: `spawnSync("npm", ..., { shell: false })` returned `ENOENT` because the Node installation exposes npm through a Windows `.cmd` shim. The controller resolves commands through the effective `PATH` and `PATHEXT`. Native executables continue to launch directly with `shell: false`; `.cmd`/`.bat` shims are invoked through the resolved `ComSpec` explicitly, also with `shell: false`, and command evidence records the requested command, resolved path, actual spawn command, wrapper and spawn arguments.

A second live Q-ENTRY run proved that shim discovery alone was insufficient: passing a command string such as `call "C:\\Program Files\\nodejs\\npm.CMD" "--version"` through Node's default Windows argument escaping caused `cmd.exe` to receive backslash-escaped quote characters as part of the batch filename. The controller now uses the documented `cmd.exe /S /C` outer-quote shape for batch paths with spaces, invokes that wrapper with `windowsVerbatimArguments=true`, and does not use `call`. The resulting command line is semantically `cmd.exe /d /v:off /s /c ""C:\\Program Files\\nodejs\\npm.CMD" "--version""`. Normal native executables remain non-verbatim and `shell:false`.

`Q-ENTRY` exercises `npm --version` through the same `ProcessRunner`, so both Windows command discovery and batch-wrapper quoting are validated before PRE-R0. Focused contracts simulate `npm.CMD`, including a shim path containing spaces, and assert that no backslash-escaped executable quotes are emitted. This is a tracked qualification-controller source remediation; the full live qualification must restart from Q-ENTRY/PRE-R0 after the patch is committed.

## R-0 qualification scanner self-match remediation

The deterministic qualification runner previously embedded the complete legacy product-namespace regular expression as a literal in its own operational source. R-0 correctly scanned operational source and therefore matched the scanner itself. The scanner now composes the forbidden legacy namespace variants from fragments at runtime, preserving the exact detection semantics without materializing the forbidden identifier in operational source. A contract executes the same Git scan and requires zero matches outside immutable historical baseline provenance.

## R-4 HTTP readiness and transport-evidence remediation

The first live deterministic-controller run to reach R-4 stopped on a bare `TypeError: fetch failed`. Container state had already been proven, but the controller performed one-shot RabbitMQ Management and embeddings HTTP requests immediately after containers became `Running`, and the HTTP helper discarded the transport cause.

The qualification HTTP layer now preserves URL, method, timeout and nested transport-cause fields. R-4 uses bounded readiness polling for Context Engine, RabbitMQ Management and embeddings. Connection refusal, timeout, HTTP 5xx, 408 and 429 are retryable until the bounded deadline; deterministic non-retryable HTTP 4xx responses fail immediately with SOURCE-oriented evidence.

This removes the race between Docker container state and application HTTP readiness without weakening fail-closed qualification.

## R-7 Runtime run-discovery and continuation-binding remediation

A fresh deterministic qualification passed Q-ENTRY through R-6 and timed out in R-7 while waiting for the Runtime `runId`. The controller was incorrectly using `agent_continuations` as the sole run-discovery authority even though `agent_start.continuation` is optional and a valid `agent_runs` row can exist without that binding.

R-7 now discovers a run from PostgreSQL `agent_runs` using the exact fresh synthetic workload request and independently requires an `agent_continuations` row bound to the exact qualified OpenCode session. Timeout diagnostics distinguish no Runtime ingress, provenance-without-run, and run-without-continuation.

The persistent Main Orchestrator contract now explicitly calls the local `runtime-continuation` tool before `agent_start` and passes the returned continuation object in the same call. Normal persistent delivery therefore expects `next=session-resume-event`, preserving the Durable Continuation semantics qualified in R-8.

## R-7 Security Review execution-plan schema parity remediation

A fresh standalone qualification reached R-7 with the correct `runtime-continuation -> context-engine_agent_start` tool sequence, but Context Engine rejected the planner-produced execution plan because `workflow.requiresSecurity` was emitted by the planner while absent from the v2 execution-plan schema. This revision makes the security review projection schema-required, keeps provisional/refined topology projections coherent, and improves R-7 classification for Runtime validation rejection before run materialization.

## R-7 provenance authority remediation

R-7 previously searched Context Engine logs for `mcp.invocation_provenance_registered`, but structured logging is `off` by default. The gate therefore produced a false Runtime HOLD after a run and Durable Continuation had already materialized. `agent_start` now fails closed for HTTP Main Orchestrator calls unless the Context Engine request context contains consumed OpenCode sidechannel provenance with session and user-message identity. R-7 uses that server-enforced boundary as its provenance authority; logs are diagnostic only.

## R-7 progress-aware terminal-watch remediation

A live target-host qualification passed Q-ENTRY through R-6 and reached R-7 with Runtime ingress already proven. The controller then held after a fixed 45-minute wait for terminal `agent_runs.status`.

That was a qualification-procedure defect: Runtime permits one-hour task hard deadlines and governance-specific soft/stall budgets, so a multi-stage healthy workflow can exceed 45 minutes. The old timeout also discarded the exact run/task liveness evidence needed for diagnosis.

R-7 now uses a progress-aware watchdog backed by one structured PostgreSQL observation per poll. It captures run/task state, latest executor heartbeat, worker heartbeat, execution leases, recent Runtime events, outbox rows and pending execution results, derives task liveness from Runtime's own policy, emits 60-second stderr progress checkpoints, and fails only when an actual Runtime liveness invariant is exceeded. A six-hour emergency ceiling remains only as a qualification-procedure safety bound.

## Differential manifest staging rule

The source manifest reads the Git-tracked worktree. For differentials that add files, new paths must be staged with `git add -A` before `source-manifest.mjs --write`; otherwise the new files are absent from the generated file count/tree hash and R-0 will correctly reject the subsequent committed candidate.

## R-7 standalone dual-root Agent Input remediation

A live progress-aware R-7 run proved a real Runtime preparation loop: `product-discovery` remained `routed` at attempt 0 while each repair sweep emitted `policy_allowed -> task.preparation.started -> runtime.reconcile_failed`. No execution lease, model route materialization or executor heartbeat was created, while the Runtime worker heartbeat remained healthy.

Source review identified a residual monorepo assumption in Agent Input preparation. Harness-owned schemas were read from `<consumer>/.agents/schemas`, but standalone consumers expose those schemas through the harness/submodule root. Exact `readFile` therefore failed before `dispatchPreparedTask`.

The remediation makes harnessRoot the schema authority in Agent Input preparation and in the OpenCode Runtime child executor, while preserving repositoryRoot for consumer-owned Task Briefs, Context Packets, workspaces and runtime evidence. Reconcile failure events now persist code+message and qualification snapshots retain the message.

Focused dual-root contracts and the complete public harness contract suite pass after this change.

## R-7 Task Brief SDD workflow-skill schema parity remediation

After the standalone dual-root Agent Input fix, live R-7 preparation reached Task Brief validation and repeatedly failed with `taskBrief.sdd.workflowSkill: expected const "agent-harness-sdd-workflow"`. The builder still emitted the stale literal `agentic-harness-sdd-workflow`. This revision aligns `buildTaskBrief()` with the schema authority and adds a parity contract so the invalid namespace cannot recur silently.


## Runtime-child OpenCode config isolation qualification fix

A live standalone R-7 reached physical Product Discovery execution but OpenCode exited non-zero because the worker consumed the host-generated Windows effective config through the consumer bind mount. The worker had generated a Linux config earlier at the same `<consumer>/.runtime/opencode.effective.json` path; R-5 host generation later overwrote it. Source now gives Runtime children a container-private effective config (`/tmp/agentic-harness/opencode.effective.json`) via `AGENT_HARNESS_OPENCODE_CONFIG_OUTPUT`, while host effective config remains consumer-owned evidence. Contracts prove the child generation cannot clobber an existing host config.

## R-7 Technical Refinement admissibility hardening

Fresh standalone qualification advanced through real Product Discovery and Architecture Review, then exposed two deterministic Technical Refinement blockers: pathless generic coder ownership and a Product Owner catalog with no implementation-proof criterion. ADR 0018 resolves both without weakening domain ownership. `coding-fast`/`coding-pro` are explicit `fallback-unclaimed-primary` owners, blocked whenever a non-fallback implementation/platform agent has matching primary ownership. Completed Product Discovery now requires at least one `proofStage=implementation` criterion and same-attempt criteria projection may repair only the proof-stage classification of an existing grounded criterion. Packaging-workspace validation after the change: `npm run harness:test` 58/58 PASS; `harness:qualify -- --self-test` PASS. Full target-host TypeScript/live qualification remain target-host authority.


## R-7 worktree integration materialization hardening

A live standalone run reached Product Discovery, Architecture Review, Technical Refinement, and Implementation integration, then QA correctly reported that the implementation/test files were absent and that zero tests were discovered. Initial source review identified a genuine independent worktree edge: `git diff --binary HEAD -- <changedPaths>` omits brand-new untracked files. The resulting ADR 0019 hardens Git-worktree integration with intent-to-add, untracked discovery, and post-integration materialization proof.

A later qualification/source reconstruction established that Docker event-driven tasks are materialized as `mode=copy`, not `worktree`; therefore ADR 0019 was not the causal fix for that specific live QA symptom. ADR 0020 records the actual live root cause: the Rust worker's out-of-repository copy workspace was container-local and invisible to Context Engine finalization. ADR 0019 remains valid coverage for worktree mode and for the general integration materialization invariant. Packaging-workspace validation after ADR 0019: `npm run harness:test` **59/59 PASS**, `harness:qualify -- --self-test` **PASS**.


## R-7 shared Runtime workspace authority remediation

A fresh live standalone qualification completed Product Discovery model execution and `completion.proven`, then failed finalization with `handoff_reused_paths_invalid: docs/specs/example/PRD.md:missing_in_workspace`. The PRD was a valid consumer file, but the Rust worker had materialized the mutable task workspace outside `/workspace/repository` in worker-local container storage. Context Engine finalization runs in a different container and therefore could not inspect the `workspace.path` returned by the worker. The same topology also made copy-workspace integration incapable of reading worker-created implementation files.

The standalone Compose topology now mounts one consumer-scoped named `agent-harness-agent-workspaces` volume at `/workspace/agent-workspaces` in both Context Engine and the Rust worker and pins `AGENT_HARNESS_AGENT_WORKSPACE_ROOT` to that shared authority. Qualification R-4 inspects both containers and fails closed unless the environment root, mount destination, mount type and Docker volume source are identical. The volume remains non-external and is isolated by the existing deterministic consumer-scoped Compose project name.

## R-7 zero-file governance phantom reuse remediation

After ADR 0020, target-host R-4 proved that Context Engine and the Rust worker share `/workspace/agent-workspaces`, and Product Discovery integrated successfully. Architecture Review then completed execution and `completion.proven` but was rejected because its handoff listed `docs/architecture/example-anonymous-fallback.md` as `reusedPaths` even though the path existed in neither the review workspace nor its baseline.

ADR 0021 keeps repository evidence fail-closed while normalizing this narrow bookkeeping contradiction. For `role=contract`, `*-review`, `estimatedFiles=0`, `status=complete` tasks only, an owned path absent from both workspace and baseline may be removed from `reusedPaths` only if no handoff evidence outside the path-disposition arrays references it. An evidentiary phantom, a deleted baseline artifact, or any implementation/verification task remains invalid. The Runtime emits `workspace.phantom_reused_paths_dropped` when the normalization occurs, and the bootstrap review prompt explicitly forbids invented artifact paths.

## R-8 progress-aware Durable Continuation remediation

A target-host run completed the entire R-7 workload and closed the Runtime with QA and Product Acceptance verified, then R-8 produced a Qualification Procedure HOLD after a fixed ten-minute wait for both continuation `acceptedAt` and `observedAt`. The Rust worker's authoritative assistant-completion timeout defaults to fifteen minutes, so the gate could reject a valid accepted continuation before Runtime itself considered the assistant completion overdue.

R-8 now reads the effective worker completion timeout, observes delivery/continuation status, exact wake history, session telemetry and the parented assistant child, emits progress checkpoints, fails explicit dead/ambiguous/manual-review states immediately, and succeeds only after ordered acceptance/observation plus exact event/message cardinality. No Rust continuation state-machine semantics were changed.

The same observer replaces R-10's duplicate fixed ten-minute post-recovery acceptance/observation wait; R-10's fault injection and deferred-delivery assertions are otherwise unchanged.

## R-8 line-safe observer and multi-assistant parity remediation

A follow-up target-host run again passed R-7 but R-8 reached its progress-aware safety ceiling with a self-contradictory observer snapshot: delivery identity fields existed while status/timestamps were missing, attempts rendered as `NaN`, `wakeCount=0` despite one matching message id, and seven assistant records were parented by the same deterministic wake.

The observer was parsing a `psql` tab-delimited row that included multiline `prompt_text`, then splitting stdout on newlines. The first embedded prompt newline truncated the logical row after the fourth selected column. R-8 now asks PostgreSQL for one JSON object scalar, preserving the full prompt and all delivery fields. Malformed delivery projections fail immediately as Qualification Procedure.

The same live snapshot exposed an incorrect qualification-only cardinality assumption: OpenCode tool-using turns can emit several assistant records for one user wake. Runtime Rust already selects the latest assistant child by creation time. Qualification now mirrors that rule and verifies that the unique `continuation.delivered` event names the same latest terminal assistant message id together with the exact delivery/effect/wake/generation identity. Exactly one deterministic user wake remains mandatory. No Rust continuation semantics changed.

## R-8 premature tool-call terminal observation remediation

After ADR 0023 fixed the observer framing, the next target-host run exposed a genuine Runtime divergence. R-7 passed, the deterministic wake was materialized exactly once, and PostgreSQL persisted the continuation as `observed`/`delivered` with ordered `acceptedAt < observedAt`. At the same instant OpenCode still reported the session `busy` and the newest assistant child for the wake was pending.

The Rust continuation state machine treated `time.completed` or any non-empty `finish` on the latest assistant child as terminal. OpenCode 1.18.x, however, persists completed tool-call steps with both `finish=tool-calls` and `time.completed` before continuing the same user turn with another sibling assistant message. Runtime could therefore persist `observedAt` after an intermediate tool step.

ADR 0024 classifies tool-followup finish reasons as non-terminal. The latest tool-call child now keeps the delivery `accepted` despite its local completed timestamp, and an older completed child cannot override a newer tool-call child. The qualification observer mirrors this rule for diagnostics; R-8 itself remains strict.

Packaging validation after the source change: focused qualification-controller contracts **26/26 PASS**, full `npm run harness:test` **73/73 PASS**, and `npm run harness:qualify -- --self-test` **PASS**. Rust compilation/tests remain target-host R-2 authority because the packaging container does not provide Rust/Cargo.

## ADR 0025 — finite standalone terminal resume

The latest R-8 live run proved one accepted deterministic wake but timed out after the authoritative 900-second assistant-completion window with the latest assistant still pending. Source review found that the continuation prompt still assigned the resumed Main Orchestrator the pre-standalone Runtime V2 `outer-controller procedure` / qualification-verdict responsibility even though standalone promotion is now controlled externally. ADR 0025 removes that ownership drift: `agent_summary` exactly once, finish the original user-facing request, no same-request Runtime re-entry, then end the turn. Qualification diagnostics now capture bounded tool-call name/status/timestamps so any remaining pending boundary is directly observable without persisting tool inputs/outputs.


## ADR 0026 — persistent-host Superpowers isolation

A fresh standalone qualification passed Q-ENTRY through R-6, then held at R-7 because the qualified Main Orchestrator loaded process guidance, inspected the accepted PRD/ADR, and asked for an extra design/proceed approval instead of entering Runtime. No `agent_start` was attempted and no Runtime run or continuation was created.

The source-level conflict was that the Main Orchestrator's mandatory `runtime-continuation` → `agent_start` ingress contract coexisted with Superpowers `brainstorming`, whose generic workflow requires user approval before proceeding. ADR 0026 removes that conflict without weakening specialist SDD: persistent-host effective OpenCode strips the Superpowers plugin/catalog and the Main Orchestrator denies every pinned Superpowers skill, while Runtime-child effective OpenCode retains the pinned plugin/catalog. R-0 and R-5 now fail closed if this host/child split drifts.

Packaging validation after ADR 0026: full `npm run harness:test` **78/78 PASS** and `npm run harness:qualify -- --self-test` **PASS**. The live target-host qualification remains authoritative for R-2 through R-11; this source change requires a completely fresh `harness:qualify` run.

## ADR 0027 — monotonic Technical Refinement review repair

The first fresh live run after ADR 0026 proved that persistent-host ingress is fixed: R-7 created Runtime run `run-310b6dab-53dd-42d6-84b7-ff6b1bc42e68`, Product Discovery and Architecture Review integrated, and Technical Refinement became the first divergence after exhausting three `review_not_approved` attempts. Same-attempt repair events were present, but the qualification snapshot exposed only the terminal review code and not the concrete `requiredDeltas`.

ADR 0027 closes the repair protocol rather than weakening the review gate. Each Technical Refinement repair pass now re-reviews only the exact incoming `requiredDeltas`; `approved` closes all of them and `changes_requested` may retain only an exact subset. A bounded re-review cannot invent a new delta or change the failure into a newly discovered blocker. Pre-repair `blocking:` residual risks and `required:` follow-ups are explicit closure candidates and are removed only when the re-review explicitly proves those exact strings resolved; unclosed markers remain completion-blocking. Reprojection failure restores the prior negative review so the bounded loop remains fail-closed.

Technical Refinement also no longer declares interactive Superpowers planning/worktree/review workflows. Its `implementationPlan` contract plus Runtime deterministic validators are the sole planning authority for that non-interactive stage; other Runtime specialists retain stage-compatible Superpowers. R-0 guards this source invariant. Runtime/qualification repair evidence now carries current and remaining `requiredDeltas` so the next live HOLD, if any, exposes the exact semantic scope.

Packaging validation after ADR 0027: full `npm run harness:test` **81/81 PASS**, `npm run harness:qualify -- --self-test` **PASS**, changed JavaScript syntax checks **PASS**, and `git diff --check` **PASS**. Full target-host qualification remains authoritative; because source changed, R-0 onward must be rerun from a fresh committed candidate.

## ADR 0028 — deterministic R-9 physical worker loss

The first fresh target-host run after ADR 0027 passed R-7 end-to-end and R-8 Durable Continuation, then held in R-9 with `qualification_wait_timeout:r9-worker-restart:120000`. The standalone controller had called `docker kill` against a worker configured with `restart: unless-stopped`; that is an administrative/manual stop boundary, so waiting for Docker to auto-restart the container was a qualification-procedure contradiction rather than Runtime failure.

ADR 0028 restores the promoted physical process-loss semantics. R-9 now arms the existing `repair-checkpoint-after-full-agent` executor boundary only for Technical Refinement attempt 1, waits for the exact `qualification-process-loss` repair checkpoint, kills the worker init PID through the existing isolated host-PID-namespace SIGKILL helper, expires only the exact killed execution lease and wakes the semantic controller. PASS requires one Docker restart/PID replacement, semantic attempt preservation, exact generation/fencing +1, exact checkpoint identity, one replacement prepare/dispatch/resume chain, `skippedFullAgentInvocation=true`, no duplicate repair effects, terminal run closure and consumer validation. The qualification boundary is explicitly disarmed before R-10.

Packaging validation after ADR 0028: full `npm run harness:test` **85/85 PASS**, `npm run harness:qualify -- --self-test` **PASS**, changed JavaScript syntax checks **PASS**, and `git diff --check` **PASS**. Docker Compose config/runtime behavior remains target-host R-2/R-9 authority because Docker is unavailable in the packaging environment.

## ADR 0029 — R-9 worker fault-environment projection

The first fresh target-host qualification after ADR 0028 again passed R-7 and R-8, then held at R-9 with `qualification_wait_timeout:r9-process-loss-boundary:1200000`. No physical process loss had occurred. Source review found that ADR 0028 had wired the four `AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_*` variables into `context-engine` rather than `agent-runtime-worker`, while the qualification boundary is evaluated by `opencode-task-executor.mjs` under the worker process environment. The checkpoint being awaited was therefore unreachable.

ADR 0029 moves those qualification-only variables to the Runtime worker and makes R-9 prove exact Docker `Config.Env` projection before it launches the semantic fault run. Projection mismatch now fails immediately as `QUALIFICATION PROCEDURE`; once projection is proven, failure to materialize the exact checkpoint is classified as `RUNTIME` with run/task/event evidence. Successful R-9 also proves the exact disarmed worker environment before R-10. Contracts prevent the variables from drifting back into Context Engine.
