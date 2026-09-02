# ADR 0134 — Product Discovery source authority and OpenCode attempt-state isolation

**Status:** accepted for R17.4.3 qualification

## Context

R17.4 H-9P run `run-73d6ea3c-7405-4578-9535-832e2598ec81` exposed two independent retry-amplification causes after R17.4.2 recovered the original durable failure messages:

1. Product Discovery attempts 1 and 2 failed with `product_discovery_bootstrap_assessment_invalid` because an `authoritative-context` fact wrote the already-authorized qualification PRD filename (`docs/specs/agent-runtime-v2-r17-deterministic-reuse-qualification/PRD.md`, once with `#metadata`) into `factRequirements[].source`. The bootstrap fact contract intentionally accepts only canonical authority labels (`product-discovery`, `frozen-adr`, `project-memory`, `repository-context`). The bounded projection schema had not closed `source` to that enum, so a same-attempt projection could repeat the same invalid representation and exhaust repair.
2. Database Review attempt 1 exited non-zero with OpenCode stderr `database is locked`. Runtime specialists may execute concurrently, but the real task executor inherited one shared OpenCode mutable data directory/database even though the doctor probe already isolated its OpenCode state. The generic non-zero classifier then incorrectly labelled this local tooling-state collision as a semantic retry.

The historical `operational-readiness:database` failure message remains compressed in the recovered evidence, so this ADR does not claim its exact cause. The state-isolation decision applies to every Runtime specialist and therefore removes the proven shared-database hazard independent of stage.

## Decision

1. Product Discovery structured assessment projection closes `factRequirements[].source` to the canonical authoritative-source catalog.
2. Before spending an auxiliary model call, Runtime may deterministically rewrite a non-canonical repository filename/anchor to `repository-context` **only** when the normalized filename is already present as an included Context Packet reference. The path remains in the fact `evidence`; no new fact, evidence, rationale or authority is invented. Unlisted paths remain fail-closed.
3. Every full OpenCode semantic attempt receives a task/attempt-scoped mutable OpenCode state:
   - unique `XDG_DATA_HOME`;
   - unique `XDG_STATE_HOME`;
   - a copied credentials file when the existing supported OpenCode auth file is available;
   - the existing `XDG_CACHE_HOME` remains shared so model/tool cache reuse is not discarded.
4. The exact same isolated environment is used by the primary `opencode run`, `opencode export`, and all auxiliary structured-model OpenCode servers in that semantic attempt. A true task retry receives a new isolated state directory; repair-resume that skips a full agent invocation does not create a replacement OpenCode launch.
5. OpenCode stderr containing `database is locked` is classified as `opencode_state_database_locked`, category `tooling-infrastructure`, disposition `true-retry-transient`. It is never classified as semantic agent failure.
6. R17.4 performance SLOs are unchanged. In particular, transient retries remain forbidden in H-9P. Isolation is intended to remove the collision, not to make it acceptable.

## Consequences

- The exact Product Discovery failure observed in attempts 1 and 2 can be repaired deterministically when the PRD is already authorized by the Context Packet, avoiding a full task retry and normally avoiding an auxiliary model call.
- Concurrent specialist OpenCode processes no longer contend on one mutable `opencode.db`/session state database.
- Session export and same-attempt structured repair see the same OpenCode state as their primary invocation.
- A future OpenCode state lock remains visible as infrastructure evidence and forces H-9P HOLD under the existing transient-retry SLO.
- No model routing, scheduler topology, deterministic-reuse eligibility, process-loss semantics or performance threshold is weakened.
