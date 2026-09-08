# ADR 0032 — Execution-plane doctor authority

## Status
Accepted for the next standalone qualification candidate.

## Context
`agent_doctor` runs in the Context Engine container, while productive specialist execution occurs in the Rust `agent-runtime-worker`. The previous doctor inferred Git, OpenCode, auth and model availability by probing its own Context Engine filesystem/process namespace. That produced false negatives even when the worker had Git, OpenCode, a mounted auth file and the required OpenAI model catalog. The doctor also honored a host-only loopback continuation probe URL from inside the container, where `127.0.0.1` identifies the Context Engine itself.

## Decision
1. The Rust worker probes Git, OpenCode version, OpenCode auth presence/OpenAI provider presence, and the OpenAI model catalog once per worker lifecycle.
2. Those results are published in the authoritative PostgreSQL worker heartbeat `metadata_json` under `capabilities`.
3. `agent_doctor` derives execution readiness from the freshest healthy Rust-worker heartbeat metadata. Context Engine-local Git/OpenCode/auth probes are not readiness authority.
4. A missing capability payload is an explicit `execution_plane_capabilities_unavailable` failure until the worker is recreated on the new source.
5. Container-side continuation readiness probes the configured delivery URL (normally `host.docker.internal:<port>`). Host-only loopback probe overrides remain valid only for host-side controllers.
6. The Context Engine Compose service no longer receives `AGENT_HARNESS_OPENCODE_CONTINUATION_HOST_PROBE_URL`.
7. No credentials or secret values are stored in heartbeat metadata; only booleans, versions, the auth path, model IDs and bounded probe errors are exposed.

## Consequences
Doctor output now reflects the actual execution plane and no longer reports false `git_unavailable`, `opencode_unavailable`, auth/model failures, or continuation reachability failures solely because it inspected the wrong network/filesystem namespace.
