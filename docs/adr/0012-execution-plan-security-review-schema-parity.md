# ADR 0012 — Execution-plan Security Review schema parity

Status: Accepted

## Context

A fresh standalone qualification reached R-7 and the qualified Main Orchestrator correctly invoked `runtime-continuation` followed by Context Engine `agent_start`. Runtime planning rejected its own generated bootstrap plan with:

`executionPlan.workflow.requiresSecurity: additional property not allowed`

The planner and distributed review-capability catalog already treated `review.security` as a first-class bootstrap capability and projected `workflow.requiresSecurity`, but `execution-plan.schema.json` had not been updated to permit that projection.

## Decision

1. `workflow.requiresSecurity` is a required boolean in execution-plan schema v2, alongside database, infrastructure and AI/LLMOps review projections.
2. Provisional bootstrap plans explicitly set `requiresSecurity=false` until Product Discovery authorizes the review topology.
3. Refined bootstrap plans project `requiresSecurity` from the authoritative selected `security-review` stage.
4. Contract tests must create and schema-validate a security-sensitive plan and its provisional projection.
5. Qualification R-7 must distinguish an `agent_start` attempt rejected by Runtime validation from a Main Orchestrator that never attempted Runtime ingress.

## Consequences

The planner can no longer generate an execution plan that its own schema rejects solely because Security Review was selected, and R-7 failure attribution remains causal.
