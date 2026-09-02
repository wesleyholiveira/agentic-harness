# ADR 0121 — Unified Agent Input Plane

## Status

Promoted with R16/R16.1 on 2026-08-28. See [`../operations/snapshots/agent-runtime-v2-r16-r16-1-promotion-20260828.md`](../operations/snapshots/agent-runtime-v2-r16-r16-1-promotion-20260828.md).

## Context

R15.6.12 proved the Runtime V2 control/execution/recovery plane, but only the Context Engine retrieval subset had exact raw-versus-delivered accounting and compaction. Task Briefs, executor contracts, schemas, upstream handoffs, registry/governance data and lazy full-artifact reads crossed independent boundaries, so the same authority could reach a model more than once and the reported Context Pack savings could not describe total Runtime-owned input.

## Decision

All primary specialist input is inventoried by immutable `AgentInputManifest/v1` for one semantic task attempt. Exact authorities remain exact; deterministic projections reduce handoff and governance wire payloads; full artifacts are content-addressed and lazy-loadable only when the manifest authorizes them.

The default OpenCode launcher is manifest-only. Fresh execution creates one manifest after Context Packet + Task Brief preparation. True task retry creates the manifest for its new semantic attempt. Same-attempt repair keeps that attempt's manifest. Process-loss replacement MUST reuse and hash-verify the existing manifest; absence or fingerprint divergence fails closed rather than rebuilding input.

Task Briefs and schemas remain exact authority. The Context Packet wire representation excludes AGENTS/skills/full agent catalog/full handoffs already represented by other boundaries. Technical Refinement receives `agent-ownership-projection/v1`; distributed `.agents/agents/*/agent.json` manifests remain capability/ownership catalog authority; the Runtime DAG remains dynamically compiled from the implementation plan. Handoff wire projections carry bounded lineage/review/result evidence plus content-addressed references; product criterion statements remain authoritative in the Task Brief instead of being repeated in the projection.

Lazy expansion uses `context_get_agent_input_artifact` and is bound to run/task/attempt/manifest/artifactRef. The Context Engine verifies caller ownership, current attempt, manifest fingerprint, content hash, media type and size before recording an idempotent PostgreSQL receipt and returning content.

Runtime-owned accounting is category-aware. Per-manifest and run-global totals carry canonical content hashes, measure wire duplication, distinguish projected/lazy data, and recompute effective delivered/saved input after observed lazy expansion. Provider input/output/cache usage remains a separate observed plane and is explicitly non-additive.

## Consequences

- Full registry/handoffs are no longer implicit primary-model attachments.
- Windows argv remains bounded because the launcher receives one manifest plus only manifest-authorized attachments.
- Model comparison can use exact Runtime-owned input accounting without claiming hypothetical provider-token savings.
- Replay/evidence captures manifest-ready/reuse checkpoints and events; H-9R must prove source/replacement manifest identity in addition to R15 fencing/resume invariants.
- Historical artifacts remain readable, but new production execution has no silent legacy launcher fallback.
- The temporary restriction on model-routing work was satisfied by the R16/R16.1 promotion. Any later routing change remains independently benchmark- and promotion-gated.
