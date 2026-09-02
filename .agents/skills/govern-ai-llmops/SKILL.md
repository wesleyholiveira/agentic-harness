---
name: govern-ai-llmops
description: Use for AI/LLMOps review of model, prompt and dataset lifecycle, evaluation, cost, latency, drift, hallucination containment, promotion and rollback. Do not use to silently change product thresholds or implement domain model code.
---

# Govern AI and LLM Operations

1. Consume the exact PRD, architecture and current distributed agent-manifest revisions.
2. Identify every model, prompt, dataset and configuration that affects behavior.
3. Define immutable versions, lineage, golden sets, offline/online metrics and quality budgets.
4. Define token/GPU/latency/throughput costs and fallback behavior.
5. Specify contamination, leakage, drift and hallucination controls.
6. Require shadow/canary, champion/challenger and rollback evidence before promotion.
7. Return `approved`, `changes_requested` or `blocked` with measurable deltas.
