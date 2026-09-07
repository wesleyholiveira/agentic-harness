# ADR 0023 — Line-safe Durable Continuation observation and OpenCode multi-assistant parity

Status: accepted for standalone v1.0.0 qualification remediation

Date: 2026-09-06

## Context

After ADR 0022, a fresh target-host qualification again passed R-7 end to end. R-8 then remained live until the progress-aware safety ceiling and reported a contradictory snapshot:

- `delivery=missing` while a delivery id/effect key/message id were present;
- `attempts=NaN`;
- `acceptedAt=null` / `observedAt=null`;
- `currentDeliveryId=null`;
- `wakeCount=0` but `sameMessageIdCount=1`;
- OpenCode session `idle`;
- a completed assistant child existed, with seven assistant records parented by the deterministic wake id.

The durable database schema makes `status`, `generation`, `attempts`, `created_at` and other fields non-null for a materialized delivery. The malformed projection was therefore produced by qualification observation, not by a valid PostgreSQL row shape.

## Root cause A — newline-unsafe SQL row framing

`continuationObservation()` queried `prompt_text` using the generic `sqlRows()` helper. `sqlRows()` invokes `psql` in tab-delimited unaligned mode and then splits stdout by newline before splitting columns by tab.

Durable continuation prompts are intentionally multiline. `buildContinuationPrompt()` begins with `Agentic Harness Runtime V2 continuation event.` and then contains blank lines plus run/effect instructions.

The first embedded newline in `prompt_text` therefore terminated the JavaScript parser's apparent row. The observer kept only:

1. `delivery_id`
2. `effect_key`
3. `opencode_message_id`
4. the first line of `prompt_text`

Every following selected column became `undefined` in JavaScript. This explains the exact target-host symptom: missing status, `NaN` attempts, null timestamps and a wake text comparison against only the first prompt line.

## Decision A — JSON-framed database observation

Continuation observation no longer uses delimiter/newline framing for free-text database fields.

PostgreSQL now returns one `json_build_object(... )::text` scalar containing both:

- the complete delivery row projection; and
- the parent continuation projection.

JSON serialization escapes embedded newlines in `prompt_text`, so `sqlScalar()` receives one parseable logical record and `JSON.parse()` restores the exact multiline prompt.

A delivery-shaped observation missing schema-required identity/status/time/numeric fields is classified immediately as `QUALIFICATION PROCEDURE / continuation_observation_shape_invalid` instead of waiting to a safety ceiling.

## Root cause B — invalid single-assistant cardinality assumption

ADR 0022 originally stated that R-8 should require one completed assistant child.

That does not match the Rust authority. `continuation_turn_state_from_messages()`:

1. selects all OpenCode assistant records whose `parentID` equals the deterministic wake message id;
2. sorts them by creation time;
3. uses the latest child as the continuation terminal authority.

A multi-step OpenCode turn may therefore produce several assistant records for one user wake, especially when tools are called. Seven assistant records do not imply seven continuation wakes.

## Decision B — mirror Runtime latest-child semantics

Qualification now mirrors the Rust rule exactly:

- exactly one deterministic **user wake message id/text** remains required;
- one or more assistant records may be parented by that wake;
- the latest parented assistant record must be terminal and non-error;
- the single `continuation.delivered` event must persist the same `assistantMessageId` selected by the observer;
- the delivered event must also match delivery id, effect key, OpenCode wake message id and generation.

Assistant record count remains diagnostic telemetry only.

## Fail-closed boundaries

This ADR does not weaken Durable Continuation semantics.

R-8 still fails when:

- the deterministic user wake is absent or duplicated;
- the database delivery is malformed after JSON framing;
- `acceptedAt` or `observedAt` is missing after Runtime reaches observed terminal state;
- `observedAt < acceptedAt`;
- parent continuation status/current delivery identity diverges;
- latest assistant child is pending or failed after the Runtime completion deadline;
- `continuation.delivered` is absent, duplicated, or names a different wake/delivery/assistant identity;
- Runtime persists `dead`, `ambiguous`, `manual_review` or `cancelled`.

## Consequences

The qualification controller can now distinguish real Runtime delivery faults from observer corruption. Multiline continuation prompts are lossless, and legitimate multi-step OpenCode turns no longer fail an artificial one-assistant-cardinality rule.

No Rust Runtime behavior is changed by this ADR.
## Follow-up

A fresh live run after this ADR produced a coherent observer snapshot and exposed a Runtime terminality defect rather than another observation defect: PostgreSQL was already `observed` while the latest assistant child remained pending. ADR 0024 records the causal Runtime remediation for OpenCode `finish=tool-calls` steps.

