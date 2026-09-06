# ADR 0016 — Task Brief SDD workflow-skill schema parity

## Status

Accepted.

## Context

A live standalone qualification reached R-7 after dual-root Agent Input schema resolution had been corrected. Runtime preparation still failed before dispatch. The progress-aware watchdog persisted the repeated reconcile error:

`schema_validation_failed:taskBrief:taskBrief.sdd.workflowSkill: expected const "agent-harness-sdd-workflow"`

`buildTaskBrief()` emitted `agentic-harness-sdd-workflow`, while `task-brief.schema.json` defined `agent-harness-sdd-workflow` as the exact contract value. Because Task Briefs are validated before dispatch, Product Discovery remained `routed` at attempt zero and the Runtime repair sweep retried the same invalid preparation.

## Decision

The Task Brief schema remains authoritative for the serialized SDD workflow marker. `buildTaskBrief()` MUST emit exactly the schema constant `agent-harness-sdd-workflow`.

A contract test reads both the schema constant and the builder source and requires exact parity. The obsolete `agentic-harness-sdd-workflow` literal is forbidden in the builder.

## Consequences

- Task Brief preparation can pass schema validation and proceed to dispatch.
- No schema version or Runtime topology semantics change.
- No compatibility alias is introduced for the invalid value.
- Future renames must update schema and builder together and remain contract-covered.
