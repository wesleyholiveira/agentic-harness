# ADR 0003 — Runtime authority and recovery planes

**Status:** Accepted

## Decision

The reusable Runtime keeps the promoted authority split:

- PostgreSQL: durable run/task/checkpoint/ProjectMemory/continuation authority.
- RabbitMQ: at-least-once transport and wake-up, never completion authority.
- Rust worker: physical execution, fencing and durable continuation delivery.
- Context Engine: planning/context/finalization and cache coordination.
- Redis: reconstructible exact and semantic context cache.
- TEI: stateless embedding dependency when semantic reuse is enabled.
- OpenCode: semantic work and specialist execution, never durable completion authority.

Semantic retries create a new attempt. Physical worker loss preserves the semantic attempt and advances `dispatchGeneration` and `fencingToken`; checkpoint repair must avoid a replacement full-agent invocation when the checkpoint proves the completed semantic work.
