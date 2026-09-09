# ADR 0036 — Runtime-owned Handoff identity echo

Status: accepted

## Context

The execution plane already fences `runId`, `taskId`, and `agentId` through the Runtime task envelope, Task Brief, agent-input manifest, workspace identity, dispatch generation, and fencing token. The Handoff Result nevertheless required the model to echo the same three strings and treated any non-empty typo as a terminal `handoff_identity_mismatch`.

A qualification run demonstrated the failure mode: the Product Acceptance model returned the correct `runId` and `agentId` but omitted one character inside the echoed `taskId`. The authoritative agent-input manifest and Task Brief both carried the correct task identity, yet the nondeterministic echo was allowed to invalidate the deterministic task.

## Decision

Handoff identity fields remain required in the persisted Handoff Result, but they are runtime-owned identity echoes rather than an execution fence. The authoritative values come from the already-fenced Task Brief/input manifest.

Normalization may canonicalize exactly one conflicting non-empty identity echo only when the other two identity fields match their authoritative values byte-for-byte. Missing identity fields continue to be filled from the Task Brief. The correction is recorded as `identityEchoCorrections` in Runtime normalization telemetry.

If two or more non-empty identity fields conflict, or a single conflict is not accompanied by two exact identity matches, normalization remains fail-closed with `handoff_identity_mismatch`.

The agent-input manifest identity check remains unconditional and terminal: any `manifest.runId`, `manifest.taskId`, or `manifest.agentId` mismatch with the Task Brief fails before the model Handoff can become authoritative. Event-driven finalization also retains the post-normalization equality check against the execution plan.

## Consequences

- A one-field model transcription error cannot override deterministic Runtime identity.
- Cross-task or ambiguous model output remains rejected.
- Transport, manifest, dispatch-generation, fencing-token, and workspace identity checks are unchanged.
- The persisted Handoff always contains canonical Runtime identity.
- Qualification no longer depends on perfect UUID transcription by an LLM when the task identity is already deterministically proven.
