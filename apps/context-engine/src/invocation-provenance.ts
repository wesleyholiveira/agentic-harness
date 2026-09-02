import { createHash } from "node:crypto";

export type InvocationOrigin =
  | "explicit-human-turn"
  | "autonomous-assistant"
  | "durable-continuation"
  | "qualification-harness"
  | "unknown";

export interface InvocationProvenanceRegistration {
  agentId: string;
  toolName: string;
  argsDigest: string;
  origin: Exclude<InvocationOrigin, "unknown">;
  sessionId: string | null;
  callId: string | null;
  userMessageId: string | null;
  pluginSourceSha256?: string | null;
  historySource?: string | null;
  historyErrorCode?: string | null;
  observedAt: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10_000;
const MAX_REGISTRATIONS = 256;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stableValue(nested)]));
}

export function invocationArgsDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value ?? {}))).digest("hex")}`;
}

export function normalizeInvocationToolName(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return raw
    .replace(/^context-engine[_:.]/i, "")
    .replace(/^context_engine[_:.]/i, "")
    .trim() || null;
}

export function mcpToolCallIdentity(body: unknown): { toolName: string; argsDigest: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (record.method !== "tools/call") return null;
  const params = record.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const paramsRecord = params as Record<string, unknown>;
  const toolName = normalizeInvocationToolName(paramsRecord.name);
  if (!toolName) return null;
  return { toolName, argsDigest: invocationArgsDigest(paramsRecord.arguments ?? {}) };
}

export class InvocationProvenanceRegistry {
  private registrations: InvocationProvenanceRegistration[] = [];

  register(input: Omit<InvocationProvenanceRegistration, "expiresAt">, ttlMs = DEFAULT_TTL_MS): InvocationProvenanceRegistration {
    const now = Date.now();
    this.prune(now);
    const registration: InvocationProvenanceRegistration = {
      ...input,
      expiresAt: now + Math.max(1_000, Math.min(60_000, Math.trunc(ttlMs))),
    };
    this.registrations.push(registration);
    if (this.registrations.length > MAX_REGISTRATIONS) {
      this.registrations.splice(0, this.registrations.length - MAX_REGISTRATIONS);
    }
    return registration;
  }

  consume({ agentId, toolName, argsDigest }: { agentId: string | null; toolName: string; argsDigest: string }): InvocationProvenanceRegistration | null {
    const now = Date.now();
    this.prune(now);
    const normalizedAgentId = String(agentId ?? "").trim();
    for (let index = this.registrations.length - 1; index >= 0; index -= 1) {
      const candidate = this.registrations[index];
      if (!candidate) continue;
      if (candidate.agentId !== normalizedAgentId || candidate.toolName !== toolName || candidate.argsDigest !== argsDigest) continue;
      this.registrations.splice(index, 1);
      return candidate;
    }
    return null;
  }

  private prune(now = Date.now()): void {
    this.registrations = this.registrations.filter((entry) => entry.expiresAt > now);
  }
}
