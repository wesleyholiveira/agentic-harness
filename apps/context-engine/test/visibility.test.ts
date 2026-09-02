import { describe, expect, it, vi } from "vitest";
import { SetLevelRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoggingLevel } from "../src/visibility.js";
import { Visibility } from "../src/visibility.js";
import type { StatsCollector } from "../src/stats.js";

interface EnrichedToolResult {
  content: unknown[];
  _meta: Record<string, unknown>;
}

describe("Visibility.satisfiesLevel", () => {
  it("returns true when message level equals client level (debug)", () => {
    const v = new Visibility(makeServer(), makeStats());
    expect(v.satisfiesLevel("debug")).toBe(true);
  });

  it("returns true when message level is higher than client level (info vs debug)", () => {
    const v = new Visibility(makeServer(), makeStats());
    expect(v.satisfiesLevel("info")).toBe(true);
  });

  it("returns false when message level is lower than client level (debug vs warning)", () => {
    const v = new Visibility(makeServer(), makeStats());
    v.setClientLevel("warning");
    expect(v.satisfiesLevel("debug")).toBe(false);
  });

  it("handles all RFC 5424 levels in correct ordering", () => {
    const ordered: LoggingLevel[] = [
      "debug",
      "info",
      "notice",
      "warning",
      "error",
      "critical",
      "alert",
      "emergency",
    ];
    const v = new Visibility(makeServer(), makeStats());
    v.setClientLevel("warning");
    for (const [index, level] of ordered.entries()) {
      expect(v.satisfiesLevel(level)).toBe(index >= ordered.indexOf("warning"));
    }
  });
});

describe("Visibility.emit", () => {
  it("calls sendLoggingMessage when level satisfies client level", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const v = new Visibility(
      { server: { sendLoggingMessage, setRequestHandler: vi.fn() } } as unknown as McpServer,
      makeStats(),
    );
    await v.emit("debug", { event: "start" });
    expect(sendLoggingMessage).toHaveBeenCalledWith({
      level: "debug",
      logger: "context-engine",
      data: { event: "start" },
    });
  });

  it("does NOT call sendLoggingMessage when level is below client level", async () => {
    const sendLoggingMessage = vi.fn();
    const v = new Visibility(
      { server: { sendLoggingMessage, setRequestHandler: vi.fn() } } as unknown as McpServer,
      makeStats(),
    );
    v.setClientLevel("warning");
    await v.emit("debug", { event: "start" });
    await v.emit("info", { event: "start" });
    expect(sendLoggingMessage).not.toHaveBeenCalled();
  });

  it("calls sendLoggingMessage when level is at or above client level (info vs warning)", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const v = new Visibility(
      { server: { sendLoggingMessage, setRequestHandler: vi.fn() } } as unknown as McpServer,
      makeStats(),
    );
    v.setClientLevel("warning");
    await v.emit("warning", { event: "error" });
    await v.emit("error", { event: "error" });
    expect(sendLoggingMessage).toHaveBeenCalledTimes(2);
  });

  it("swallows sendLoggingMessage rejection without throwing", async () => {
    const sendLoggingMessage = vi.fn().mockRejectedValue(new Error("client disconnected"));
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const v = new Visibility(
      { server: { sendLoggingMessage, setRequestHandler: vi.fn() } } as unknown as McpServer,
      makeStats(),
    );
    await expect(v.emit("debug", { event: "start" })).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });
});

// Test helpers (exported at bottom of file)
function makeServer(): McpServer {
  return {
    server: {
      sendLoggingMessage: vi.fn(),
      setRequestHandler: vi.fn(),
    },
  } as unknown as McpServer;
}
function makeStats(): StatsCollector {
  return { recordCall: vi.fn(), recordError: vi.fn() } as unknown as StatsCollector;
}

describe("Visibility.registerVisibleTool — happy path", () => {
  it("registers a tool whose handler emits start + end logs and enriches result", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const stats = makeStats();
    const tools = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const fakeServer = {
      server: { sendLoggingMessage, setRequestHandler: vi.fn() },
      registerTool: (_name: string, _config: unknown, handler: (...a: unknown[]) => Promise<unknown>) => {
        tools.set(_name, handler);
      },
    };
    const v = new Visibility(fakeServer as unknown as McpServer, stats);

    v.registerVisibleTool(
      "test_tool",
      { description: "Test tool", inputSchema: {} },
      async (args: { x: number }) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
    );

    const handler = tools.get("test_tool")!;
    const result = (await handler({ x: 42 })) as unknown as EnrichedToolResult;

    // 2 logs: start + end
    expect(sendLoggingMessage).toHaveBeenCalledTimes(2);
    expect(sendLoggingMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        level: "debug",
        data: expect.objectContaining({ event: "start", tool: "test_tool" }),
      }),
    );
    expect(sendLoggingMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        level: "debug",
        data: expect.objectContaining({ event: "end", tool: "test_tool" }),
      }),
    );

    // _meta block present
    expect(result._meta).toMatchObject({
      tool: "test_tool",
      ms: expect.any(Number),
    });

    // stats recorded
    expect(stats.recordCall).toHaveBeenCalledWith("test_tool", expect.any(Number));
    expect(stats.recordError).not.toHaveBeenCalled();
  });

  it("passes args through to the handler unchanged", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const stats = makeStats();
    const server = { server: { sendLoggingMessage, setRequestHandler: vi.fn() }, registerTool: vi.fn() };
    const v = new Visibility(server as unknown as McpServer, stats);

    let receivedArgs: unknown;
    v.registerVisibleTool("test_tool", { description: "Test tool", inputSchema: {} }, async (args) => {
      receivedArgs = args;
      return { content: [{ type: "text", text: "" }] };
    });

    const handler = server.registerTool.mock.calls[0]![2];
    await handler({ task: "x", budget: 18000 });
    expect(receivedArgs).toEqual({ task: "x", budget: 18000 });
  });
});

describe("Visibility.registerVisibleTool — error path", () => {
  it("emits warning log and rethrows when handler throws", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const stats = makeStats();
    const server = { server: { sendLoggingMessage, setRequestHandler: vi.fn() }, registerTool: vi.fn() };
    const v = new Visibility(server as unknown as McpServer, stats);

    v.registerVisibleTool("test_tool", { description: "Test tool", inputSchema: {} }, async () => {
      throw new Error("CBM unavailable");
    });

    const handler = server.registerTool.mock.calls[0]![2];
    await expect(handler({})).rejects.toThrow("CBM unavailable");

    expect(sendLoggingMessage).toHaveBeenCalledTimes(2); // start + error
    expect(sendLoggingMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        level: "warning",
        data: expect.objectContaining({
          event: "error",
          tool: "test_tool",
          error: expect.stringContaining("CBM unavailable"),
        }),
      }),
    );

    expect(stats.recordError).toHaveBeenCalledWith("test_tool");
    expect(stats.recordCall).not.toHaveBeenCalled();
  });
});

describe("Visibility.registerVisibleTool — extractMeta", () => {
  it("default extractMeta produces _meta with only tool + ms", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const stats = makeStats();
    const server = { server: { sendLoggingMessage, setRequestHandler: vi.fn() }, registerTool: vi.fn() };
    const v = new Visibility(server as unknown as McpServer, stats);

    v.registerVisibleTool("test_tool", { description: "Test tool", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const handler = server.registerTool.mock.calls[0]![2];
    const result = (await handler({})) as unknown as EnrichedToolResult;

    expect(result._meta).toEqual({
      tool: "test_tool",
      ms: expect.any(Number),
    });
    expect(Object.keys(result._meta)).toEqual(["tool", "ms"]);
  });

  it("custom extractMeta parses pack JSON and surfaces cache_hit/sources/tokens", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const stats = makeStats();
    const server = { server: { sendLoggingMessage, setRequestHandler: vi.fn() }, registerTool: vi.fn() };
    const v = new Visibility(server as unknown as McpServer, stats);

    const pack = {
      metadata: {
        cache_hit: true,
        sources_queried: ["memory", "cbm"],
        total_tokens: 14200,
        budget: 18000,
        warnings: [],
      },
    };

    v.registerVisibleTool(
      "test_tool",
      { description: "Test tool", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: JSON.stringify(pack) }] }),
      (result: unknown) => {
        const r = result as { content: Array<{ type: string; text: string }> };
        const first = r.content[0];
        if (!first) throw new Error("expected text content");
        const parsed = JSON.parse(first.text);
        return {
          status: parsed.metadata.cache_hit ? "cache-hit-l2" : "cache-miss",
          sources: parsed.metadata.sources_queried,
          cache_hit: parsed.metadata.cache_hit,
          tokens: parsed.metadata.total_tokens,
          budget: parsed.metadata.budget,
          warnings: parsed.metadata.warnings,
        };
      },
    );

    const handler = server.registerTool.mock.calls[0]![2];
    const result = (await handler({})) as unknown as EnrichedToolResult;

    expect(result._meta).toMatchObject({
      tool: "test_tool",
      status: "cache-hit-l2",
      sources: ["memory", "cbm"],
      cache_hit: true,
      tokens: 14200,
      budget: 18000,
      warnings: [],
    });
  });
});

describe("Visibility.registerVisibleTool — existing _meta", () => {
  it("preserves handler metadata and makes tool/ms authoritative", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const stats = makeStats();
    const server = { server: { sendLoggingMessage, setRequestHandler: vi.fn() }, registerTool: vi.fn() };
    const v = new Visibility(server as unknown as McpServer, stats);

    v.registerVisibleTool("test_tool", { description: "Test tool", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "ok" }],
      _meta: { status: "cache-hit-l1", cache_tier: "l1", tool: "wrong", ms: 99999 },
    }));

    const handler = server.registerTool.mock.calls[0]![2];
    const result = (await handler({})) as unknown as EnrichedToolResult;
    expect(result._meta).toMatchObject({
      status: "cache-hit-l1",
      cache_tier: "l1",
      tool: "test_tool",
      ms: expect.any(Number),
    });
    expect(result._meta.ms).not.toBe(99999);
  });

  it("does not fail a successful tool when metadata extraction throws", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const stats = makeStats();
    const server = { server: { sendLoggingMessage, setRequestHandler: vi.fn() }, registerTool: vi.fn() };
    const v = new Visibility(server as unknown as McpServer, stats);

    v.registerVisibleTool(
      "test_tool",
      { description: "Test tool", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      () => {
        throw new Error("bad telemetry parser");
      },
    );

    const handler = server.registerTool.mock.calls[0]![2];
    await expect(handler({})).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
      _meta: { tool: "test_tool", ms: expect.any(Number) },
    });
    expect(sendLoggingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        data: expect.objectContaining({ event: "meta-error" }),
      }),
    );
  });
});

describe("Visibility.levelFor policy", () => {
  it("returns info when status starts with cache-hit-l2", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const stats = makeStats();
    const server = { server: { sendLoggingMessage, setRequestHandler: vi.fn() }, registerTool: vi.fn() };
    const v = new Visibility(server as unknown as McpServer, stats);

    v.registerVisibleTool(
      "test_tool",
      { description: "Test tool", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "{}" }] }),
      () => ({ status: "cache-hit-l2" }),
    );

    const handler = server.registerTool.mock.calls[0]![2];
    await handler({});

    expect(sendLoggingMessage).toHaveBeenCalledWith(
      expect.objectContaining({ level: "info", data: expect.objectContaining({ status: "cache-hit-l2" }) }),
    );
  });

  it("returns info when status is cache-miss so misses are visible in the TUI", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const stats = makeStats();
    const server = { server: { sendLoggingMessage, setRequestHandler: vi.fn() }, registerTool: vi.fn() };
    const v = new Visibility(server as unknown as McpServer, stats);

    v.registerVisibleTool(
      "test_tool",
      { description: "Test tool", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "{}" }] }),
      () => ({ status: "cache-miss" }),
    );

    const handler = server.registerTool.mock.calls[0]![2];
    await handler({});

    expect(sendLoggingMessage).toHaveBeenCalledWith(
      expect.objectContaining({ level: "info", data: expect.objectContaining({ status: "cache-miss" }) }),
    );
  });

  it("elevates cache outcomes with warnings to warning", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const stats = makeStats();
    const server = { server: { sendLoggingMessage, setRequestHandler: vi.fn() }, registerTool: vi.fn() };
    const v = new Visibility(server as unknown as McpServer, stats);

    v.registerVisibleTool(
      "test_tool",
      { description: "Test tool", inputSchema: {} },
      async () => ({
        content: [{ type: "text", text: "{}" }],
        _meta: { status: "cache-hit-l1", warnings: ["context7_unavailable"] },
      }),
    );

    const handler = server.registerTool.mock.calls[0]![2];
    await handler({});

    expect(sendLoggingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        data: expect.objectContaining({ warnings: ["context7_unavailable"] }),
      }),
    );
  });

  it("returns debug when no status (no extractMeta)", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const stats = makeStats();
    const server = { server: { sendLoggingMessage, setRequestHandler: vi.fn() }, registerTool: vi.fn() };
    const v = new Visibility(server as unknown as McpServer, stats);

    v.registerVisibleTool("test_tool", { description: "Test tool", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "{}" }],
    }));

    const handler = server.registerTool.mock.calls[0]![2];
    await handler({});

    const endLog = sendLoggingMessage.mock.calls.find((c) => c[0].data.event === "end");
    if (!endLog) throw new Error("expected an end log");
    expect(endLog[0].level).toBe("debug");
  });
});

describe("Visibility — logging/setLevel handler", () => {
  it("registers a setRequestHandler for logging/setLevel and updates clientLevel", async () => {
    const setRequestHandler = vi.fn();
    const v = new Visibility(
      { server: { sendLoggingMessage: vi.fn(), setRequestHandler } } as unknown as McpServer,
      makeStats(),
    );

    // constructor should have registered the handler with the SDK schema
    expect(setRequestHandler).toHaveBeenCalledWith(SetLevelRequestSchema, expect.any(Function));

    // invoke the registered handler
    const setLevelCall = setRequestHandler.mock.calls[0];
    if (!setLevelCall) throw new Error("setRequestHandler was not called");
    const handler = setLevelCall[1];
    await handler({ params: { level: "warning" } }, {});

    expect(v.satisfiesLevel("debug")).toBe(false);
    expect(v.satisfiesLevel("warning")).toBe(true);
    expect(v.satisfiesLevel("error")).toBe(true);
  });
});
