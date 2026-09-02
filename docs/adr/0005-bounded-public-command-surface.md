# ADR 0005 — Bounded public command surface

**Status:** Accepted

## Context

The source project accumulated a large number of version-specific test and qualification aliases. They were useful during evolution but are not a stable interface for a reusable submodule.

## Decision

Expose only lifecycle-level `harness:*` scripts. Versioned/internal executors and contracts live under implementation directories and are invoked by `harness:test`/`harness:qualify` rather than as package-script API.

Historical R17.4.5 evidence is retained only under `qualification/baseline/r17.4.5/` for lineage.

## Consequences

Consumers learn a small stable CLI. New internal checks do not inflate `package.json`; the aggregate test runner discovers contract files automatically.
