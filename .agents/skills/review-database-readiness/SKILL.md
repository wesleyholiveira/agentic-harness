---
name: review-database-readiness
description: Use during database review to assess schema design, ACID compliance, index strategy, planner compatibility, normalization/denormalization trade-offs, migration idempotency and compatibility with existing data. Do not use as a substitute for application architecture or domain model implementation.
---

# Review Database Readiness

1. Consume the exact PRD and architecture revision.
2. Identify every schema object, migration, index, constraint and query affected by the change.
3. Verify ACID boundaries: transaction scope, isolation level, fencing tokens, idempotency keys and outbox consistency.
4. Assess index strategy: type (btree, gin, gist, brin), selectivity, partial/covering indexes and planner cost estimates.
5. Evaluate normalization vs. conscious denormalization (e.g., report-oriented tables) with explicit justification.
6. Verify migration idempotency, forward-only naming (`NNNN_nome.sql`), backfill safety and compatibility with existing data.
7. Check query patterns for N+1, missing indexes, seq scans on large tables and lock contention.
8. Return `approved`, `changes_requested` or `blocked` with schema deltas, index recommendations and risk assessment.
