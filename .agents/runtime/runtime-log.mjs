const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3, trace: 4 });
const REDACTED_KEY = /(authorization|password|secret|api[_-]?key|access[_-]?token|auth[_-]?token|bearer|prompt|content|context[_-]?packet|request[_-]?body)/i;

function configuredLevel() {
  const raw = String(process.env.AGENT_RUNTIME_LOG_LEVEL ?? "off").trim().toLowerCase();
  return raw === "off" ? -1 : (LEVELS[raw] ?? LEVELS.info);
}

function sanitize(value, depth = 0, key = "") {
  if (REDACTED_KEY.test(key)) return "[redacted]";
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 512 ? `${value.slice(0, 509)}...` : value;
  if (Array.isArray(value)) return { count: value.length };
  if (typeof value !== "object") return String(value);
  if (depth >= 2) return "[object]";
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = sanitize(childValue, depth + 1, childKey);
  }
  return output;
}

export function sanitizeRuntimeLogFields(fields = {}) {
  return sanitize(fields);
}

export function runtimeLog(level, event, fields = {}, component = "agent-runtime.semantic") {
  const normalized = String(level).toLowerCase();
  const rank = LEVELS[normalized] ?? LEVELS.info;
  if (configuredLevel() < rank) return;
  const payload = {
    timestamp: new Date().toISOString(),
    level: normalized,
    component,
    event,
    ...sanitize(fields),
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

export function persistedEventLogLevel(type) {
  const value = String(type ?? "");
  if (/heartbeat/i.test(value)) return "debug";
  if (/(failed|rejected|orphaned|conflict)/i.test(value)) return "error";
  if (/(deferred|blocked|cancelled|degraded|retry)/i.test(value)) return "warn";
  return "info";
}
