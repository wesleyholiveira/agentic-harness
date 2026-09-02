import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CBMAdapter } from "@agent-harness/cbm-adapter";
import type { TieredContextCache } from "@agent-harness/context-cache";
import { analyzeTask, type ContextPackBuilder, type ContextReferenceStore } from "@agent-harness/context-pack";
import type { ProjectMemory } from "@agent-harness/project-memory";
import type { SerenaAdapter } from "@agent-harness/serena-adapter";
import { StatsCollector } from "../src/stats.js";
import { Visibility } from "../src/visibility.js";
import { registerFindRelated } from "../src/tools/find-related.js";
import { registerGetArchitecture } from "../src/tools/get-architecture.js";
import { registerGetDecision } from "../src/tools/get-decision.js";
import { registerGetFileSummary } from "../src/tools/get-file-summary.js";
import { registerGetHealth } from "../src/tools/get-health.js";
import { registerGetImpact } from "../src/tools/get-impact.js";
import { registerGetStats } from "../src/tools/get-stats.js";
import { registerGetSymbol } from "../src/tools/get-symbol.js";
import { registerGetTaskContext } from "../src/tools/get-task-context.js";
import { registerSearchHistory } from "../src/tools/search-history.js";
import { registerResolveContext } from "../src/tools/resolve-context.js";
import { registerStoreDecision } from "../src/tools/store-decision.js";

interface CapturedTool {
  description: string;
  inputSchema: unknown;
  handler: (...args: unknown[]) => Promise<unknown>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
}

function createMockServer(stats = new StatsCollector()) {
  const tools = new Map<string, CapturedTool>();
  const registerTool = vi.fn(
    (
      name: string,
      opts: { description: string; inputSchema?: unknown },
      handler: (...args: unknown[]) => Promise<unknown>,
    ) => {
      tools.set(name, { description: opts.description, inputSchema: opts.inputSchema, handler });
    },
  );
  const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
  const setRequestHandler = vi.fn();
  const server = {
    registerTool,
    connect: vi.fn(),
    close: vi.fn(),
    server: { sendLoggingMessage, setRequestHandler },
  };
  const visibility = new Visibility(server as unknown as McpServer, stats);
  return {
    server: server as unknown as McpServer,
    visibility,
    stats,
    registerTool,
    tools,
    sendLoggingMessage,
    setRequestHandler,
  };
}

function getTool(tools: Map<string, CapturedTool>, name: string): CapturedTool {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Tool "${name}" was not registered`);
  }
  return tool;
}

function makePack(options: {
  cacheHit?: boolean;
  cacheTier?: "l1" | "l2";
  budget?: number;
  componentHits?: number;
  componentMisses?: number;
} = {}) {
  return {
    task_analysis: analyzeTask("implement auth cache"),
    previous_decisions: [],
    symbols: [],
    architecture: "",
    static_artifacts: [],
    summaries: [],
    dependencies: { callers: [], callees: [], tests: [] },
    external_docs: [],
    metadata: {
      total_tokens: 42,
      budget: options.budget ?? 18000,
      sources_queried: ["cbm"],
      cache_hit: options.cacheHit ?? false,
      ...(options.cacheTier ? { cache_tier: options.cacheTier } : {}),
      component_cache: {
        hits: options.componentHits ?? 0,
        misses: options.componentMisses ?? 0,
        hit_sources: options.componentHits ? ["cbm-index-status"] : [],
        miss_sources: options.componentMisses ? ["cbm-symbols"] : [],
      },
      generated_at: "2026-08-15T00:00:00.000Z",
      warnings: [],
    },
  };
}

describe("Context Engine Server", () => {
  it("registers context_get_task_context and builds a context pack", async () => {
    const { visibility, registerTool, tools } = createMockServer();
    const packFixture = makePack({ budget: 5000 });
    const builder = { buildWithRaw: vi.fn().mockResolvedValue({ pack: packFixture, rawPack: packFixture }) };

    registerGetTaskContext(visibility, builder as unknown as ContextPackBuilder);

    expect(registerTool).toHaveBeenCalledWith(
      "context_get_task_context",
      expect.objectContaining({ description: expect.any(String) }),
      expect.any(Function),
    );

    const tool = getTool(tools, "context_get_task_context");
    const result = (await tool.handler({ task: "implement auth", budget: 5000 })) as ToolResult;
    expect(builder.buildWithRaw).toHaveBeenCalledWith("implement auth", 5000, {});
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe(JSON.stringify(packFixture, null, 2));
  });

  it("registers context_get_symbol and queries CBM + Serena", async () => {
    const { visibility, registerTool, tools } = createMockServer();
    const snippetFixture = { qualified_name: "pkg.Foo", code: "code" };
    const serenaFixture = { name: "Foo", kind: "Function", file_path: "pkg/foo.ts" };
    const cbm = { getSnippet: vi.fn().mockResolvedValue(snippetFixture) };
    const serena = { getSymbol: vi.fn().mockResolvedValue(serenaFixture) };

    registerGetSymbol(visibility, cbm as unknown as CBMAdapter, serena as unknown as SerenaAdapter);

    expect(registerTool).toHaveBeenCalledWith(
      "context_get_symbol",
      expect.objectContaining({ description: expect.any(String) }),
      expect.any(Function),
    );

    const tool = getTool(tools, "context_get_symbol");
    const result = (await tool.handler({ qualified_name: "pkg.Foo" })) as ToolResult;
    expect(cbm.getSnippet).toHaveBeenCalledWith("pkg.Foo");
    expect(serena.getSymbol).toHaveBeenCalledWith("pkg.Foo");
    expect(result.content[0]?.text).toBe(
      JSON.stringify({ snippet: snippetFixture, serena_info: serenaFixture }, null, 2),
    );
  });

  it("registers context_get_architecture and returns raw architecture text", async () => {
    const { visibility, registerTool, tools } = createMockServer();
    const cbm = { getArchitecture: vi.fn().mockResolvedValue("architecture overview") };

    registerGetArchitecture(visibility, cbm as unknown as CBMAdapter);

    expect(registerTool).toHaveBeenCalledWith(
      "context_get_architecture",
      expect.objectContaining({ description: expect.any(String) }),
      expect.any(Function),
    );

    const tool = getTool(tools, "context_get_architecture");
    const result = (await tool.handler()) as ToolResult;
    expect(cbm.getArchitecture).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe("architecture overview");
  });

  it("registers context_find_related and searches each concept", async () => {
    const { visibility, registerTool, tools } = createMockServer();
    const symFixture = [{ qualified_name: "pkg.Auth" }, { qualified_name: "pkg.User" }];
    const cbm = { searchSymbols: vi.fn().mockResolvedValue(symFixture) };

    registerFindRelated(visibility, cbm as unknown as CBMAdapter);

    expect(registerTool).toHaveBeenCalledWith(
      "context_find_related",
      expect.objectContaining({ description: expect.any(String) }),
      expect.any(Function),
    );

    const tool = getTool(tools, "context_find_related");
    const result = (await tool.handler({ concepts: ["auth", "user"] })) as ToolResult;
    expect(cbm.searchSymbols).toHaveBeenCalledTimes(2);
    expect(cbm.searchSymbols).toHaveBeenCalledWith(".*auth.*");
    expect(cbm.searchSymbols).toHaveBeenCalledWith(".*user.*");
    expect(result.content[0]?.text).toBe(JSON.stringify([...symFixture, ...symFixture], null, 2));
  });

  it("registers context_get_decision and queries project memory", async () => {
    const { visibility, registerTool, tools } = createMockServer();
    const decisionsFixture = [{ id: "d1", title: "Use Postgres" }];
    const memory = { getDecisions: vi.fn().mockReturnValue(decisionsFixture) };

    registerGetDecision(visibility, memory as unknown as ProjectMemory);

    expect(registerTool).toHaveBeenCalledWith(
      "context_get_decision",
      expect.objectContaining({ description: expect.any(String) }),
      expect.any(Function),
    );

    const tool = getTool(tools, "context_get_decision");
    const result = (await tool.handler({ query: "database", limit: 5 })) as ToolResult;
    expect(memory.getDecisions).toHaveBeenCalledWith({ query: "database", limit: 5 });
    expect(result.content[0]?.text).toBe(JSON.stringify(decisionsFixture, null, 2));
  });

  it("registers context_store_decision and returns the new id", async () => {
    const { visibility, registerTool, tools } = createMockServer();
    const memory = { storeDecision: vi.fn().mockReturnValue("dec-123") };

    registerStoreDecision(visibility, memory as unknown as ProjectMemory);

    expect(registerTool).toHaveBeenCalledWith(
      "context_store_decision",
      expect.objectContaining({ description: expect.any(String) }),
      expect.any(Function),
    );

    const tool = getTool(tools, "context_store_decision");
    const args = {
      title: "Use Postgres",
      content: "Adopt PostgreSQL",
      rationale: "Durability",
      files: ["src/python/x.py"],
      symbols: ["X"],
      commit: "abc123",
    };
    const result = (await tool.handler(args)) as ToolResult;
    expect(memory.storeDecision).toHaveBeenCalledWith(args);
    expect(result.content[0]?.text).toBe(JSON.stringify({ id: "dec-123" }));
  });

  it("registers context_get_file_summary and summarizes the requested path", async () => {
    const { visibility, registerTool, tools } = createMockServer();
    const root = mkdtempSync(join(tmpdir(), "context-summary-tool-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "export function A() { return 1; }\n");
    const cbm = {
      searchSymbols: vi.fn().mockResolvedValue([
        {
          qualified_name: "pkg.A",
          label: "Function",
          file: "src/a.ts",
          lines: "1-1",
          in_degree: 0,
          out_degree: 0,
        },
      ]),
    };

    try {
      registerGetFileSummary(visibility, cbm as unknown as CBMAdapter, undefined, root);

      expect(registerTool).toHaveBeenCalledWith(
        "context_get_file_summary",
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function),
      );

      const tool = getTool(tools, "context_get_file_summary");
      const result = (await tool.handler({ path: "src/a.ts" })) as ToolResult & {
        _meta: Record<string, unknown>;
      };
      const summary = JSON.parse(result.content[0]?.text ?? "{}");
      expect(cbm.searchSymbols).toHaveBeenCalledWith(".*a.*");
      expect(summary.path).toBe("src/a.ts");
      expect(summary.symbols).toEqual(["pkg.A"]);
      expect(result._meta).toMatchObject({ status: "cache-miss", path: "src/a.ts" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves context_get_file_summary from the shared cache when path+hash matches", async () => {
    const { visibility, tools, sendLoggingMessage } = createMockServer();
    const root = mkdtempSync(join(tmpdir(), "context-summary-cache-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "export function A() { return 1; }\n");
    const cachedSummary = {
      path: "src/a.ts",
      hash: "cached-hash-field-is-payload-only",
      symbols: ["pkg.A"],
      imports: [],
      defined_symbols: ["pkg.A"],
      responsibility_hint: "Contains function implementations",
      generated_at: 1,
    };
    const cbm = { searchSymbols: vi.fn() };
    const cache = {
      get: vi.fn().mockReturnValue({ value: cachedSummary, tier: "l2" }),
      set: vi.fn(),
      recordFileHash: vi.fn(),
    };

    try {
      registerGetFileSummary(
        visibility,
        cbm as unknown as CBMAdapter,
        cache as unknown as TieredContextCache,
        root,
      );
      const tool = getTool(tools, "context_get_file_summary");
      const result = (await tool.handler({ path: "src/a.ts" })) as ToolResult & {
        _meta: Record<string, unknown>;
      };

      expect(cbm.searchSymbols).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
      expect(result._meta).toMatchObject({
        status: "cache-hit-l2",
        cache_hit: true,
        cache_tier: "l2",
        path: "src/a.ts",
      });
      expect(sendLoggingMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "info",
          data: expect.objectContaining({ status: "cache-hit-l2" }),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers context_get_impact and traces inbound callers", async () => {
    const { visibility, registerTool, tools } = createMockServer();
    const traceFixture = { direction: "inbound", nodes: [], total: 0 };
    const cbm = { tracePath: vi.fn().mockResolvedValue(traceFixture) };

    registerGetImpact(visibility, cbm as unknown as CBMAdapter);

    expect(registerTool).toHaveBeenCalledWith(
      "context_get_impact",
      expect.objectContaining({ description: expect.any(String) }),
      expect.any(Function),
    );

    const tool = getTool(tools, "context_get_impact");
    const result = (await tool.handler({ symbol: "pkg.Foo", depth: 3 })) as ToolResult;
    expect(cbm.tracePath).toHaveBeenCalledWith("pkg.Foo", "inbound", 3);
    expect(result.content[0]?.text).toBe(JSON.stringify(traceFixture, null, 2));
  });

  it("registers context_search_history and queries task history", async () => {
    const { visibility, registerTool, tools } = createMockServer();
    const historyFixture = [{ id: "t1", task_desc: "build auth" }];
    const memory = { getTaskHistory: vi.fn().mockReturnValue(historyFixture) };

    registerSearchHistory(visibility, memory as unknown as ProjectMemory);

    expect(registerTool).toHaveBeenCalledWith(
      "context_search_history",
      expect.objectContaining({ description: expect.any(String) }),
      expect.any(Function),
    );

    const tool = getTool(tools, "context_search_history");
    const result = (await tool.handler({ query: "auth", limit: 10 })) as ToolResult;
    expect(memory.getTaskHistory).toHaveBeenCalledWith("auth", 10);
    expect(result.content[0]?.text).toBe(JSON.stringify(historyFixture, null, 2));
  });

  it("context_health tool returns health report with component statuses", async () => {
    const { visibility, registerTool, tools } = createMockServer();
    const cbm = {
      probe: vi.fn().mockResolvedValue({ project: "p", nodes: 1, edges: 1, status: "ok" }),
      getRuntimeConfig: vi.fn().mockReturnValue({
        project: "p",
        binary: "codebase-memory-mcp",
        transport: "cli",
        serverArgs: [],
      }),
    };
    const memory = { getDecisions: vi.fn().mockReturnValue([]) };

    registerGetHealth(visibility, cbm as unknown as CBMAdapter, memory as unknown as ProjectMemory, 1234);

    expect(registerTool).toHaveBeenCalledWith(
      "context_health",
      expect.objectContaining({ description: expect.any(String) }),
      expect.any(Function),
    );

    const tool = getTool(tools, "context_health");
    const result = (await tool.handler()) as ToolResult;
    const report = JSON.parse(result.content[0]?.text ?? "{}") as {
      status: string;
      components: Record<string, { status: string; latency_ms?: number }>;
    };
    expect(report.status).toBe("healthy");
    expect(report.components.cbm?.status).toBe("up");
    expect(report.components.memory?.status).toBe("up");
  });

  it("context_health reports degraded when a redundant semantic pool loses one member but stays serviceable", async () => {
    const { visibility, tools } = createMockServer();
    const cbm = {
      probe: vi.fn().mockResolvedValue({ project: "p", nodes: 1, edges: 1, status: "ok" }),
      getRuntimeConfig: vi.fn().mockReturnValue({ project: "p", binary: "codebase-memory-mcp", transport: "cli", serverArgs: [] }),
    };
    const memory = { getDecisions: vi.fn().mockReturnValue([]) };
    const semanticCache = {
      config: { mode: "enforce", failureMode: "closed" },
      health: vi.fn().mockResolvedValue({
        status: "up",
        mode: "enforce",
        failureMode: "closed",
        redis: {
          status: "up",
          details: { dependency: "redis", redundancy_state: "degraded", pool_size: 2, healthy_endpoints: 1 },
        },
        embedding: {
          status: "up",
          details: { dependency: "embedding", redundancy_state: "redundant", pool_size: 2, healthy_endpoints: 2 },
        },
      }),
    };

    registerGetHealth(
      visibility,
      cbm as unknown as CBMAdapter,
      memory as unknown as ProjectMemory,
      Date.now(),
      undefined,
      semanticCache as any,
    );

    const tool = getTool(tools, "context_health");
    const result = (await tool.handler()) as ToolResult;
    const report = JSON.parse(result.content[0]?.text ?? "{}") as {
      status: string;
      components: Record<string, { status: string; details?: Record<string, unknown> }>;
    };
    expect(report.status).toBe("degraded");
    expect(report.components.semantic_redis?.status).toBe("up");
    expect(report.components.semantic_redis?.details?.redundancy_state).toBe("degraded");
    expect(report.components.semantic_embedding?.status).toBe("up");
  });

  it("context_health bounds a stuck CBM probe instead of timing out the whole MCP request", async () => {
    const { visibility, tools } = createMockServer();
    const previous = process.env.CONTEXT_ENGINE_HEALTH_CBM_TIMEOUT_MS;
    process.env.CONTEXT_ENGINE_HEALTH_CBM_TIMEOUT_MS = "250";
    const cbm = {
      probe: vi.fn().mockReturnValue(new Promise(() => {})),
      getRuntimeConfig: vi.fn().mockReturnValue({ project: "p", binary: "codebase-memory-mcp" }),
    };
    const memory = { getDecisions: vi.fn().mockReturnValue([]) };
    try {
      registerGetHealth(visibility, cbm as unknown as CBMAdapter, memory as unknown as ProjectMemory, Date.now());
      const tool = getTool(tools, "context_health");
      const startedAt = Date.now();
      const result = (await tool.handler()) as ToolResult;
      const report = JSON.parse(result.content[0]?.text ?? "{}") as {
        status: string;
        components: Record<string, { status: string; error?: string }>;
      };
      expect(Date.now() - startedAt).toBeLessThan(1500);
      expect(report.status).toBe("degraded");
      expect(report.components.cbm?.status).toBe("down");
      expect(report.components.cbm?.error).toContain("cbm_health_timeout:250ms");
      expect(report.components.memory?.status).toBe("up");
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_ENGINE_HEALTH_CBM_TIMEOUT_MS;
      else process.env.CONTEXT_ENGINE_HEALTH_CBM_TIMEOUT_MS = previous;
    }
  });

  it("context_stats projects live semantic incident history", async () => {
    const { visibility, tools } = createMockServer();
    const stats = new StatsCollector();
    const semanticCache = {
      getStats: vi.fn().mockReturnValue({
        stats_contract_version: "semantic-cache-stats/v2",
        incident: {
          dependency: "embedding",
          error_code: null,
          cause_code: null,
          message: "context_semantic_dependency_unavailable:embedding:semantic_embedding_transport_unavailable:TEI unavailable",
          unavailable_until: null,
        },
        enabled: true,
        mode: "enforce",
        provider: "tei",
        model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        revision: "r",
        dimensions: 384,
        lookups: 1,
        candidate_hits: 0,
        misses: 0,
        store_attempts: 0,
        stores: 0,
        errors: 1,
        cooldown_skips: 1,
        last_unavailable_dependency: "embedding",
        // Reproduce a legacy/incomplete incident snapshot: dependency/message
        // are present, but code fields were omitted. context_stats must repair
        // this deterministically from the canonical message.
        last_error_code: null,
        last_cause_code: null,
        last_error_message:
          "context_semantic_dependency_unavailable:embedding:semantic_embedding_transport_unavailable:TEI unavailable",
        unavailable_until: null,
        embedding_calls: 1,
        accepted_candidates: 0,
        rejected_candidates: 0,
        candidate_hit_rate: 0,
        candidate_acceptance_rate: 0,
        semantic_reuse_potential_rate: 0,
        semantic_reuse_rate: 0,
        false_semantic_hit_rate: 0,
        components_considered: 0,
        components_reusable: 0,
        components_reused: 0,
        components_refreshed: 0,
        components_stale: 0,
        retrieval_calls_avoided: 0,
        tokens_avoided_estimate: 0,
        average_lookup_latency_ms: 0,
        average_embedding_latency_ms: 0,
        average_write_latency_ms: 0,
      }),
    };

    registerGetStats(visibility, stats, semanticCache as any);

    const tool = getTool(tools, "context_stats");
    const result = (await tool.handler()) as ToolResult;
    const data = JSON.parse(result.content[0]?.text ?? "{}") as {
      semantic_cache?: Record<string, unknown>;
    };
    expect(data.semantic_cache).toMatchObject({
      stats_contract_version: "semantic-cache-stats/v2",
      incident: {
        dependency: "embedding",
        error_code: "context_semantic_dependency_unavailable",
        cause_code: "semantic_embedding_transport_unavailable",
        unavailable_until: null,
      },
      last_unavailable_dependency: "embedding",
      last_error_code: "context_semantic_dependency_unavailable",
      last_cause_code: "semantic_embedding_transport_unavailable",
      unavailable_until: null,
    });
    expect(result._meta).toMatchObject({
      semantic_cache_stats_contract_version: "semantic-cache-stats/v2",
      semantic_cache_incident: expect.objectContaining({
        dependency: "embedding",
        error_code: "context_semantic_dependency_unavailable",
        cause_code: "semantic_embedding_transport_unavailable",
      }),
    });
    expect(semanticCache.getStats).toHaveBeenCalledTimes(1);
  });

  it("context_stats tool returns stats with uptime and tool counts", async () => {
    const { visibility, registerTool, tools } = createMockServer();
    const stats = new StatsCollector();
    stats.recordCall("context_health", 10);
    stats.recordCall("context_health", 5);
    stats.recordError("context_health");
    stats.recordPack(100);

    registerGetStats(visibility, stats);

    expect(registerTool).toHaveBeenCalledWith(
      "context_stats",
      expect.objectContaining({ description: expect.any(String) }),
      expect.any(Function),
    );

    const tool = getTool(tools, "context_stats");
    const result = (await tool.handler()) as ToolResult;
    const data = JSON.parse(result.content[0]?.text ?? "{}") as {
      total_packs_built: number;
      total_tokens_used: number;
      tools: Record<string, { calls: number; errors: number; total_latency_ms: number }>;
    };
    expect(data.total_packs_built).toBe(1);
    expect(data.total_tokens_used).toBe(100);
    expect(data.tools.context_health).toEqual({ calls: 2, errors: 1, total_latency_ms: 15 });
  });
  it("returns compact context by default when a reference store is available", async () => {
    const { visibility, tools } = createMockServer();
    const packFixture = {
      task_analysis: analyzeTask("optimize cache context engine"),
      previous_decisions: [{ id: "d1", title: "Cache", content: "x".repeat(2000) }],
      symbols: [{ qualified_name: "pkg.Foo", file: "foo.ts", lines: "1-10" }],
      architecture: "architecture ".repeat(500),
      static_artifacts: [],
      summaries: [],
      dependencies: { callers: [], callees: [], tests: [] },
      external_docs: [],
      metadata: {
        total_tokens: 2000,
        budget: 18000,
        sources_queried: [],
        cache_hit: true,
        generated_at: "2026-08-15T00:00:00.000Z",
        warnings: [],
      },
    };
    const builder = { buildWithRaw: vi.fn().mockResolvedValue({ pack: packFixture, rawPack: packFixture }) };
    const references = {
      put: vi.fn((source: string, content: unknown) => ({
        ref: `ctxref:${source}`,
        source,
        token_cost: JSON.stringify(content).length,
      })),
      putPack: vi.fn().mockReturnValue("ctxpack:abc"),
    };
    const stats = new StatsCollector();

    registerGetTaskContext(
      visibility,
      builder as unknown as ContextPackBuilder,
      references as unknown as ContextReferenceStore,
      stats,
    );

    const tool = getTool(tools, "context_get_task_context");
    const result = (await tool.handler({ task: "optimize cache context engine" })) as ToolResult;
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      pack_id: string;
      references: Array<{ source: string }>;
      metadata: { delivery_mode: string; full_tokens: number; delivered_tokens: number };
    };
    expect(payload.pack_id).toBe("ctxpack:abc");
    expect(payload.metadata.delivery_mode).toBe("compact");
    expect(payload.references.some((reference) => reference.source === "architecture")).toBe(true);
    expect(payload.metadata.delivered_tokens).toBeLessThan(payload.metadata.full_tokens);
    expect(stats.getStats().delivery.compact_calls).toBe(1);
  });

  it("registers context_resolve and returns a stored content reference", async () => {
    const { visibility, tools } = createMockServer();
    const stored = {
      ref: "ctxref:abc",
      source: "architecture",
      content: "full architecture",
      created_at: "2026-08-15T00:00:00.000Z",
    };
    const references = {
      resolveWithMeta: vi.fn().mockReturnValue({ value: stored, tier: "l1" }),
    };

    registerResolveContext(visibility, references as unknown as ContextReferenceStore);

    const tool = getTool(tools, "context_resolve");
    const result = (await tool.handler({ ref: "ctxref:abc" })) as ToolResult;
    expect(references.resolveWithMeta).toHaveBeenCalledWith("ctxref:abc");
    expect(JSON.parse(result.content[0]?.text ?? "{}").content).toBe("full architecture");
    expect((result as ToolResult & { _meta: Record<string, unknown> })._meta).toMatchObject({
      status: "cache-hit-reference-l1",
      cache_hit: true,
      cache_tier: "l1",
    });
  });

  it("surfaces accurate L1 pack hit metadata and logs it at info", async () => {
    const stats = new StatsCollector();
    const { visibility, tools, sendLoggingMessage } = createMockServer(stats);
    const packFixture = makePack({ cacheHit: true, cacheTier: "l1", componentHits: 1 });
    const builder = { buildWithRaw: vi.fn().mockResolvedValue({ pack: packFixture, rawPack: packFixture }) };

    registerGetTaskContext(visibility, builder as unknown as ContextPackBuilder, undefined, stats);
    const tool = getTool(tools, "context_get_task_context");
    const result = (await tool.handler({ task: "implement auth cache", mode: "full" })) as ToolResult & {
      _meta: Record<string, unknown>;
    };

    expect(result._meta).toMatchObject({
      status: "cache-hit-l1",
      cache_hit: true,
      cache_tier: "l1",
      component_cache: expect.objectContaining({ hits: 1 }),
    });
    expect(sendLoggingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        data: expect.objectContaining({ status: "cache-hit-l1" }),
      }),
    );
    expect(stats.getStats().tools.context_get_task_context?.calls).toBe(1);
    expect(stats.getStats().delivery.pack_cache_l1_hits).toBe(1);
  });

  it("surfaces pack miss at info with component-cache outcomes", async () => {
    const { visibility, tools, sendLoggingMessage } = createMockServer();
    const packFixture = makePack({ cacheHit: false, componentHits: 2, componentMisses: 1 });
    const builder = { buildWithRaw: vi.fn().mockResolvedValue({ pack: packFixture, rawPack: packFixture }) };

    registerGetTaskContext(visibility, builder as unknown as ContextPackBuilder);
    const tool = getTool(tools, "context_get_task_context");
    const result = (await tool.handler({ task: "implement auth cache", mode: "full" })) as ToolResult & {
      _meta: Record<string, unknown>;
    };

    expect(result._meta).toMatchObject({
      status: "cache-miss",
      cache_hit: false,
      component_cache: expect.objectContaining({ hits: 2, misses: 1 }),
    });
    expect(sendLoggingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        data: expect.objectContaining({ status: "cache-miss" }),
      }),
    );
  });

});
