# ADR 0126 — R17.3 Qualification Meta-Run Admission Gate Token Scoping

**Status:** Implemented in source; pending fresh promotion qualification  
**Date:** 2026-08-28  
**Scope:** Runtime V2 qualification admission guard only

## Context

The fresh R17.2 qualification passed R-0 through H-8 but the single H-9P `agent_start` was rejected before run creation with:

```text
agent_runtime_qualification_meta_run_forbidden:
outer_qualification_gates_requested_inside_runtime:SOURCE,R-0
```

The exact immutable H-9P workload was not a meta-run. It explicitly kept final R-0/post-cleanup evidence in the outer qualification controller while asking the Runtime to execute only the in-run verification/reuse workload.

The admission guard had two overly broad lexical rules:

1. `SOURCE` was matched case-insensitively with a word-boundary regex. Ordinary phrases such as `tracked repository source` and the criterion identifier `R17-SOURCE-1` could therefore be normalized into the canonical outer gate `SOURCE`.
2. Once any two distinct outer-gate-looking tokens existed anywhere in the request, any execution verb anywhere else in the request was sufficient to classify the whole workload as a meta-run. This created a global-correlation false positive for legitimate workloads that merely reference outer-controller evidence.

No Runtime run was created, so this incident provides no H-9P performance evidence and H-9R was correctly withheld.

## Decision

1. The canonical `SOURCE` qualification gate is recognized only as a standalone **uppercase** token. Lowercase prose `source` and hyphenated identifiers such as `R17-SOURCE-1` are not `SOURCE` gate references.
2. Execution intent and multiple outer gates are correlated **clause-locally**. A normal workload may mention outer-controller evidence in another clause without becoming a meta-run.
3. `PROMOTION PASS|FAIL|HOLD` combined with multiple real outer gates remains a global fail-closed signal because a Runtime workload must never self-certify promotion.
4. Explicit runbook execution remains forbidden.
5. Qualification-controller prompt-path execution remains forbidden and the path matcher is version-neutral across Runtime qualification/validation prompt revisions instead of being hard-coded to the historical R15 path.
6. The exact immutable H-9P workload from the R17.2 incident is a mandatory regression fixture and must be admitted before a fresh R17.3 live qualification may reach H-8/H-9P.
7. Existing R15.6.2 and R15.6.9 anti-meta-run contracts remain mandatory; R17.3 may narrow false positives but may not reopen recursive qualification execution.

## Non-goals

- No change to OpenCode spawning, model routing, scheduler behavior, R16 manifests, QA evidence routing, deterministic reuse, process-loss recovery or R17.2 Rust telemetry.
- No weakening of the outer-controller boundary.
- No attempt to infer user intent with an LLM inside admission. Admission remains deterministic and fail-closed.

## Qualification consequence

Source changed after the R17.2 HOLD. R17.3 therefore requires a fresh byte-consistent:

`R-0 → R-1 → R-2 → R-2P → H-8 → H-9P → H-9R`

The H-9P exact workload must first be shown admissible by the focused contract and then be accepted by the live `agent_start`. If live admission rejects it, R17.3 is HOLD even if all source tests pass.
