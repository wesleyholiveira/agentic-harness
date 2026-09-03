# ADR 0007 — Submodule-safe containerized migration execution

**Status:** Accepted

## Context

The public `harness:migrate` command must work when Agentic Harness is consumed as a clean Git submodule. A submodule checkout does not contain `node_modules`, even when the authoritative outer harness checkout used by qualification has already run `npm ci`. The migration implementation imports `pg`, so spawning `scripts/harness-migrate.mjs` directly from `<consumer>/.harness` makes Node resolve dependencies relative to that clean submodule and fails with `ERR_MODULE_NOT_FOUND`.

Copying or installing `node_modules` into every consumer submodule would violate the intended reusable-source boundary and duplicate dependency state.

## Decision

`harness:migrate` executes the existing `scripts/harness-migrate.mjs` through the Compose `database-migrate` service instead of spawning it directly on the host.

The launcher uses the current consumer-scoped Compose project identity and runs:

`docker compose -p <consumer-project> -f <harness>/compose.yaml --profile runtime run --rm --build database-migrate`

The `database-migrate` image is built from the harness lockfile, performs `npm ci`, contains the migration script and joins the same Compose network as the consumer-scoped PostgreSQL service. The SQL migration implementation remains single-sourced in `scripts/harness-migrate.mjs`.

## Consequences

- consumers do not need `node_modules` inside `.harness`;
- `pg` resolves from the container image built from the harness lockfile;
- migration service discovery uses the Compose service name `postgres` rather than a host-only address;
- migration reruns remain scoped to the same per-consumer Compose project, network and PostgreSQL volume used by `harness:up`;
- the public migration command requires Docker/Compose, which is already a prerequisite of the standalone runtime infrastructure;
- direct execution of `scripts/harness-migrate.mjs` remains an internal implementation detail for the image and is not the supported submodule-facing API.

The contract suite must fail if the public launcher regresses to host-spawning the migration script.
