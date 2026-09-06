# ADR 0013: Agent Start Provenance Must Fail Closed

## Status
Accepted

## Context

Standalone qualification reached R-7 with a materialized Runtime run and durable continuation, then reported `r7_provenance_registration_not_proven` because the gate searched Context Engine logs for `mcp.invocation_provenance_registered`. Structured logging is disabled by default (`AGENT_RUNTIME_LOG_LEVEL=off`), so the gate depended on optional observability rather than the ingress security contract itself.

The OpenCode provenance plugin already registers provenance synchronously in `tool.execute.before` and aborts the tool call if registration fails. Context Engine consumes that registration into the request context before dispatching the MCP tool. However, `agent_start` did not itself require the consumed provenance, so a successful run was not formally sufficient evidence.

## Decision

For HTTP calls from `main-orchestrator`, `agent_start` requires:

- `invocationProvenanceSource = opencode-plugin-sidechannel`;
- a non-empty invocation session id;
- a non-empty invocation user message id.

Missing provenance fails before `control.start()` and before run materialization. Non-HTTP/operator control flows remain unchanged.

Standalone R-7 no longer uses log text as provenance authority. A materialized run reached through the fail-closed `agent_start` boundary is the structured proof that the sidechannel provenance was accepted and consumed. Logs remain diagnostic only.

## Consequences

- Qualification does not require INFO logging.
- Main Orchestrator Runtime ingress is stricter in production, not only in tests.
- A run can no longer be created by HTTP Main Orchestrator ingress with missing provenance context.
- R-7 evidence becomes independent of log formatting, retention, and log level.
