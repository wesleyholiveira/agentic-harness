# ADR 0006 — Consumer-scoped Compose runtime identity

**Status:** Accepted

## Context

The standalone harness is intended to be consumed by independent repositories through the same reusable source checkout or Git submodule. A fixed Compose project name (`agentic-harness`) makes Docker project-scoped resources collide across consumers: containers, the default network and named PostgreSQL/RabbitMQ/Redis volumes can be reused by an unrelated project or by a later qualification consumer.

Published host ports are operator-facing endpoints and already have explicit `AGENT_HARNESS_*_PORT` overrides. They are not durable resource identity and are outside this decision.

## Decision

`AGENT_HARNESS_PROJECT_ROOT` is the input authority for the default Docker Compose project identity.

The harness launcher:

1. canonicalizes the consuming-project filesystem root with native realpath semantics;
2. normalizes Windows identity case-insensitively;
3. hashes that canonical identity with SHA-256;
4. derives `agentic-harness-<16 hex characters>` without embedding the raw path or username;
5. passes the derived name explicitly with `docker compose -p` and scopes `COMPOSE_PROJECT_NAME` only to the Docker Compose subprocess;
6. uses the same project identity for `up`, `down`, `logs` and harness migration context without leaking the generic Compose variable into OpenCode or consumer commands;
7. exposes `AGENT_HARNESS_COMPOSE_PROJECT_NAME` as the only intentional project-name override.

An inherited generic `COMPOSE_PROJECT_NAME` is not authority and is overwritten. The top-level fixed `name:` is removed from `compose.yaml`. Named volumes remain ordinary non-external Compose volumes so the selected project name scopes them automatically.

`harness:doctor` reports the selected Compose project identity and whether it was derived or explicitly overridden.

## Safety and compatibility

The harness never automatically deletes volumes belonging to a prior fixed-name revision or another Compose project. Cleanup remains scoped to the current consumer's project name.

Two consumers can therefore coexist without sharing durable Docker state. If they run concurrently on one host, the operator must additionally choose non-conflicting published host ports with the existing `AGENT_HARNESS_*_PORT` settings.

Any change to the consuming project's canonical filesystem location intentionally produces a new default Compose namespace. Operators that require durable identity across a repository move must set a valid explicit `AGENT_HARNESS_COMPOSE_PROJECT_NAME`.
