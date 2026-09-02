import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoggingLevelSchema, SetLevelRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, LoggingLevel } from "@modelcontextprotocol/sdk/types.js";
import type { StatsCollector } from "./stats.js";

export type { LoggingLevel };

const LEVEL_ORDER: LoggingLevel[] = LoggingLevelSchema.options;

export type MetaExtractor = (result: unknown) => Record<string, unknown>;

type VisibleToolConfig = {
  description: string;
  inputSchema: unknown;
};

function recordMeta(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Cross-cutting MCP observability for every context-engine tool.
 *
 * This wrapper is intentionally on the actual registration path: tools must
 * register through it so logging, _meta enrichment, and StatsCollector stay
 * consistent. Visibility failures are non-fatal and never block tool output.
 */
export class Visibility {
  private clientLevel: LoggingLevel = "debug";

  constructor(
    private server: McpServer,
    private stats: StatsCollector,
  ) {
    this.server.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
      this.clientLevel = request.params.level;
      return {};
    });
  }

  setClientLevel(level: LoggingLevel): void {
    this.clientLevel = level;
  }

  satisfiesLevel(level: LoggingLevel): boolean {
    return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(this.clientLevel);
  }

  async emit(level: LoggingLevel, data: unknown): Promise<void> {
    if (!this.satisfiesLevel(level)) return;
    try {
      await this.server.server.sendLoggingMessage({
        level,
        logger: "context-engine",
        data,
      });
    } catch (error) {
      // Observability is best-effort. It must never break a context request.
      console.error("[context-engine] sendLoggingMessage failed:", error);
    }
  }

  registerVisibleTool(
    name: string,
    config: VisibleToolConfig,
    // Tool schemas are validated by the MCP SDK. The wrapper deliberately
    // erases each tool's distinct Zod output type at this cross-cutting seam.
    handler: (args: any) => Promise<CallToolResult>,
    extractMeta?: MetaExtractor,
  ): void {
    const sdkConfig = config as unknown as Parameters<McpServer["registerTool"]>[1];
    this.server.registerTool(name, sdkConfig, async (args: unknown) => {
      const startedAt = Date.now();
      await this.emit("debug", { tool: name, event: "start" });

      try {
        const result = await handler(args);
        const elapsedMs = Date.now() - startedAt;
        const existingMeta = recordMeta(result._meta);
        let extractedMeta: Record<string, unknown> = {};

        if (extractMeta) {
          try {
            extractedMeta = extractMeta(result);
          } catch (error) {
            // Metadata extraction is observability-only; never turn a successful
            // tool result into a failed tool call because telemetry parsing failed.
            await this.emit("warning", {
              tool: name,
              event: "meta-error",
              error: String(error),
            });
          }
        }

        const meta = {
          ...existingMeta,
          ...extractedMeta,
          tool: name,
          ms: elapsedMs,
        };
        const enriched: CallToolResult = { ...result, _meta: meta };

        await this.emit(this.levelFor(meta), {
          event: "end",
          ...meta,
        });
        this.stats.recordCall(name, elapsedMs);
        return enriched;
      } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        await this.emit("warning", {
          tool: name,
          event: "error",
          error: String(error),
          ms: elapsedMs,
        });
        this.stats.recordError(name);
        throw error;
      }
    });
  }

  private levelFor(meta: Record<string, unknown>): LoggingLevel {
    const warnings = meta.warnings;
    if (Array.isArray(warnings) && warnings.length > 0) return "warning";

    const status = meta.status;
    if (status === "cache-miss-reference") return "warning";
    // Both hits and misses are user-relevant cache outcomes. Emitting them at
    // info keeps them visible even when the client filters debug noise.
    if (typeof status === "string" && status.startsWith("cache-")) return "info";
    if (typeof status === "string" && status.startsWith("agent-")) return "info";
    return "debug";
  }
}
