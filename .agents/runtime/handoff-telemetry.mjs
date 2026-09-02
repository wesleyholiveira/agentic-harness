const METRIC_KEYS = new Set(["inputTokens", "outputTokens", "cachedInputTokens", "contextBytes", "costUsd"]);
const EXECUTION_TELEMETRY_KEYS = new Set([
  "modelId", "variant", "reasoningEffort", "stepsLimit", "stepsUsed",
  "stepLimitReached", "stopReason", "attempt", "sessionId", "usageSource",
]);
const REASONING_EFFORTS = new Set(["low", "medium", "high", "max"]);
const USAGE_SOURCES = new Set(["session-export", "json-stream", "handoff", "unavailable"]);

function nonNegativeInteger(value) { return Number.isInteger(value) && value >= 0; }
function nonNegativeNumber(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function stringOrNull(value) { return value === null || typeof value === "string"; }

function metricValueIsValid(key, value) {
  if (["inputTokens", "outputTokens", "cachedInputTokens", "contextBytes"].includes(key)) return nonNegativeInteger(value);
  if (key === "costUsd") return nonNegativeNumber(value);
  return false;
}

function telemetryValueIsValid(key, value) {
  if (key === "modelId") return typeof value === "string" && value.length > 0;
  if (["variant", "stopReason", "sessionId"].includes(key)) return stringOrNull(value);
  if (key === "reasoningEffort") return REASONING_EFFORTS.has(value);
  if (key === "stepsLimit" || key === "attempt") return Number.isInteger(value) && value >= 1;
  if (key === "stepsUsed") return value === null || nonNegativeInteger(value);
  if (key === "stepLimitReached") return value === null || typeof value === "boolean";
  if (key === "usageSource") return USAGE_SOURCES.has(value);
  return false;
}

function sanitizeObject(value, allowed, valueIsValid) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value: value ?? undefined, removedKeys: [] };
  const removedKeys = [];
  const entries = [];
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key) || !valueIsValid(key, item)) {
      removedKeys.push(key);
      continue;
    }
    entries.push([key, item]);
  }
  return { value: Object.fromEntries(entries), removedKeys };
}

/**
 * Metrics and executionTelemetry are runtime-owned envelopes. The OpenCode
 * adapter strips model-authored telemetry before aggregation; this sanitizer is a
 * second boundary that removes unknown or schema-invalid runtime values before
 * persistence.
 */
export function sanitizeHandoffTelemetryShape(handoff) {
  const metrics = sanitizeObject(handoff?.metrics, METRIC_KEYS, metricValueIsValid);
  const telemetry = sanitizeObject(handoff?.executionTelemetry, EXECUTION_TELEMETRY_KEYS, telemetryValueIsValid);
  const next = { ...handoff };
  if (handoff && Object.hasOwn(handoff, "metrics")) next.metrics = metrics.value ?? {};
  if (handoff && Object.hasOwn(handoff, "executionTelemetry")) next.executionTelemetry = telemetry.value ?? {};
  return {
    handoff: next,
    removedMetricKeys: metrics.removedKeys,
    removedExecutionTelemetryKeys: telemetry.removedKeys,
  };
}
