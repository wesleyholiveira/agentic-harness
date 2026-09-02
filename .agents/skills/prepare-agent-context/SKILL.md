---
name: prepare-agent-context
description: Build the smallest authoritative Context Packet needed by a specialist task.
---
# Prepare agent context
1. Include the Task Brief, owning agent manifest, applicable `AGENTS.md` and activated skills.
2. Add only relevant ADR/PRD/design fragments, upstream handoffs, source symbols and tests.
3. Prefer content-addressed references/lazy artifacts for large evidence rather than duplicating it inline.
4. Separate authoritative facts from hypotheses and convenience summaries.
5. Record revision/hash identity for contracts that must survive retries or process replacement.
6. Rebuild the packet when a material upstream authority changes.
