# Agentic Harness source of truth

This repository is the canonical source for the reusable Agentic Harness. Consuming repositories should include a **qualified tag** as a Git submodule rather than copying harness files into product source.

## Authority boundary

The harness is authoritative for:

- specialist capability manifests and orchestration policy;
- SDD schemas, templates and workflow contracts;
- Runtime V2 control/execution plane implementation;
- Context Engine and ProjectMemory integration;
- OpenCode configuration/plugins and external-tool wiring;
- Operational MCP tool names, Prometheus metric families and Runtime validation markers use the project-agnostic `agent_harness_*` namespace. Product-lineage identifiers from the pre-standalone product are permitted only inside immutable qualification provenance under `qualification/baseline/**`.
- harness-owned database migrations and operational entrypoints.

A consuming repository remains authoritative for its domain code, product requirements, project ADRs/designs/runbooks, and run-specific Task Briefs/Context Packets.

## Runtime invariants
- Qualification R-7 terminal observation is progress-aware: it follows persisted Runtime task liveness budgets, worker/lease heartbeats and scheduler/finalizer activity instead of imposing a 45-minute whole-run deadline; long waits emit 60-second stderr checkpoints and any watchdog HOLD carries structured PostgreSQL evidence.
- Execution-plan workflow review projections include `requiresSecurity` as a schema-required boolean; provisional bootstrap forces it false and refined topology derives it from the selected `security-review` capability.
- Persistent Main Orchestrator delivery ingress is `runtime-continuation` → `agent_start({ continuation })`; `agent_runs` proves run existence and `agent_continuations` separately proves durable OpenCode session binding.
- Qualification R-4 treats container `Running` and application HTTP readiness as separate proofs; Context Engine, RabbitMQ Management and embeddings must pass bounded HTTP readiness with preserved transport-cause evidence.
- The deterministic qualification controller is host-side and cross-platform: on Windows it resolves `PATH`/`PATHEXT`, directly spawns native executables, and explicitly wraps `.cmd/.bat` shims through `ComSpec` without enabling `shell:true`; batch shims use the `cmd.exe /S /C` outer-quote form with `windowsVerbatimArguments=true` so paths containing spaces are preserved without literal backslash-escaped quotes.
- The persistent Main Orchestrator is control-plane only: delivery/change requests must enter through Context Engine `agent_start`; direct edit/write/patch/bash/task/Serena execution is fail-closed, while Runtime child specialists retain implementation tools.
- Persistent-host process-skill isolation is part of that ingress boundary: host OpenCode must not inject/expose Superpowers design or implementation workflows to the Main Orchestrator, while Runtime child OpenCode retains the pinned Superpowers plugin/skills for specialist SDD execution. R-0/R-5 enforce this split before R-7.

- PostgreSQL is durable run/task/checkpoint/continuation/ProjectMemory authority.
- RabbitMQ is at-least-once transport, never completion authority.
- Rust workers are replaceable physical executors.
- Semantic retry identity is `attempt`; physical replacement advances `dispatchGeneration` and `fencingToken` while preserving the semantic attempt when checkpoint repair is valid.
- Context Engine owns context construction/finalization; Redis/TEI remain reconstructible dependencies.
- OpenCode/model output proposes work and handoffs; durable Runtime evidence proves completion.
- Runtime invocation provenance must register against the same effective Context Engine authority used by the OpenCode MCP configuration. The launcher projects one exact provenance-plugin SHA from the active harness source; the OpenCode plugin must self-match it, and the Context Engine must prove its packaged plugin copy matches it before readiness.
- Workspace integration must materialize the complete reconciled change-set into the consumer root before a task can become `integrated`. New untracked files are included in Git-worktree patches, and post-integration materialization must match the task workspace either byte-for-byte or by canonical Git blob identity when working-tree filters such as `core.autocrlf` legitimately transform bytes.

## Shared execution-workspace authority

- Event-driven mutable task workspaces remain outside the consumer repository but are cross-container Runtime state.
- Standalone Compose mounts one consumer-scoped `agent-harness-agent-workspaces` named volume at `/workspace/agent-workspaces` in both Context Engine and the Rust worker.
- Both services use `AGENT_HARNESS_AGENT_WORKSPACE_ROOT=/workspace/agent-workspaces`; the execution-result `workspace.path` is valid finalizer authority only because R-4 proves the mount source is identical on both containers.
- The workspace volume is non-external and inherits the deterministic consumer-scoped Compose namespace; unrelated consumers must never share it.

## Dynamic agent topology

`.agents/agents/<id>/agent.json` describes capability and ownership hints only. There is no monolithic static call graph. Technical Refinement emits the implementation plan and the Runtime compiler derives the task DAG for the current request. Explicit primary ownership remains the strongest path authority; `coding-fast` and `coding-pro` are project-agnostic `fallback-unclaimed-primary` owners and may touch a path only when no non-fallback implementation/platform agent has a matching primary rule. Product Discovery must also provide at least one `proofStage=implementation` product criterion so the implementation DAG has proof authority.

Technical Refinement is a non-interactive machine-contract stage. Its authoritative planning artifact is `implementationPlan`, not a parallel human markdown-plan/Superpowers workflow. Same-attempt review repair is monotonic: a repair pass may approve or retain only a subset of the exact incoming `requiredDeltas`; it may not discover a new review scope. Pre-repair `blocking:` residual risks and `required:` follow-ups remain fail-closed unless the bounded re-review explicitly closes those exact markers. A new semantic scope requires a fresh full Technical Lead attempt. See ADR 0027.

## Submodule roots

- `AGENT_HARNESS_ROOT`: this repository/submodule.
- `AGENT_HARNESS_PROJECT_ROOT`: consuming repository.

Never collapse these roots in code that reads project context or writes project runtime evidence. A stale inherited `AGENT_HARNESS_PROJECT_ROOT` that resolves to harness source (including a different outer checkout) is not allowed to redirect an invocation made from a real external consumer containing the active harness submodule; the public launcher must recover the consumer cwd and expose that resolution decision in diagnostics.

## Stable public interface

The supported CLI surface is the ten `harness:*` commands in `package.json` / `bin/harness.mjs`. `harness:migrate` is the supported submodule-facing migration entrypoint and executes the internal migrator through the consumer-scoped `database-migrate` Compose service; direct host execution of the migration helper is internal. Internal migration, executor, replay and readiness helpers are implementation details and may evolve without becoming public aliases.

## Promotion rule

- Source-manifest regeneration after a differential with new paths is stage-aware: run `git add -A` before `source-manifest.mjs --write` because manifest authority is the Git-tracked worktree; then stage the regenerated `MANIFEST.json`, verify `--check`, and commit.

A new harness tag is promoted only from an immutable source tree after the standalone contract suite and target-host qualification pass. `npm run harness:qualify` is the deterministic outer qualification authority; it is not an OpenCode agent and never delegates the runbook itself to Runtime V2. The persistent Main Orchestrator stays control-plane only and is exercised as a normal consumer-facing agent only at the live R-7 workload boundary. Historical Runtime qualification under `qualification/baseline/` is lineage evidence, not permission to skip qualification after genericization or future source changes.

- The R-0 legacy product-namespace scan must not embed its own forbidden identifier as a literal; the pattern is composed from fragments at runtime and a contract proves zero operational self-matches outside historical baseline provenance.

- HTTP `main-orchestrator` `agent_start` is fail-closed on consumed OpenCode provenance (`opencode-plugin-sidechannel`, session id, user message id). Runtime run materialization therefore proves provenance without relying on optional logs.

## Dual-root Agent Input authority

- `AGENT_HARNESS_PROJECT_ROOT` is consumer authority for source, product docs, workspaces and `.runtime/**` evidence.
- `AGENT_HARNESS_ROOT` is harness authority for `.agents/**`, including all Runtime JSON Schemas.
- Agent Input Manifest preparation and Runtime child executors must read harness-owned schemas from `AGENT_HARNESS_ROOT`; a standalone consumer is not required or allowed to carry a copied `.agents` tree as a compatibility dependency.
- `runtime.reconcile_failed` evidence must preserve structured failure code/message so scheduler liveness HOLDs retain the causal preparation error.

## Task Brief SDD workflow marker

The canonical serialized Task Brief SDD workflow marker is the `task-brief.schema.json` constant `agent-harness-sdd-workflow`. `buildTaskBrief()` must emit that exact value. A mismatched alias is a Runtime source defect because Task Brief schema validation happens before physical dispatch.


## OpenCode effective-config authority split

Persistent host OpenCode owns `<consumer>/.runtime/opencode.effective.json`. Runtime task OpenCode inside the Linux worker owns an ephemeral container-private `/tmp/agentic-harness/opencode.effective.json`, generated with `AGENT_HARNESS_OPENCODE_CONFIG_OUTPUT`. The two must never share one bind-mounted file. See ADR 0017.

The effective-config split also owns process-skill exposure. Persistent-host generation strips the Superpowers plugin and vendored Superpowers catalog because the Main Orchestrator is only Runtime ingress/egress control plane. Runtime-child generation retains both so specialist agents can use stage-compatible declared Superpowers workflows. Technical Refinement intentionally declares none because its machine-readable planning/review contract is already Runtime authority. See ADR 0026 and ADR 0027.

## Non-evidentiary phantom reuse normalization

- `reusedPaths` is bookkeeping, not evidence authority. Workspace + baseline existence remains authoritative.
- A zero-file `role=contract` `*-review` may drop an owned `reusedPaths` entry only when the path exists in neither workspace nor baseline and is not referenced anywhere else in the handoff evidence.
- The Runtime emits `workspace.phantom_reused_paths_dropped` for that deterministic normalization.
- Missing baseline artifacts, evidentiary phantom paths, and all non-governance/implementation/verification cases remain fail-closed.
- See ADR 0021.

## R-8 Durable Continuation qualification authority

The authoritative standalone R-8 gate is progress-aware. It must respect the effective Rust worker continuation completion timeout (default 900000 ms), require exact deterministic wake materialization for `acceptedAt`, require terminal latest-parented-assistant observation for `observedAt`, and preserve delivery/session/assistant evidence on HOLD. Continuation DB observation is JSON-framed because `prompt_text` is multiline; tab/newline-delimited `psql` row parsing is not an authority for that record. Exactly one deterministic user wake is required, while OpenCode may emit multiple assistant records for the same tool-using turn; the latest child and the persisted `continuation.delivered.assistantMessageId` must agree. A fixed ten-minute `acceptedAt + observedAt` wall-clock timeout is not authoritative.
## Durable Continuation tool-call terminality

- `acceptedAt` proves exact deterministic wake materialization; `observedAt` proves posterior terminal completion of the resumed assistant turn.
- OpenCode tool-using turns may persist an intermediate assistant step with both `finish=tool-calls` and `time.completed` and then continue under the same user wake. That step is non-terminal continuation state.
- Runtime selects the latest assistant child parented by the deterministic wake and keeps the delivery `accepted` while that latest child requires tool follow-up or otherwise lacks terminal proof.
- Qualification mirrors the same rule and must never weaken R-8 merely because PostgreSQL already contains an incorrectly early `observedAt`.
- See ADR 0024.

## Standalone terminal continuation ownership

ADR 0025 is authoritative for the post-wake Main Orchestrator boundary. The deterministic host Qualification Controller owns promotion/fault gates. A terminal wake resumes the Main Orchestrator to call `agent_summary` exactly once, answer the original user from terminal Runtime state, and end the assistant turn. The legacy Runtime V2 wording that assigned an `outer-controller procedure` and qualification verdict to the resumed assistant is not part of standalone authority. R-8/R-10 tool-part diagnostics are observational only.

## R-9 physical worker-loss qualification authority

Standalone R-9 proves unexpected physical executor loss, not an administrative container restart. The controller arms the qualification-only `repair-checkpoint-after-full-agent` boundary for Technical Refinement semantic attempt 1, waits for the exact `qualification-process-loss` repair checkpoint, and then sends `SIGKILL` to the worker's container-init host PID through the isolated host-PID-namespace helper defined by `.agents/runtime/h9r-process-loss.mjs`. `docker kill`/`docker restart` are not R-9 process-loss authority.

After the kill, qualification expires only the exact killed execution lease and wakes `agent_harness_runtime_wakeup`. A valid replacement preserves semantic `attempt`, advances `dispatchGeneration` and `fencingToken` exactly once, preserves checkpoint identity, emits one matching replacement preparation/dispatch/resume chain and proves `skippedFullAgentInvocation=true`. `.agents/runtime/h9r-evidence.mjs` is the aggregate recovery-evidence authority. Qualification fault controls are default-off, attempt-scoped, projected exclusively into `agent-runtime-worker`, proven by Docker `Config.Env` before the R-9 semantic run, and explicitly disarmed and re-proven before R-10. See ADR 0028 for physical-loss/recovery semantics and ADR 0029 for worker environment projection.
