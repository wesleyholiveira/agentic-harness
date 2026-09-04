# ADR 0008 — Runtime invocation provenance follows the effective Context Engine authority

## Status

Accepted.

## Context

The standalone qualification can allocate a dedicated host port for Context Engine. OpenCode MCP traffic already follows `AGENT_HARNESS_CONTEXT_ENGINE_MCP_URL`, but the provenance plugin previously posted to a separate implicit `127.0.0.1:8789` endpoint. With another Context Engine already bound there, the first live `agent_start` could register against the wrong runtime and receive HTTP 409 because the expected plugin source SHA belonged to a different harness revision.

The Context Engine also validates the exact plugin source SHA, so the image performing that validation must contain the same plugin source that the host OpenCode process loads.

## Decision

1. The OpenCode launcher derives `AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_URL` from the effective `context-engine` MCP URL unless an explicit provenance URL is supplied.
2. The provenance plugin uses the explicit provenance URL first, otherwise derives `/runtime-invocation-provenance` from `AGENT_HARNESS_CONTEXT_ENGINE_MCP_URL`, and only falls back to `127.0.0.1:8789` when neither authority is configured.
3. `CONTEXT_ENGINE_HTTP_PORT` is not a host-side provenance routing authority. It is an internal Context Engine listener concern.
4. The public harness launcher computes the SHA-256 of the exact provenance plugin in the active harness/submodule and projects it as `AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_PLUGIN_SHA256` to both the OpenCode host and the consumer-scoped Context Engine stack.
5. The OpenCode plugin fails at load time if its self-hash differs from the launcher-projected hash.
6. The Context Engine image still packages the plugin source, but readiness verifies that the packaged self-hash equals the launcher-projected hash. A bundle mismatch is a typed readiness failure, not a registration-time ambiguity.
7. Runtime provenance registration is accepted only when the registering plugin self-hash equals the same projected expected hash. HTTP 409 remains fail-closed for a genuinely different loaded plugin.
8. Context Engine exposes `/runtime-invocation-provenance/identity` and the same identity in `/healthz`, allowing R-6 to prove expected/configured/bundled SHA parity before the first live `agent_start`.
9. A qualification using a dedicated Context Engine port must prove the first live provenance registration reaches that same endpoint; a 409 from another Context Engine is a routing failure, not an acceptable retry target.

## Consequences

OpenCode MCP calls and provenance registration share one runtime authority, while plugin identity has one explicit cross-process authority projected from the active harness source. Dedicated qualification ports cannot silently contact a preexisting service on 8789, stale/wrong OpenCode plugins fail before tool execution, and a stale Context Engine image fails readiness before R-7 instead of surfacing as an opaque first-call 409.
