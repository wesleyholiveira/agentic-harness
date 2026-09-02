import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SemanticContextCache } from "@agent-harness/context-semantic-cache";
import type { Visibility } from "../visibility.js";
import type { CbmRuntimeDiagnostics } from "../runtime-services.js";
import type { CBMAdapter } from "@agent-harness/cbm-adapter";
import type { ProjectMemory } from "@agent-harness/project-memory";

export interface ComponentHealth {
  status: "up" | "down" | "disabled";
  latency_ms?: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface HealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  components: Record<string, ComponentHealth>;
  uptime_seconds: number;
}

function cbmDetails(cbm: CBMAdapter, runtime?: CbmRuntimeDiagnostics): Record<string, unknown> | undefined {
  if (!runtime) return undefined;
  const live = cbm.getRuntimeConfig();
  const pathLike = isAbsolute(live.binary) || live.binary.includes("/") || live.binary.includes("\\");
  return {
    command_source: runtime.source,
    binary: live.binary,
    binary_exists: pathLike ? existsSync(live.binary) : null,
    project: live.project,
    transport: live.transport,
    server_args: live.serverArgs,
    ...(live.persistent ? { persistent_session: live.persistent } : {}),
    ...(live.repositoryRoot ? { repository_root: live.repositoryRoot } : {}),
    ...(runtime.configPath ? { opencode_config: runtime.configPath } : {}),
  };
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${code}:${timeoutMs}ms`)), Math.max(250, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerGetHealth(
  visibility: Visibility,
  cbm: CBMAdapter,
  memory: ProjectMemory,
  startedAt: number,
  cbmRuntime?: CbmRuntimeDiagnostics,
  semanticCache?: SemanticContextCache,
): void {
  visibility.registerVisibleTool(
    "context_health",
    {
      description:
        "Check health of Context Engine dependencies, including semantic Redis/embedding dependencies when enabled.",
      inputSchema: {},
    },
    async () => {
      const components: Record<string, ComponentHealth> = {};

      const cbmStart = Date.now();
      const cbmLive = cbm.getRuntimeConfig();
      const persistentState = cbmLive.persistent?.state;
      const isColdPersistentProbe = cbmLive.transport === "persistent-mcp" && persistentState !== "connected";
      const cbmTimeoutMs = Number(
        isColdPersistentProbe
          ? process.env.CONTEXT_ENGINE_HEALTH_CBM_COLD_TIMEOUT_MS ?? 15_000
          : process.env.CONTEXT_ENGINE_HEALTH_CBM_TIMEOUT_MS ?? 5_000,
      );
      const cbmDiagnosticDetails = cbmDetails(cbm, cbmRuntime);
      try {
        await withDeadline(cbm.probe(cbmTimeoutMs), cbmTimeoutMs, "cbm_health_timeout");
        components.cbm = {
          status: "up",
          latency_ms: Date.now() - cbmStart,
          ...(cbmDiagnosticDetails ? { details: cbmDiagnosticDetails } : {}),
        };
      } catch (error) {
        components.cbm = {
          status: "down",
          error: error instanceof Error ? error.message : String(error),
          ...(cbmDiagnosticDetails ? { details: cbmDiagnosticDetails } : {}),
        };
      }

      const memStart = Date.now();
      try {
        await memory.getDecisions({ query: "health", limit: 1 });
        components.memory = { status: "up", latency_ms: Date.now() - memStart };
      } catch (error) {
        components.memory = { status: "down", error: error instanceof Error ? error.message : String(error) };
      }

      let semanticClosedDown = false;
      let semanticRedundancyDegraded = false;
      if (semanticCache) {
        const timeoutMs = Number(process.env.CONTEXT_SEMANTIC_HEALTH_TIMEOUT_MS ?? 5_000);
        try {
          const semantic = await withDeadline(semanticCache.health(), timeoutMs, "semantic_health_timeout");
          const common = { mode: semantic.mode, failure_mode: semantic.failureMode };
          components.semantic_redis = semantic.status === "disabled"
            ? { status: "disabled", details: { ...common, ...(semantic.redis.details ?? {}) } }
            : {
                status: semantic.redis.status,
                ...(semantic.redis.latencyMs === undefined ? {} : { latency_ms: semantic.redis.latencyMs }),
                ...(semantic.redis.error ? { error: semantic.redis.error } : {}),
                details: { ...common, ...(semantic.redis.details ?? {}) },
              };
          components.semantic_embedding = semantic.status === "disabled"
            ? { status: "disabled", details: { ...common, ...(semantic.embedding.details ?? {}) } }
            : {
                status: semantic.embedding.status,
                ...(semantic.embedding.latencyMs === undefined ? {} : { latency_ms: semantic.embedding.latencyMs }),
                ...(semantic.embedding.error ? { error: semantic.embedding.error } : {}),
                details: { ...common, ...(semantic.embedding.details ?? {}) },
              };
          semanticClosedDown = semantic.status === "down" && semantic.failureMode === "closed";
          semanticRedundancyDegraded = semantic.status === "up" && (
            semantic.redis.details?.redundancy_state === "degraded"
            || semantic.embedding.details?.redundancy_state === "degraded"
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          components.semantic_redis = { status: "down", error: message };
          components.semantic_embedding = { status: "down", error: message };
          semanticClosedDown = semanticCache.config.failureMode === "closed";
        }
      }

      const core = [components.cbm, components.memory].filter(Boolean);
      const coreAllUp = core.every((component) => component?.status === "up");
      const coreAnyUp = core.some((component) => component?.status === "up");
      const semanticEnabled = semanticCache !== undefined && semanticCache.config.mode !== "off";
      const semanticAllUp = !semanticEnabled || (
        components.semantic_redis?.status === "up" && components.semantic_embedding?.status === "up"
      );
      const status: HealthReport["status"] = !coreAnyUp || semanticClosedDown
        ? "unhealthy"
        : coreAllUp && semanticAllUp && !semanticRedundancyDegraded
          ? "healthy"
          : "degraded";

      const report: HealthReport = {
        status,
        components,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
    },
  );
}
