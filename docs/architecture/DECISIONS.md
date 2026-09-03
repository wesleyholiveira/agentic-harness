# Current architecture decisions

- Dynamic DAG: implementation dependencies are compiled at runtime from `implementationPlan`.
- Distributed agent catalog: `.agents/agents/<id>/agent.json`; no monolithic registry.
- PostgreSQL: run/task/checkpoint/project-memory/continuation authority.
- RabbitMQ: at-least-once command/wakeup transport.
- Rust worker: physical execution and durable continuation delivery.
- Context Engine: semantic planning/context/finalization and cache integration.
- Redis: exact/semantic context cache.
- TEI: optional embeddings for semantic context reuse.
- OpenCode: interactive orchestrator and isolated specialist execution.

- Consumer-scoped Compose identity: Docker containers, networks and named volumes are namespaced by a deterministic hash of the canonical consuming-project root; only `AGENT_HARNESS_COMPOSE_PROJECT_NAME` may explicitly override it.
