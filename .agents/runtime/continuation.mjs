import { sha256 } from "./utils.mjs";
import {
  buildOpenCodeSessionMessageId,
  createDefaultSessionAdapterRegistry,
  normalizeSessionTarget,
} from "./session-adapter.mjs";

export const AGENT_CONTINUATION_SCHEMA_VERSION = "agent-continuation/v2";
export const AGENT_CONTINUATION_DELIVERY_SCHEMA_VERSION = "agent-continuation-delivery/v1";
export const CONTINUATION_WAKE_EVENTS = Object.freeze([
  "run.completed",
  "run.failed",
  "run.blocked",
  "run.cancelled",
]);

const RUN_STATUS_EVENT = Object.freeze({
  closed: "run.completed",
  failed: "run.failed",
  blocked: "run.blocked",
  cancelled: "run.cancelled",
});

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]));
  }
  return value;
}

export function normalizeContinuationWakeEvents(value) {
  const requested = Array.isArray(value) && value.length > 0 ? value : CONTINUATION_WAKE_EVENTS;
  const normalized = [...new Set(requested.map((item) => String(item).trim()).filter(Boolean))];
  const invalid = normalized.filter((item) => !CONTINUATION_WAKE_EVENTS.includes(item));
  if (invalid.length > 0) throw new Error(`agent_continuation_wake_event_invalid:${invalid.join(",")}`);
  return normalized;
}

export function runStatusToContinuationEvent(status) {
  return RUN_STATUS_EVENT[String(status ?? "").trim()] ?? null;
}

export function buildContinuationEffectKey({ continuationId, runId, terminalOccurrenceKey, eventType }) {
  const identity = {
    schemaVersion: AGENT_CONTINUATION_DELIVERY_SCHEMA_VERSION,
    continuationId: String(continuationId),
    runId: String(runId),
    terminalOccurrenceKey: String(terminalOccurrenceKey),
    eventType: String(eventType),
  };
  return `sha256:${sha256(Buffer.from(JSON.stringify(canonicalJsonValue(identity))))}`;
}

/** Compatibility wrapper retained for existing Runtime consumers. */
export function buildOpenCodeContinuationMessageId({ effectKey, createdAt }) {
  return buildOpenCodeSessionMessageId({ effectKey, createdAt });
}

export function buildContinuationPrompt({ runId, eventType, effectKey, generation }) {
  return [
    "Agentic Harness Runtime V2 continuation event.",
    "",
    `runId: ${runId}`,
    `event: ${eventType}`,
    `continuationGeneration: ${generation}`,
    `clip-continuation-effect: ${effectKey}`,
    "",
    "The authoritative Runtime V2 state changed while this session was parked.",
    `Call context-engine agent_summary exactly once with runId ${runId}, then continue the original user conversation from that authoritative state.`,
    "If this run is terminal, give the user the final outcome for the original request and end this resumed assistant turn. Do not re-enter delivery for the same completed request.",
    "Do not call agent_start again for this same run/request. A distinct follow-up Runtime run is allowed only when the original user request explicitly requires a separate subsequent delivery operation.",
    "Call context_efficiency with this runId only when the original user request explicitly requires run-scoped performance/token evidence.",
    "Do not call agent_wait, agent_status, or agent_progress merely to rediscover this already-delivered terminal event.",
    "External qualification, fault injection, promotion gates, and harness verdicts are owned by the host qualification controller, not by this resumed user-facing turn.",
  ].join("\n");
}

export function continuationPromptFingerprint(prompt) {
  return `sha256:${sha256(Buffer.from(String(prompt)))}`;
}

export function normalizeContinuationRegistration(input, environment = process.env) {
  if (!input) return null;
  const adapterId = String(input.adapterId ?? input.adapter_id ?? "opencode").trim();
  if (!adapterId) throw new Error("agent_continuation_session_adapter_id_required");
  const configuredUrl = input.serverUrl
    ?? input.server_url
    ?? input.opencodeServerUrl
    ?? input.opencode_server_url
    ?? environment.AGENT_HARNESS_AGENT_SESSION_URL
    ?? (adapterId === "opencode" ? environment.AGENT_HARNESS_OPENCODE_CONTINUATION_URL : null);
  const target = normalizeSessionTarget({
    ...input,
    adapterId,
    sessionId: input.sessionId ?? input.session_id ?? input.opencodeSessionId ?? input.opencode_session_id,
    serverUrl: configuredUrl,
    directory: input.directory ?? input.worktree ?? input.opencodeDirectory ?? input.opencode_directory,
  });
  return {
    schemaVersion: AGENT_CONTINUATION_SCHEMA_VERSION,
    adapterId: target.adapterId,
    sessionId: target.sessionId,
    serverUrl: target.serverUrl,
    directory: target.directory,
    wakeOn: normalizeContinuationWakeEvents(input.wakeOn),
  };
}


export async function verifyContinuationTarget(
  registration,
  environment = process.env,
  { fetchImpl = globalThis.fetch, adapters = null } = {},
) {
  if (!registration) return null;
  const target = normalizeSessionTarget({ ...registration, adapterId: registration.adapterId ?? "opencode" });
  const registry = adapters ?? createDefaultSessionAdapterRegistry({ environment, fetchImpl });
  try {
    const result = await registry.resolve(target.adapterId).verifyTarget(target);
    if (target.adapterId === "opencode") {
      const identity = result?.promptIdentity;
      if (!identity?.agentId || !identity?.providerId || !identity?.modelId) {
        throw new Error(`agent_continuation_target_prompt_identity_missing:${target.sessionId}`);
      }
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (target.adapterId === "opencode") {
      const mappings = [
        ["agent_session_target_not_found:", "agent_continuation_target_session_not_found:"],
        ["agent_session_target_identity_mismatch:", "agent_continuation_target_session_identity_mismatch:"],
        ["agent_session_server_health_http:", "agent_continuation_server_health_http:"],
        ["agent_session_target_http:", "agent_continuation_target_session_http:"],
      ];
      for (const [from, to] of mappings) {
        if (message.includes(from)) {
          const translated = new Error(message.replace(from, to));
          translated.code = message.slice(message.indexOf(from)).split(":")[0].replace("agent_session", "agent_continuation");
          translated.cause = error;
          throw translated;
        }
      }
    }
    throw error;
  }
}
