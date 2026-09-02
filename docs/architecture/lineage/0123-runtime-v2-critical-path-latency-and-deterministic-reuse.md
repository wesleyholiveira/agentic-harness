# ADR 0123 — Runtime V2 critical-path latency, deterministic reuse and benchmark-gated routing

- Status: Implemented in source; pending fresh R17 qualification
- Date: 2026-08-28
- Parent baseline: promoted R16/R16.1 (`4abae5f419ba47a727211f9a324178d39507df44a482e744409b376e366d74d6`)

## Context

R16 proved that Context Engine compaction, exact cache, lazy input expansion, manifest identity and process-loss repair are correct, but the promoted H-9 evidence still showed roughly 242k effective Runtime-owned tokens, more than 537k provider input tokens and a user-visible execution time that can reach tens of minutes per semantic task. Retries were zero. Token efficiency is therefore necessary but not sufficient: normal-path wall-clock and the number of full specialist invocations are first-class operational constraints.

The Runtime already has an asynchronous RabbitMQ/Rust execution plane and a dependency DAG, but the semantic controller prepared multiple ready tasks serially before dispatch. It also lacked a durable phase-level latency model and had no safe no-LLM execution mode for an implementation work item whose output was already materialized and only required byte-identity plus executable validation.

## Decision

### 1. Latency is an authoritative qualification dimension

Runtime efficiency now includes `runtime-performance/v1`, derived from durable task/event evidence. Each semantic attempt can expose:

- semantic preparation;
- queue wait;
- workspace materialization;
- executor wall-clock;
- OpenCode invocation wall-clock (`opencode.launching` -> `opencode.completed`) when a full specialist runs;
- Runtime wrapper time before/after OpenCode;
- result transfer;
- semantic finalization;
- total task/attempt wall-clock.

The report also derives serialized task time, DAG critical path, theoretical parallel opportunity and observed parallel speedup. Missing timing evidence yields `INCOMPLETE`, never an invented measurement. The Rust worker buffers bounded runtime events emitted by the OpenCode executor and the finalizer persists the performance-safe subset, so R17 can distinguish Runtime wrapper overhead from the OpenCode/model/tool loop. Provider-internal TTFT/reasoning duration is still not fabricated: `openCodeMs` is an observed outer boundary, not provider-only inference time.

The default normal-run SLO is fail-closed:

| Metric | R17 good-enough threshold |
| --- | ---: |
| Run wall-clock | <= 90 min |
| Maximum normal task wall-clock | <= 15 min |
| p95 normal task wall-clock | <= 12 min |
| p95 queue wait | <= 30 s |
| p95 semantic preparation | <= 90 s |
| p95 semantic finalization | <= 90 s |
| Retry attempts in immutable qualification | 0 |
| Observed parallel speedup when theoretical opportunity >= 1.25x | >= 1.15x |

Qualification runbooks may add stricter workload-specific bounds but may not loosen these thresholds to force a pass.

### 2. Deterministic implementation reuse is explicit and proof-based

`implementationPlan.workItems[*].executionMode` is either `agent` (default) or `deterministic-reuse`.

`deterministic-reuse` is admitted only when all of the following are true:

- stage is implementation;
- `contractChange=false` and `migration=false`;
- `validationExecutionScope=workspace`;
- every owned path is exact (no glob/wildcard) and already materialized;
- every blocking implementation criterion has an executable verification command;
- each criterion verification appears byte-for-byte in the work-item validation authority.

The Runtime executor then:

1. verifies the `AgentInputManifest/v1` and exact Task Brief content hash;
2. fingerprints every owned file before validation;
3. executes Task Brief validation itself;
4. fingerprints every owned file after validation;
5. emits `changedPaths=[]` and `reusedPaths` only if the bytes stayed identical;
6. emits runtime-owned validation receipts and criterion evidence;
7. performs no OpenCode/model invocation.

A failed command, changed byte, missing exact path, missing manifest authority or ambiguous criterion fails closed. No heuristic cache hit is sufficient.

### 3. Ready-task preparation is parallelized

Once dependency, retry-window, topology, policy and `maxParallel` admission have selected a ready set, semantic preparation for those independent tasks executes concurrently. Database dispatch/fencing remains transactional and task-scoped. The Runtime persists `scheduler.ready_preparation.completed` so the optimization is itself observable.

This does not reorder dependencies and does not increase the configured execution concurrency beyond `maxParallel`.

### 4. Rust persists executor and OpenCode phase timing

The worker persists `workspace.ready` and `executor.completed` with attempt/generation/fence identity and `executionMode`. It also captures a bounded set of `@@agentic-harness-runtime-event` records from the child process. The event-driven finalizer promotes only the performance-safe OpenCode lifecycle subset (`opencode.launching`, `opencode.spawned`, `opencode.completed`, session-export/authority timing) into durable run events, preserving their observed timestamps. The execution result carries both `executionMode` and the bounded runtime-event buffer. Timing events are observability evidence; they do not become semantic authority.

### 5. Model routing becomes latency-aware but remains benchmark gated

R17 does not replace the promoted model by assumption. `openai/gpt-5.6-luna` remains the production champion. `.agents/model-routing.json` carries class-specific p95 targets and a champion/challenger promotion policy.

A challenger can become a production class default only after matched workload benchmarking with at least 10 warm and 3 cold samples, zero blocking quality regressions, at least 30% median latency improvement and no p95 latency regression. Candidate identity must be resolved from the actual OpenCode/provider catalog; model names are never guessed.

## Consequences

- Token savings and wall-clock become independently visible.
- A 30-minute semantic task can no longer hide behind a green correctness qualification.
- Pure immutable implementation verification can skip a full LLM invocation without weakening validation.
- Independent ready tasks reach the Rust execution plane faster.
- Slow model/tool loops can be distinguished from queue, preparation and finalization overhead.
- Model migration can proceed from measured champion/challenger evidence rather than intuition.

## Non-goals

R17 does not claim provider-internal TTFT or reasoning duration when unavailable, does not automatically infer deterministic reuse from similarity/cache signals, does not alter process-loss same-attempt manifest semantics, and does not automatically promote Qwen or any other challenger.
