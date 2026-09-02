#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createContextEngineServerFromServices,
  createContextEngineServices,
} from "./server.js";
import { runWithContextEngineRequestContext } from "./request-context.js";
import { contextEngineLog, describeMcpRequest } from "./structured-log.js";
import { cbmBootstrapRetryDelayMs, isRetryableCbmBootstrapFailure } from "./cbm-bootstrap-retry.js";
import { InvocationProvenanceRegistry, invocationArgsDigest, mcpToolCallIdentity, normalizeInvocationToolName } from "./invocation-provenance.js";

const host = process.env.CONTEXT_ENGINE_HTTP_HOST?.trim() || "0.0.0.0";
const port = Number(process.env.CONTEXT_ENGINE_HTTP_PORT ?? 8789);
const maxBodyBytes = Number(process.env.CONTEXT_ENGINE_HTTP_MAX_BODY_BYTES ?? 2 * 1024 * 1024);
const projectRoot = resolve(process.env.AGENT_HARNESS_PROJECT_ROOT?.trim() || process.cwd());
const harnessRoot = resolve(process.env.AGENT_HARNESS_ROOT?.trim() || process.cwd());
const services = createContextEngineServices(undefined, { cwd: projectRoot });

const RUNTIME_PROGRESS_OBSERVATION_EVENTS = new Set([
  "progress.live_projector_loaded",
  "progress.live_projector_attached",
  "progress.live_projector_heartbeat",
  "progress.live_projector_detached",
  "progress.live_delivery_observed",
  "progress.live_projector_disposed",
]);
const runtimeProgressObservations: Array<Record<string, unknown>> = [];
const MAX_RUNTIME_PROGRESS_OBSERVATIONS = 512;
const invocationProvenanceRegistry = new InvocationProvenanceRegistry();
const invocationProvenancePluginPath = resolve(harnessRoot, ".opencode/plugins/runtime-invocation-provenance.js");

function currentInvocationProvenancePluginSourceSha256(): string {
  return `sha256:${createHash("sha256").update(readFileSync(invocationProvenancePluginPath)).digest("hex")}`;
}

interface ContextEngineStartupState {
  ready: boolean;
  cbmIndexed: boolean;
  cbmProject: string | null;
  cbmNodes: number | null;
  cbmEdges: number | null;
  error: string | null;
  bootstrapAttempts: number;
  retryScheduledAt: string | null;
}

const startupState: ContextEngineStartupState = {
  ready: false,
  cbmIndexed: false,
  cbmProject: null,
  cbmNodes: null,
  cbmEdges: null,
  error: null,
  bootstrapAttempts: 0,
  retryScheduledAt: null,
};

let cbmBootstrapRetryTimer: NodeJS.Timeout | null = null;
let cbmBootstrapInFlight = false;
let shuttingDown = false;

async function bootstrapContextEngine(): Promise<void> {
  const startedAt = Date.now();
  startupState.bootstrapAttempts += 1;
  startupState.retryScheduledAt = null;
  contextEngineLog("info", "cbm.bootstrap_started", {
    repositoryRoot: projectRoot,
    harnessRoot,
    mode: process.env.CONTEXT_ENGINE_CBM_BOOTSTRAP_MODE ?? "full",
    attempt: startupState.bootstrapAttempts,
  });
  const ready = await services.runtime.cbm.ensureReady({
    autoIndex: process.env.CONTEXT_ENGINE_CBM_AUTO_INDEX !== "false",
    probeTimeoutMs: Number(process.env.CONTEXT_ENGINE_HEALTH_CBM_COLD_TIMEOUT_MS ?? 15_000),
    indexTimeoutMs: Number(process.env.CONTEXT_ENGINE_CBM_BOOTSTRAP_TIMEOUT_MS ?? 300_000),
    mode: (process.env.CONTEXT_ENGINE_CBM_BOOTSTRAP_MODE as "full" | "fast" | "moderate" | undefined) ?? "full",
  });
  startupState.ready = true;
  startupState.cbmIndexed = ready.indexed;
  startupState.cbmProject = ready.status.project;
  startupState.cbmNodes = ready.status.nodes;
  startupState.cbmEdges = ready.status.edges;
  startupState.error = null;
  contextEngineLog("info", "cbm.bootstrap_completed", {
    project: ready.status.project, nodes: ready.status.nodes, edges: ready.status.edges,
    indexed: ready.indexed, durationMs: Date.now() - startedAt, attempt: startupState.bootstrapAttempts,
  });
}

function cbmPersistentDiagnostics(): Record<string, unknown> | null {
  try {
    const config = services.runtime.cbm.getRuntimeConfig();
    return config.persistent ? { ...config.persistent } : null;
  } catch {
    return null;
  }
}

function scheduleCbmBootstrapRetry(error: unknown): void {
  if (shuttingDown || cbmBootstrapRetryTimer || !isRetryableCbmBootstrapFailure(error)) return;
  const delayMs = cbmBootstrapRetryDelayMs(startupState.bootstrapAttempts);
  const retryAt = new Date(Date.now() + delayMs).toISOString();
  startupState.retryScheduledAt = retryAt;
  contextEngineLog("warn", "cbm.bootstrap_retry_scheduled", {
    attempt: startupState.bootstrapAttempts,
    delayMs,
    retryAt,
    error: error instanceof Error ? error.message : String(error),
  });
  cbmBootstrapRetryTimer = setTimeout(() => {
    cbmBootstrapRetryTimer = null;
    void runCbmBootstrapWithRecovery();
  }, delayMs);
  cbmBootstrapRetryTimer.unref?.();
}

async function runCbmBootstrapWithRecovery(): Promise<void> {
  if (shuttingDown || cbmBootstrapInFlight || startupState.ready) return;
  cbmBootstrapInFlight = true;
  try {
    await bootstrapContextEngine();
  } catch (error) {
    startupState.ready = false;
    startupState.error = error instanceof Error ? error.message : String(error);
    contextEngineLog("error", "cbm.bootstrap_failed", {
      error: startupState.error,
      attempt: startupState.bootstrapAttempts,
      persistent: cbmPersistentDiagnostics(),
    });
    scheduleCbmBootstrapRetry(error);
  } finally {
    cbmBootstrapInFlight = false;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) throw new Error("context_engine_http_body_too_large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function optionalBoundedString(value: unknown, maxLength = 512): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text.length > maxLength) return null;
  return text;
}

function normalizeRuntimeProgressObservation(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("runtime_progress_observation_body_invalid");
  const input = body as Record<string, unknown>;
  const event = optionalBoundedString(input.event, 96);
  const pluginId = optionalBoundedString(input.pluginId, 160);
  const instanceId = optionalBoundedString(input.instanceId, 160);
  if (!event || !RUNTIME_PROGRESS_OBSERVATION_EVENTS.has(event)) throw new Error("runtime_progress_observation_event_invalid");
  if (!pluginId || !instanceId) throw new Error("runtime_progress_observation_identity_missing");
  const observedAt = Number(input.observedAt);
  return {
    event,
    pluginId,
    instanceId,
    runId: optionalBoundedString(input.runId, 200),
    sessionId: optionalBoundedString(input.sessionId, 192),
    messageId: optionalBoundedString(input.messageId, 192),
    directory: optionalBoundedString(input.directory, 1024),
    pollMs: Number.isFinite(Number(input.pollMs)) ? Number(input.pollMs) : null,
    checkpointCreatedAt: Number.isFinite(Number(input.checkpointCreatedAt)) ? Number(input.checkpointCreatedAt) : null,
    projectionLatencyMs: Number.isFinite(Number(input.projectionLatencyMs)) ? Number(input.projectionLatencyMs) : null,
    observedAt: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : Date.now(),
    receivedAt: Date.now(),
    source: "opencode-tui-plugin",
    authoritative: false,
  };
}

function selectRuntimeProgressObservations(url: URL): Array<Record<string, unknown>> {
  const sessionId = url.searchParams.get("sessionId")?.trim() || null;
  const instanceId = url.searchParams.get("instanceId")?.trim() || null;
  const messageId = url.searchParams.get("messageId")?.trim() || null;
  const event = url.searchParams.get("event")?.trim() || null;
  const directory = url.searchParams.get("directory")?.trim() || null;
  const since = Number(url.searchParams.get("since") ?? NaN);
  return runtimeProgressObservations.filter((entry) =>
    (!sessionId || entry.sessionId === sessionId) &&
    (!instanceId || entry.instanceId === instanceId) &&
    (!messageId || entry.messageId === messageId) &&
    (!directory || entry.directory === directory) &&
    (!event || entry.event === event) &&
    (!Number.isFinite(since) || Number(entry.receivedAt ?? 0) >= since));
}

export function createContextEngineHttpServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/runtime-invocation-provenance") {
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          json(response, 405, { error: "method_not_allowed" });
          return;
        }
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          json(response, 400, { error: "runtime_invocation_provenance_body_invalid" });
          return;
        }
        const input = body as Record<string, unknown>;
        const agentId = optionalBoundedString(input.agentId, 160);
        const toolName = normalizeInvocationToolName(input.toolName);
        const sessionId = optionalBoundedString(input.sessionId, 192);
        const callId = optionalBoundedString(input.callId, 192);
        const userMessageId = optionalBoundedString(input.userMessageId, 192);
        const pluginSourceSha256 = optionalBoundedString(input.pluginSourceSha256, 96);
        const historySource = optionalBoundedString(input.historySource, 64);
        const historyErrorCode = optionalBoundedString(input.historyErrorCode, 512);
        const origin = optionalBoundedString(input.origin, 64);
        const allowedOrigins = new Set(["explicit-human-turn", "autonomous-assistant", "durable-continuation", "qualification-harness"]);
        if (!agentId || !toolName || !origin || !allowedOrigins.has(origin)) {
          json(response, 400, { error: "runtime_invocation_provenance_invalid" });
          return;
        }
        const expectedPluginSourceSha256 = currentInvocationProvenancePluginSourceSha256();
        if (!pluginSourceSha256 || pluginSourceSha256 !== expectedPluginSourceSha256) {
          contextEngineLog("warn", "mcp.invocation_provenance_plugin_source_mismatch", {
            agentId, toolName, sessionId, callId, pluginSourceSha256, expectedPluginSourceSha256,
          });
          json(response, 409, {
            error: "runtime_invocation_provenance_plugin_source_mismatch",
            expectedPluginSourceSha256,
            receivedPluginSourceSha256: pluginSourceSha256,
          });
          return;
        }
        const registration = invocationProvenanceRegistry.register({
          agentId, toolName, argsDigest: invocationArgsDigest(input.arguments ?? {}),
          origin: origin as "explicit-human-turn" | "autonomous-assistant" | "durable-continuation" | "qualification-harness",
          sessionId, callId, userMessageId, pluginSourceSha256, historySource, historyErrorCode, observedAt: Date.now(),
        });
        contextEngineLog("info", "mcp.invocation_provenance_registered", {
          agentId, toolName, origin, sessionId, callId, userMessageId, pluginSourceSha256, historySource, historyErrorCode, expiresAt: registration.expiresAt,
        });
        json(response, 202, { accepted: true, toolName, origin, expiresAt: registration.expiresAt });
        return;
      }

      if (url.pathname === "/runtime-progress-live") {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          json(response, 405, { error: "method_not_allowed" });
          return;
        }
        const runId = optionalBoundedString(url.searchParams.get("runId"), 200);
        const sessionId = optionalBoundedString(url.searchParams.get("sessionId"), 200);
        if (!runId && !sessionId) {
          json(response, 400, { error: "runtime_progress_live_run_or_session_required" });
          return;
        }
        if (!services.agentControl) {
          json(response, 503, { error: "agent_runtime_control_disabled" });
          return;
        }
        const snapshot = runId
          ? await services.agentControl.progress(runId, { includeEfficiency: false })
          : await services.agentControl.progressForSession(sessionId!, { includeEfficiency: false });
        json(response, 200, {
          contractVersion: "runtime-progress-live/v1",
          authoritative: false,
          source: "runtime-presentation-readonly",
          snapshot,
        });
        return;
      }
      if (url.pathname === "/runtime-progress-observation") {
        if (request.method === "POST") {
          const observation = normalizeRuntimeProgressObservation(await readJsonBody(request));
          runtimeProgressObservations.push(observation);
          if (runtimeProgressObservations.length > MAX_RUNTIME_PROGRESS_OBSERVATIONS) {
            runtimeProgressObservations.splice(0, runtimeProgressObservations.length - MAX_RUNTIME_PROGRESS_OBSERVATIONS);
          }
          contextEngineLog("info", String(observation.event), {
            ...observation,
            component: "agent-runtime.progress.tui",
          });
          const durable = observation.event === "progress.live_delivery_observed" && services.agentControl
            ? await services.agentControl.recordProgressObservation(observation)
            : null;
          if (observation.event === "progress.live_delivery_observed") {
            const durableRecord = durable && typeof durable === "object" && !Array.isArray(durable)
              ? durable as Record<string, unknown>
              : null;
            const identity = {
              runId: durableRecord?.runId ?? observation.runId ?? null,
              sessionId: observation.sessionId ?? null,
              messageId: observation.messageId ?? null,
              instanceId: observation.instanceId ?? null,
              authoritative: false,
              presentationOnly: true,
            };
            if (durableRecord?.correlated === true) {
              contextEngineLog("info", "progress.live_delivery_observation_correlated", {
                ...identity,
                effectKey: durableRecord.effectKey ?? null,
              });
            }
            contextEngineLog(durableRecord?.persisted === true ? "info" : "warn",
              durableRecord?.persisted === true
                ? "progress.live_delivery_observation_persisted"
                : "progress.live_delivery_observation_rejected", {
                ...identity,
                reason: durableRecord?.reason ?? null,
                effectKey: durableRecord?.effectKey ?? null,
                inserted: durableRecord?.inserted ?? null,
              });
          }
          json(response, 202, { accepted: true, event: observation.event, instanceId: observation.instanceId, durable });
          return;
        }
        if (request.method === "GET") {
          const observations = selectRuntimeProgressObservations(url);
          json(response, 200, {
            observations,
            latest: observations.at(-1) ?? null,
          });
          return;
        }
        response.setHeader("allow", "GET, POST");
        json(response, 405, { error: "method_not_allowed" });
        return;
      }

      if (url.pathname === "/healthz") {
        json(response, startupState.ready ? 200 : 503, {
          status: startupState.ready ? "ok" : "starting",
          service: "agentic-harness-context-engine",
          transport: "streamable-http",
          agentControlEnabled: Boolean(services.agentControl),
          cbm: {
            ready: startupState.ready,
            indexedOnStartup: startupState.cbmIndexed,
            project: startupState.cbmProject,
            nodes: startupState.cbmNodes,
            edges: startupState.cbmEdges,
            error: startupState.error,
            bootstrapAttempts: startupState.bootstrapAttempts,
            retryScheduledAt: startupState.retryScheduledAt,
          },
        });
        return;
      }

      if (url.pathname !== "/mcp") {
        json(response, 404, { error: "not_found" });
        return;
      }

      if (!startupState.ready) {
        json(response, 503, {
          error: "context_engine_not_ready",
          reason: startupState.error ?? "cbm_bootstrap_in_progress",
        });
        return;
      }

      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        json(response, 405, { error: "method_not_allowed" });
        return;
      }

      // Stateless transport with a fresh McpServer+transport per HTTP request.
      // All requests still share one process-scoped ContextEngineServices
      // instance above, so cache/memory/AgentRuntimeControlPlane remain singletons.
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      const mcpServer = createContextEngineServerFromServices(services);
      const body = await readJsonBody(request);
      const callerHeader = request.headers["x-agentic-harness-agent-id"];
      const callerAgentId = Array.isArray(callerHeader) ? callerHeader[0] : callerHeader;
      const normalizedCallerAgentId = callerAgentId?.trim() || null;
      const requestDescription = describeMcpRequest(body);
      const toolIdentity = mcpToolCallIdentity(body);
      const invocationProvenance = toolIdentity
        ? invocationProvenanceRegistry.consume({ agentId: normalizedCallerAgentId, ...toolIdentity })
        : null;
      const invocationContext = {
        invocationOrigin: invocationProvenance?.origin ?? "unknown" as const,
        invocationSessionId: invocationProvenance?.sessionId ?? null,
        invocationCallId: invocationProvenance?.callId ?? null,
        invocationUserMessageId: invocationProvenance?.userMessageId ?? null,
        invocationProvenanceSource: invocationProvenance ? "opencode-plugin-sidechannel" as const : "missing" as const,
      };
      const requestStartedAt = Date.now();
      contextEngineLog("info", "mcp.request_started", {
        ...requestDescription, callerAgentId: normalizedCallerAgentId, ...invocationContext,
      });
      try {
        await runWithContextEngineRequestContext(
          { transport: "http", agentId: normalizedCallerAgentId, ...invocationContext },
          async () => {
            // @modelcontextprotocol/sdk 1.29.0 exposes structurally equivalent transport
            // classes/interfaces whose optional callback declarations diverge under
            // exactOptionalPropertyTypes. Keep the concrete transport authoritative and
            // narrow the compatibility cast to this SDK boundary only.
            await mcpServer.connect(transport as unknown as Parameters<typeof mcpServer.connect>[0]);
            await transport.handleRequest(request, response, body);
          },
        );
        contextEngineLog("info", "mcp.request_completed", {
          ...requestDescription, callerAgentId: normalizedCallerAgentId, ...invocationContext,
          statusCode: response.statusCode, durationMs: Date.now() - requestStartedAt,
        });
      } catch (error) {
        contextEngineLog("error", "mcp.request_failed", {
          ...requestDescription, callerAgentId: normalizedCallerAgentId, ...invocationContext,
          durationMs: Date.now() - requestStartedAt, error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        await transport.close().catch(() => undefined);
      }
    } catch (error) {
      if (!response.headersSent) {
        json(response, 500, {
          error: "context_engine_http_request_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  });
}

const server = createContextEngineHttpServer();
server.listen(port, host, () => {
  contextEngineLog("info", "http.listening", { host, port, endpoint: "/mcp" });
  void runCbmBootstrapWithRecovery();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shuttingDown = true;
    if (cbmBootstrapRetryTimer) {
      clearTimeout(cbmBootstrapRetryTimer);
      cbmBootstrapRetryTimer = null;
    }
    server.close(() => {
      void services.runtime.close().finally(() => process.exit(0));
    });
  });
}
