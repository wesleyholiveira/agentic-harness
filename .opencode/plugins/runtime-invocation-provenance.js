import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "agentic-harness.runtime-invocation-provenance";
const TERMINAL_PREFIX = "Agentic Harness Runtime V2 continuation event.";
const PROGRESS_SYSTEM_MARKER = "CLIP_RUNTIME_PROGRESS_LIVE_V1";
const DEFAULT_PROVENANCE_URL = `http://127.0.0.1:${String(process.env.CONTEXT_ENGINE_HTTP_PORT ?? "8789").trim() || "8789"}/runtime-invocation-provenance`;
const PARK_TRIGGER = "session-resume-event";
const HOST_REQUEST_TIMEOUT_MS = 5_000;
const GRACEFUL_PARK_SENTINEL = "PARKED_FOR_H9R_CONTINUATION";
const LIVE_IDENTITY_SCHEMA = "runtime-invocation-provenance-live/v1";
const LIVE_IDENTITY_RELATIVE_PATH = ".runtime/agents/runtime-invocation-provenance-live.json";
const PLUGIN_SOURCE_PATH = fileURLToPath(import.meta.url);
const PLUGIN_SOURCE_SHA256 = `sha256:${createHash("sha256").update(readFileSync(PLUGIN_SOURCE_PATH)).digest("hex")}`;

function canonicalFsPath(value) {
  const input = resolve(String(value ?? "").trim());
  const canonical = typeof realpathSync.native === "function"
    ? realpathSync.native(input)
    : realpathSync(input);
  return canonical;
}

function fsPathIdentity(value) {
  try {
    const canonical = canonicalFsPath(value);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch {
    return null;
  }
}

const PROVENANCE_TOOLS = new Set([
  "agent_start",
  "context_efficiency",
  "agent_status",
  "agent_progress",
  "agent_continuation_status",
  "agent_wait",
  "agent_get_dag",
  "agent_summary",
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, stableValue(nested)]));
}

function normalizeToolName(value) {
  const raw = String(value ?? "").trim();
  return raw.replace(/^context-engine[_:.]/i, "").replace(/^context_engine[_:.]/i, "").trim();
}

function boundedText(value, max = 4096) {
  const text = String(value ?? "").trim();
  return text && text.length <= max ? text : "";
}

function messageText(message) {
  return (message?.parts ?? []).filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
}

function messageId(message) {
  return String(message?.info?.id ?? "").trim() || null;
}

function isProgressMessage(message) {
  return String(message?.info?.system ?? "").includes(PROGRESS_SYSTEM_MARKER);
}

function isTerminalContinuationMessage(message) {
  return messageText(message).startsWith(TERMINAL_PREFIX);
}

function hostAuthHeaders(environment = process.env) {
  const configuredUsername = boundedText(
    environment.AGENT_HARNESS_OPENCODE_CONTINUATION_USERNAME
      ?? environment.AGENT_HARNESS_AGENT_PROGRESS_USERNAME
      ?? environment.OPENCODE_SERVER_USERNAME,
    256,
  );
  const password = String(
    environment.AGENT_HARNESS_OPENCODE_CONTINUATION_PASSWORD
      ?? environment.AGENT_HARNESS_AGENT_PROGRESS_PASSWORD
      ?? environment.OPENCODE_SERVER_PASSWORD
      ?? "",
  );
  if (!password) return {};
  // OpenCode ServerAuth defaults the username to "opencode" when only
  // OPENCODE_SERVER_PASSWORD is configured. Mirror that exact contract so
  // password-only persistent hosts do not silently downgrade history reads
  // into unauthenticated HTTP 401 responses.
  const username = configuredUsername || "opencode";
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

function hostSessionUrl(serverUrl, sessionID, suffix, directory) {
  const base = serverUrl instanceof URL ? serverUrl : new URL(String(serverUrl));
  const endpoint = new URL(`/session/${encodeURIComponent(sessionID)}${suffix}`, base);
  if (directory) endpoint.searchParams.set("directory", directory);
  return endpoint;
}

async function hostFetch(url, init = {}, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("opencode_host_fetch_unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOST_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetchImpl(url, {
      ...init,
      headers: { ...hostAuthHeaders(), ...(init.headers ?? {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function userMessageCreatedAt(message) {
  const value = Number(message?.info?.time?.created);
  return Number.isFinite(value) ? value : null;
}

function newestUserMessage(messages) {
  const users = messages.filter((message) => message?.info?.role === "user");
  if (users.length <= 1) return users[0] ?? null;
  const withTime = users.filter((message) => userMessageCreatedAt(message) !== null);
  if (withTime.length === users.length) {
    return withTime.reduce((latest, candidate) => {
      const latestTime = userMessageCreatedAt(latest);
      const candidateTime = userMessageCreatedAt(candidate);
      if (candidateTime > latestTime) return candidate;
      if (candidateTime < latestTime) return latest;
      return String(messageId(candidate) ?? "").localeCompare(String(messageId(latest) ?? "")) > 0 ? candidate : latest;
    });
  }
  // OpenCode 1.18.25 pages the newest N rows but returns each page in chronological
  // order after MessageV2.page() reverses its DESC query result. If legacy rows omit
  // time.created, the last user entry is therefore the newest user in that page.
  return users.at(-1) ?? null;
}

function normalizeMessagesPayload(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

async function directHttpLatestUserMessage({ serverUrl, directory, sessionID, fetchImpl = globalThis.fetch }) {
  let before = null;
  for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
    const endpoint = hostSessionUrl(serverUrl, sessionID, "/message", directory);
    endpoint.searchParams.set("limit", "100");
    if (before) endpoint.searchParams.set("before", before);
    const response = await hostFetch(endpoint, { method: "GET" }, fetchImpl);
    if (!response.ok) throw new Error(`opencode_session_messages_http:${response.status}`);
    const payload = await response.json();
    const messages = normalizeMessagesPayload(payload);
    const current = newestUserMessage(messages);
    if (current) return { message: current, source: "direct-http", errorCode: null };
    before = String(response.headers?.get?.("x-next-cursor") ?? "").trim() || null;
    if (!before) break;
  }
  return { message: null, source: "direct-http", errorCode: "opencode_session_messages_no_user_in_bounded_window" };
}

async function sdkLatestUserMessage({ client, sessionID }) {
  if (typeof client?.session?.messages !== "function") {
    throw new Error("opencode_session_messages_sdk_unavailable");
  }
  // @opencode-ai/sdk 1.18.26 is generated from the Hey API schema: the
  // session id is a path parameter and limit is a query parameter. The
  // plugin-provided client is already scoped to ctx.directory and carries
  // ServerAuth headers, so do not reconstruct either here.
  const response = await client.session.messages({
    path: { id: sessionID },
    query: { limit: 100 },
  });
  const messages = normalizeMessagesPayload(response);
  const message = newestUserMessage(messages);
  return {
    message,
    source: "sdk-client",
    errorCode: message ? null : "opencode_session_messages_no_user_in_sdk_window",
  };
}

async function latestUserMessage({ serverUrl, directory, sessionID, client, fetchImpl = globalThis.fetch }) {
  const errors = [];
  try {
    const direct = await directHttpLatestUserMessage({ serverUrl, directory, sessionID, fetchImpl });
    if (direct.message) return direct;
    errors.push(direct.errorCode);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const sdk = await sdkLatestUserMessage({ client, sessionID });
    if (sdk.message) return sdk;
    errors.push(sdk.errorCode);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    message: null,
    source: "unavailable",
    errorCode: errors.filter(Boolean).join("|").slice(0, 512) || "opencode_session_messages_unavailable",
  };
}

function writeLivePluginIdentity(directory) {
  // Runtime-child OpenCode executions are ephemeral specialists. They must not
  // overwrite the persistent host identity record used by continuation gates.
  if (process.env.AGENT_HARNESS_OPENCODE_RUNTIME_CHILD === "1") return null;

  const projectRoot = String(process.env.AGENT_HARNESS_PROJECT_ROOT ?? directory ?? "").trim();
  const harnessRoot = String(process.env.AGENT_HARNESS_ROOT ?? projectRoot).trim();
  if (!projectRoot || !harnessRoot) return null;
  try {
    const expectedPluginPath = resolve(harnessRoot, ".opencode/plugins/runtime-invocation-provenance.js");
    if (!existsSync(expectedPluginPath)) return null;
    if (fsPathIdentity(expectedPluginPath) !== fsPathIdentity(PLUGIN_SOURCE_PATH)) return null;
    const target = resolve(projectRoot, LIVE_IDENTITY_RELATIVE_PATH);
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    const loadedAt = new Date().toISOString();
    writeFileSync(temporary, `${JSON.stringify({
      schemaVersion: LIVE_IDENTITY_SCHEMA,
      pluginId: PLUGIN_ID,
      pluginSourceSha256: PLUGIN_SOURCE_SHA256,
      pluginPath: canonicalFsPath(PLUGIN_SOURCE_PATH),
      harnessRoot: canonicalFsPath(harnessRoot),
      repositoryRoot: canonicalFsPath(projectRoot),
      processId: process.pid,
      loadedAt,
    }, null, 2)}\n`, "utf8");
    renameSync(temporary, target);
    return target;
  } catch {
    return null;
  }
}

function outputText(output) {
  const direct = typeof output?.output === "string" ? output.output : "";
  if (direct) return direct;
  if (typeof output?.text === "string") return output.text;
  try { return JSON.stringify(output ?? {}); } catch { return ""; }
}

function resultRequestsPark(output) {
  const text = outputText(output);
  if (!text.includes(PARK_TRIGGER)) return false;
  try {
    const parsed = JSON.parse(text);
    return parsed?.next === PARK_TRIGGER || parsed?.content?.some?.((entry) => String(entry?.text ?? "").includes(`\"next\": \"${PARK_TRIGGER}\"`));
  } catch {
    return /["']?next["']?\s*[:=]\s*["']session-resume-event["']/.test(text) || text.includes(`\"next\": \"${PARK_TRIGGER}\"`);
  }
}

function parkRunId(output) {
  const text = outputText(output);
  try {
    const parsed = JSON.parse(text);
    const direct = String(parsed?.runId ?? parsed?.run_id ?? parsed?.content?.runId ?? parsed?.content?.run_id ?? "").trim();
    if (direct) return direct;
    const nestedText = Array.isArray(parsed?.content)
      ? parsed.content.map((entry) => String(entry?.text ?? "")).join("\n")
      : "";
    const match = nestedText.match(/run-[0-9a-f-]{8,}/i);
    return match?.[0] ?? null;
  } catch {
    return text.match(/run-[0-9a-f-]{8,}/i)?.[0] ?? null;
  }
}

function parkedToolError(toolName, parked) {
  const runId = String(parked?.runId ?? "pending").trim() || "pending";
  return new Error(`agent_runtime_main_orchestrator_graceful_park_tool_denied:${String(toolName ?? "tool")}:${runId}:${GRACEFUL_PARK_SENTINEL}`);
}

async function registerProvenance({ sessionID, callID, toolName, args, origin, userMessageId, historySource, historyErrorCode, fetchImpl = globalThis.fetch }) {
  const body = {
    agentId: "main-orchestrator",
    toolName,
    arguments: stableValue(args ?? {}),
    argsDigest: `sha256:${createHash("sha256").update(JSON.stringify(stableValue(args ?? {}))).digest("hex")}`,
    origin,
    sessionId: sessionID,
    callId: callID,
    userMessageId,
    pluginId: PLUGIN_ID,
    pluginSourceSha256: PLUGIN_SOURCE_SHA256,
    historySource: historySource ?? null,
    historyErrorCode: historyErrorCode ?? null,
  };
  const response = await fetchImpl(DEFAULT_PROVENANCE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`runtime_invocation_provenance_http:${response.status}`);
}

export const RuntimeInvocationProvenance = async ({ serverUrl, directory, client }) => {
  writeLivePluginIdentity(directory);
  const parkedSessions = new Map();
  const durableContinuationTurns = new Map();

  return {
    "tool.execute.before": async (input, output) => {
      const toolName = normalizeToolName(input?.tool);
      const sessionID = String(input?.sessionID ?? "").trim();
      if (!sessionID) return;

      const parked = parkedSessions.get(sessionID) ?? null;
      const rememberedContinuationUserMessageId = durableContinuationTurns.get(sessionID) ?? null;
      const history = parked || rememberedContinuationUserMessageId || PROVENANCE_TOOLS.has(toolName)
        ? await latestUserMessage({ serverUrl, directory, sessionID, client })
        : { message: null, source: "not-required", errorCode: null };
      const currentUserMessage = history.message;
      const currentUserMessageId = messageId(currentUserMessage);
      let origin = "explicit-human-turn";
      let denyParkedTool = false;

      if (parked) {
        const newerUserTurn = Boolean(currentUserMessageId && currentUserMessageId !== parked.baselineUserMessageId);
        if (newerUserTurn && currentUserMessage && isTerminalContinuationMessage(currentUserMessage)) {
          origin = "durable-continuation";
          parkedSessions.delete(sessionID);
          durableContinuationTurns.set(sessionID, currentUserMessageId);
        } else if (newerUserTurn && currentUserMessage && !isProgressMessage(currentUserMessage)) {
          // A genuinely new human turn regains control. Qualification policy may
          // still reject that intervention, but the plugin must never trap the user.
          origin = "explicit-human-turn";
          parkedSessions.delete(sessionID);
          durableContinuationTurns.delete(sessionID);
        } else {
          // A continuation message that is itself the parked baseline is still the
          // same H-9R assistant turn. Only a DIFFERENT newer user message releases
          // the fence; otherwise a tool immediately after the second agent_start
          // could incorrectly unpark itself.
          origin = "autonomous-assistant";
          denyParkedTool = true;
        }
      } else if (currentUserMessage && isTerminalContinuationMessage(currentUserMessage)) {
        origin = "durable-continuation";
        if (currentUserMessageId) durableContinuationTurns.set(sessionID, currentUserMessageId);
      } else if (rememberedContinuationUserMessageId && currentUserMessageId === rememberedContinuationUserMessageId) {
        origin = "durable-continuation";
      } else {
        durableContinuationTurns.delete(sessionID);
      }

      if (PROVENANCE_TOOLS.has(toolName)) {
        await registerProvenance({
          sessionID,
          callID: String(input?.callID ?? "").trim() || null,
          toolName,
          args: output?.args ?? {},
          origin,
          userMessageId: currentUserMessageId,
          historySource: history.source,
          historyErrorCode: history.errorCode,
        });
      }

      // An agent_start without a proven current user message cannot establish a
      // trustworthy park baseline or invocation provenance. Fail before the MCP
      // tool executes so authentication/SDK drift cannot spend a qualification run.
      if (!denyParkedTool && toolName === "agent_start" && !currentUserMessageId) {
        throw new Error(`agent_runtime_main_orchestrator_provenance_history_unavailable:agent_start:${history.errorCode ?? "unknown"}`);
      }

      // Graceful park: never abort the OpenCode session. Aborting can leave the
      // current assistant message without time.completed and the server-side run
      // state stuck busy. Instead, fence every subsequent tool invocation from the
      // same parked user turn and let the assistant naturally emit the sentinel
      // final response, which terminalizes the message/session before H-9R wakes it.
      if (denyParkedTool) throw parkedToolError(toolName, parked);
    },

    "tool.execute.after": async (input, output) => {
      const toolName = normalizeToolName(input?.tool);
      const sessionID = String(input?.sessionID ?? "").trim();
      if (toolName !== "agent_start" || !sessionID || !resultRequestsPark(output)) return;
      const history = await latestUserMessage({ serverUrl, directory, sessionID, client });
      const currentUserMessage = history.message;
      parkedSessions.set(sessionID, {
        baselineUserMessageId: messageId(currentUserMessage),
        baselineHistorySource: history.source,
        baselineHistoryErrorCode: history.errorCode,
        parkedAt: Date.now(),
        runId: parkRunId(output),
      });
    },

    event: async ({ event }) => {
      if (event?.type !== "session.deleted") return;
      const sessionID = String(event?.properties?.sessionID ?? event?.properties?.id ?? "").trim();
      if (sessionID) {
        parkedSessions.delete(sessionID);
        durableContinuationTurns.delete(sessionID);
      }
    },
  };
};
