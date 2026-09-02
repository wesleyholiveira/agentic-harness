import { sha256 } from "./utils.mjs";

function compact(value) {
  return String(value ?? "").trim();
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const OPEN_CODE_ID_MASK = (1n << 48n) - 1n;

function deterministicBase62(hex, length) {
  let value = BigInt(`0x${hex}`);
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output = BASE62[Number(value % 62n)] + output;
    value /= 62n;
  }
  return output.padStart(length, "0").slice(-length);
}

/**
 * OpenCode validates only the msg_ prefix, but its prompt loop historically
 * assumes IDs preserve the same timestamp ordering as MessageID.ascending().
 * Keep that provider-specific identity rule inside the OpenCode adapter.
 */
export function buildOpenCodeSessionMessageId({ effectKey, createdAt }) {
  const digest = sha256(Buffer.from(String(effectKey)));
  const timestamp = Date.parse(String(createdAt ?? ""));
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error("agent_continuation_created_at_invalid");
  }
  const safeTimestamp = Math.trunc(timestamp);
  const counter = (Number.parseInt(digest.slice(0, 3), 16) % 0xfff) + 1;
  const encoded = (BigInt(safeTimestamp) * 0x1000n + BigInt(counter)) & OPEN_CODE_ID_MASK;
  const timeHex = encoded.toString(16).padStart(12, "0");
  const entropy = deterministicBase62(digest.slice(3), 14);
  return `msg_${timeHex}${entropy}`;
}


function messageText(item) {
  return Array.isArray(item?.parts)
    ? item.parts
        .filter((part) => part?.type === "text")
        .map((part) => String(part?.text ?? part?.content ?? ""))
        .join("\n")
    : "";
}

function promptIdentityFromInfo(info, sourceMessageId = null) {
  const agentId = compact(info?.agent);
  const providerId = compact(info?.model?.providerID ?? info?.model?.providerId);
  const modelId = compact(info?.model?.modelID ?? info?.model?.modelId ?? info?.model?.id);
  const variant = compact(info?.model?.variant) || null;
  if (!agentId || !providerId || !modelId) return null;
  return {
    agentId,
    providerId,
    modelId,
    variant,
    sourceMessageId: compact(sourceMessageId) || null,
  };
}

function promptIdentityFromMessages(value) {
  if (!Array.isArray(value)) return null;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const item = value[index];
    const info = item?.info ?? item;
    if (info?.role !== "user") continue;
    const text = messageText(item);
    if (text.includes("clip-continuation-effect:") || text.includes("Agentic Harness Runtime V2 continuation event.")) continue;
    const identity = promptIdentityFromInfo(info, info?.id ?? item?.id ?? null);
    if (identity) return identity;
  }
  return null;
}

function normalizeServerUrl(value) {
  const raw = compact(value).replace(/\/+$/, "");
  if (!raw) throw new Error("agent_session_server_url_required");
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new Error("agent_session_server_url_invalid"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("agent_session_server_protocol_invalid");
  if (parsed.username || parsed.password) throw new Error("agent_session_credentials_must_not_be_embedded_in_url");
  return raw;
}

export function normalizeSessionTarget(input) {
  if (!input || typeof input !== "object") throw new Error("agent_session_target_required");
  const adapterId = compact(input.adapterId ?? input.adapter_id ?? (input.opencode_session_id || input.opencodeSessionId ? "opencode" : "opencode"));
  const sessionId = compact(input.sessionId ?? input.session_id ?? input.opencode_session_id ?? input.opencodeSessionId);
  if (!adapterId) throw new Error("agent_session_adapter_id_required");
  if (!sessionId || sessionId.length > 160) throw new Error("agent_session_id_invalid");
  const serverUrl = normalizeServerUrl(input.serverUrl ?? input.server_url ?? input.opencode_server_url ?? input.opencodeServerUrl);
  const directory = compact(input.directory ?? input.worktree ?? input.opencode_directory ?? input.opencodeDirectory) || null;
  return { adapterId, sessionId, serverUrl, directory };
}

function authHeaders(environment = process.env) {
  const username = compact(
    environment.AGENT_HARNESS_OPENCODE_CONTINUATION_USERNAME
      ?? environment.AGENT_HARNESS_AGENT_PROGRESS_USERNAME,
  );
  const password = String(
    environment.AGENT_HARNESS_OPENCODE_CONTINUATION_PASSWORD
      ?? environment.AGENT_HARNESS_AGENT_PROGRESS_PASSWORD
      ?? "",
  );
  if (!username && !password) return {};
  if (!username || !password) throw new Error("agent_session_basic_auth_incomplete");
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

function endpoint(target, pathname) {
  const url = new URL(target.serverUrl);
  url.pathname = pathname;
  url.search = "";
  if (target.directory) url.searchParams.set("directory", target.directory);
  return url;
}

function providerModelIds(payload) {
  const result = new Set();
  const providers = payload?.all ?? payload?.providers ?? payload ?? {};
  for (const [providerKey, provider] of Object.entries(providers)) {
    const providerId = compact(provider?.id ?? providerKey);
    const models = provider?.models ?? {};
    for (const [modelKey, model] of Object.entries(models)) {
      const modelId = compact(model?.id ?? modelKey);
      if (providerId && modelId) result.add(`${providerId}/${modelId}`);
    }
  }
  return result;
}


async function responseErrorSuffix(response, maxChars = 1_500) {
  let detail = "";
  try {
    if (typeof response?.text === "function") detail = await response.text();
    else if (typeof response?.json === "function") detail = JSON.stringify(await response.json());
  } catch {}
  detail = String(detail ?? "").replace(/\s+/g, " ").trim();
  if (!detail) return "";
  // OpenCode database errors can append full message payloads after `params:`.
  // Preserve the query/error signature while keeping prompt/session content out
  // of Runtime logs. Also redact common credential-shaped fragments.
  detail = detail.replace(/\bparams\s*:[\s\S]*$/i, "params:[redacted]");
  detail = detail
    .replace(/(authorization|password|api[_-]?key|token)\s*[=:]\s*[^,;\s]+/gi, "$1=[redacted]")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]");
  if (detail.length > maxChars) detail = `${detail.slice(0, maxChars)}...[truncated]`;
  return `:body=${detail}`;
}

function responseRole(body) {
  return body?.info?.role ?? body?.role ?? body?.data?.info?.role ?? null;
}

export class AgentSessionAdapterRegistry {
  constructor({ adapters = [] } = {}) {
    this.adapters = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter) {
    const id = compact(adapter?.id);
    if (!id || typeof adapter !== "object") throw new Error("agent_session_adapter_invalid");
    if (this.adapters.has(id)) throw new Error(`agent_session_adapter_duplicate:${id}`);
    this.adapters.set(id, adapter);
    return this;
  }

  resolve(id) {
    const normalized = compact(id);
    const adapter = this.adapters.get(normalized);
    if (!adapter) throw new Error(`agent_session_adapter_unknown:${normalized || "missing"}`);
    return adapter;
  }

  buildMessageId(id, input) {
    const adapter = this.resolve(id);
    if (typeof adapter.buildMessageId !== "function") {
      throw new Error(`agent_session_adapter_message_identity_unsupported:${adapter.id}`);
    }
    return adapter.buildMessageId(input);
  }
}

export class OpenCodeSessionAdapter {
  constructor({ environment = process.env, fetchImpl = globalThis.fetch } = {}) {
    this.id = "opencode";
    this.environment = environment;
    this.fetchImpl = fetchImpl;
  }

  timeoutMs(value = null) {
    const raw = Number(value ?? this.environment.AGENT_HARNESS_OPENCODE_CONTINUATION_HTTP_TIMEOUT_MS ?? 10_000);
    return Number.isFinite(raw) ? Math.max(500, Math.min(120_000, Math.trunc(raw))) : 10_000;
  }

  buildMessageId(input) {
    return buildOpenCodeSessionMessageId(input);
  }

  async request(targetInput, pathname, options = {}, timeoutMs = null) {
    if (typeof this.fetchImpl !== "function") throw new Error("agent_session_fetch_unavailable");
    const target = normalizeSessionTarget(targetInput);
    const { query = null, ...fetchOptions } = options;
    const url = endpoint(target, pathname);
    if (query && typeof query === "object") {
      for (const [key, value] of Object.entries(query)) {
        if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const headers = {
      "content-type": "application/json",
      ...authHeaders(this.environment),
      ...(fetchOptions.headers ?? {}),
    };
    return await this.fetchImpl(url, {
      ...fetchOptions,
      headers,
      signal: fetchOptions.signal ?? AbortSignal.timeout(this.timeoutMs(timeoutMs)),
    });
  }

  async verifyTarget(targetInput) {
    const target = normalizeSessionTarget(targetInput);
    const started = Date.now();
    const health = await this.request(target, "/global/health", { method: "GET" });
    if (!health.ok) throw new Error(`agent_session_server_health_http:${health.status}`);
    let healthBody = null;
    try { healthBody = await health.json(); } catch {}
    const session = await this.request(target, `/session/${encodeURIComponent(target.sessionId)}`, { method: "GET" });
    if (session.status === 404) throw new Error(`agent_session_target_not_found:${target.sessionId}`);
    if (!session.ok) throw new Error(`agent_session_target_http:${session.status}`);
    let sessionBody = null;
    try { sessionBody = await session.json(); } catch {}
    const returnedId = sessionBody?.id ?? sessionBody?.sessionID ?? null;
    if (returnedId && returnedId !== target.sessionId) throw new Error(`agent_session_target_identity_mismatch:${target.sessionId}`);

    // R17.4.4: prompt_async must preserve the parked controller's explicit
    // agent/model identity. OpenCode currently falls back to its default agent
    // when injected prompts omit these fields, which can silently switch the
    // model or prevent the intended continuation turn. Resolve the latest real
    // user turn, excluding Runtime continuation wake messages, and snapshot it
    // before the run starts.
    let promptIdentity = null;
    const messages = await this.request(
      target,
      `/session/${encodeURIComponent(target.sessionId)}/message`,
      { method: "GET", query: { limit: 100 } },
    );
    if (messages.ok) {
      try { promptIdentity = promptIdentityFromMessages(await messages.json()); } catch {}
    }
    promptIdentity ??= promptIdentityFromInfo(sessionBody, null);

    return {
      ok: true,
      adapterId: this.id,
      verifiedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      serverHealthy: true,
      targetSessionVisible: true,
      sessionId: target.sessionId,
      endpoint: target.serverUrl,
      serverVersion: healthBody?.version ?? null,
      promptIdentity,
    };
  }

  async isIdle(targetInput) {
    const target = normalizeSessionTarget(targetInput);
    const response = await this.request(target, "/session/status", { method: "GET" });
    if (!response.ok) throw new Error(`agent_session_status_http:${response.status}`);
    const statuses = await response.json();
    const status = statuses?.[target.sessionId]?.type ?? "idle";
    return !["busy", "retry"].includes(status);
  }

  async availableModels(targetInput) {
    const target = normalizeSessionTarget(targetInput);
    const response = await this.request(target, "/provider", { method: "GET" });
    if (!response.ok) throw new Error(`agent_session_provider_catalog_http:${response.status}`);
    return providerModelIds(await response.json());
  }

  async createSession(targetInput, { title = "Runtime isolated session" } = {}) {
    const target = normalizeSessionTarget(targetInput);
    const response = await this.request(target, "/session", { method: "POST", body: JSON.stringify({ title }) });
    if (!response.ok) throw new Error(`agent_session_create_http:${response.status}`);
    const body = await response.json();
    const id = body?.id ?? body?.sessionID ?? null;
    if (!id) throw new Error("agent_session_create_id_missing");
    return id;
  }

  async deleteSession(targetInput, sessionId) {
    const target = normalizeSessionTarget(targetInput);
    const response = await this.request(target, `/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(`agent_session_delete_http:${response.status}`);
    return true;
  }

  async appendContext(targetInput, { messageId, text, system = null, parts = null }) {
    const target = normalizeSessionTarget(targetInput);
    const body = {
      ...(messageId ? { messageID: messageId } : {}),
      noReply: true,
      ...(system ? { system } : {}),
      parts: parts ?? [{ type: "text", text: String(text ?? "") }],
    };
    const response = await this.request(target, `/session/${encodeURIComponent(target.sessionId)}/message`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`agent_session_append_context_http:${response.status}${await responseErrorSuffix(response)}`);
    const raw = await response.json();
    return { role: responseRole(raw), raw };
  }

  async sendMessage(targetInput, { sessionId = null, body }) {
    const target = normalizeSessionTarget(targetInput);
    const selected = sessionId ?? target.sessionId;
    const response = await this.request(target, `/session/${encodeURIComponent(selected)}/message`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`agent_session_message_http:${response.status}${await responseErrorSuffix(response)}`);
    return await response.json();
  }

  async messageExists(targetInput, messageId) {
    const target = normalizeSessionTarget(targetInput);
    const response = await this.request(target, `/session/${encodeURIComponent(target.sessionId)}/message/${encodeURIComponent(messageId)}`, { method: "GET" });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`agent_session_message_lookup_http:${response.status}`);
    return true;
  }

  async listMessages(targetInput, sessionId = null) {
    const target = normalizeSessionTarget(targetInput);
    const selected = sessionId ?? target.sessionId;
    const response = await this.request(target, `/session/${encodeURIComponent(selected)}/message`, { method: "GET" });
    if (!response.ok) throw new Error(`agent_session_messages_http:${response.status}`);
    return await response.json();
  }

  async showToast(targetInput, payload) {
    const target = normalizeSessionTarget(targetInput);
    const response = await this.request(target, "/tui/show-toast", { method: "POST", body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`agent_session_tui_http:${response.status}`);
    let accepted = null;
    try { accepted = await response.json(); } catch {}
    if (accepted === false) throw new Error("agent_session_tui_not_attached");
    return { accepted: true };
  }
}

export function createDefaultSessionAdapterRegistry(options = {}) {
  return new AgentSessionAdapterRegistry().register(new OpenCodeSessionAdapter(options));
}

export function buildSessionMessageId(
  { adapterId = "opencode", effectKey, createdAt },
  { adapters = null } = {},
) {
  const registry = adapters ?? createDefaultSessionAdapterRegistry({ environment: {}, fetchImpl: null });
  return registry.buildMessageId(adapterId, { effectKey, createdAt });
}

// Compatibility factory used by Runtime core. Adapter construction remains in
// this module so the control plane does not import an OpenCode implementation.
export function defaultSessionAdapterRegistry(environment = process.env, { fetchImpl = globalThis.fetch } = {}) {
  return createDefaultSessionAdapterRegistry({ environment, fetchImpl });
}

export function sessionTargetFromContinuation(continuation) {
  return normalizeSessionTarget({
    adapterId: continuation?.session_adapter_id ?? continuation?.adapterId ?? "opencode",
    sessionId: continuation?.session_id ?? continuation?.opencode_session_id ?? continuation?.sessionId,
    serverUrl: continuation?.server_url ?? continuation?.opencode_server_url ?? continuation?.serverUrl,
    directory: continuation?.directory ?? continuation?.opencode_directory,
  });
}
