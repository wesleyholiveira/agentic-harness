const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 } as const;
type LogLevel = keyof typeof LEVELS;
const REDACTED_KEY = /(authorization|password|secret|api[_-]?key|access[_-]?token|auth[_-]?token|bearer|prompt|content|context[_-]?packet|request[_-]?body)/i;

function configuredLevel(): number {
  const raw = String(process.env.AGENT_RUNTIME_LOG_LEVEL ?? process.env.LOG_LEVEL ?? "off").trim().toLowerCase();
  if (raw === "off") return -1;
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

function sanitize(value: unknown, depth = 0, key = ""): unknown {
  if (REDACTED_KEY.test(key)) return "[redacted]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 512 ? `${value.slice(0, 509)}...` : value;
  if (Array.isArray(value)) return { count: value.length };
  if (typeof value !== "object") return String(value);
  if (depth >= 2) return "[object]";
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
    childKey,
    sanitize(childValue, depth + 1, childKey),
  ]));
}

export function contextEngineLog(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (configuredLevel() < LEVELS[level]) return;
  const sanitized = sanitize(fields) as Record<string, unknown>;
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    component: "context-engine",
    event,
    ...sanitized,
  })}\n`);
}

export function describeMcpRequest(body: unknown): { rpcMethod: string | null; toolName: string | null; requestId: string | number | null; runId: string | null; taskId: string | null } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { rpcMethod: null, toolName: null, requestId: null, runId: null, taskId: null };
  const record = body as Record<string, unknown>;
  const params = record.params && typeof record.params === "object" && !Array.isArray(record.params)
    ? record.params as Record<string, unknown>
    : null;
  const args = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : null;
  return {
    rpcMethod: typeof record.method === "string" ? record.method : null,
    toolName: typeof params?.name === "string" ? params.name : null,
    requestId: typeof record.id === "string" || typeof record.id === "number" ? record.id : null,
    runId: typeof args?.runId === "string" ? args.runId : null,
    taskId: typeof args?.taskId === "string" ? args.taskId : null,
  };
}
