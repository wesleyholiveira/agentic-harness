import { describe, expect, it, vi } from "vitest";
import { CBMAdapter } from "../src/cbm-adapter";

describe("CBMAdapter", () => {
  describe("searchSymbols", () => {
    it("parses groups/rows into qualified_name = qn_prefix + '.' + name", async () => {
      const mockOutput = JSON.stringify({
        total: 2,
        count: 2,
        cols: ["name", "label", "lines", "in", "out"],
        groups: [
          {
            qn_prefix: "D-proj.packages.cbm-adapter.src.cbm-adapter",
            file: "packages/cbm-adapter/src/cbm-adapter.ts",
            rows: [
              ["CBMAdapter", "Class", "10-61", 1, 0],
              ["runCli", "Method", "22-30", 2, 1],
            ],
          },
          {
            qn_prefix: "D-proj.packages.cbm-adapter.src.types",
            file: "packages/cbm-adapter/src/types.ts",
            rows: [["SymbolSearchResult", "Interface", "1-8", 0, 3]],
          },
        ],
        has_more: false,
      });

      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      vi.spyOn(adapter, "runCli").mockResolvedValue(mockOutput);

      const results = await adapter.searchSymbols(".*cbm-adapter.*");

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({
        qualified_name: "D-proj.packages.cbm-adapter.src.cbm-adapter.CBMAdapter",
        label: "Class",
        file: "packages/cbm-adapter/src/cbm-adapter.ts",
        lines: "10-61",
        in_degree: 1,
        out_degree: 0,
      });
      expect(results[2]?.qualified_name).toBe("D-proj.packages.cbm-adapter.src.types.SymbolSearchResult");
      expect(results[2]?.out_degree).toBe(3);
    });

    it("parses current search_graph results output", async () => {
      const mockOutput = JSON.stringify({
        total: 1,
        results: [{
          name: "CBMAdapter",
          qualified_name: "D-proj.packages.cbm-adapter.src.cbm-adapter.CBMAdapter",
          label: "Class",
          file_path: "packages/cbm-adapter/src/cbm-adapter.ts",
          start_line: 10,
          end_line: 61,
          in_degree: 1,
          out_degree: 2,
        }],
      });
      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      vi.spyOn(adapter, "runCli").mockResolvedValue(mockOutput);

      await expect(adapter.searchSymbols(".*CBMAdapter.*")).resolves.toEqual([{
        qualified_name: "D-proj.packages.cbm-adapter.src.cbm-adapter.CBMAdapter",
        label: "Class",
        file: "packages/cbm-adapter/src/cbm-adapter.ts",
        lines: "10-61",
        in_degree: 1,
        out_degree: 2,
      }]);
    });

    it("passes --format json and --project to the CLI", async () => {
      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      const spy = vi
        .spyOn(adapter, "runCli")
        .mockResolvedValue(JSON.stringify({ total: 0, count: 0, cols: [], groups: [], has_more: false }));

      await adapter.searchSymbols(".*Foo.*");

      const args = spy.mock.calls[0]?.[0];
      expect(args).toContain("--format");
      expect(args).toContain("json");
      expect(args).toContain("--project");
      expect(args).toContain("test-project");
    });

    it("returns an empty array when there are no groups", async () => {
      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      vi.spyOn(adapter, "runCli").mockResolvedValue(
        JSON.stringify({ total: 0, count: 0, cols: [], groups: [], has_more: false }),
      );

      const results = await adapter.searchSymbols(".*Nonexistent.*");
      expect(results).toEqual([]);
    });

    it("throws on invalid JSON output", async () => {
      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      vi.spyOn(adapter, "runCli").mockResolvedValue("not json");

      await expect(adapter.searchSymbols(".*test.*")).rejects.toThrow();
    });
  });

  describe("getArchitecture", () => {
    it("returns the raw text tree without attempting to parse it", async () => {
      const rawTree = [
        "boundaries: 10  (cols: from to calls)",
        "  ml str 673",
        "layers: 13  (cols: name layer reason)",
        "clusters: 12  (cols: id label members cohesion top_nodes packages edge_types)",
      ].join("\n");

      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      vi.spyOn(adapter, "runCli").mockResolvedValue(rawTree);

      const result = await adapter.getArchitecture();

      expect(typeof result).toBe("string");
      expect(result).toBe(rawTree);
    });

    it("does not pass --format json (CLI returns text only)", async () => {
      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      const spy = vi.spyOn(adapter, "runCli").mockResolvedValue("boundaries: 0");

      await adapter.getArchitecture();

      const args = spy.mock.calls[0]?.[0];
      expect(args).toContain("get_architecture");
      expect(args).not.toContain("--format");
    });
  });

  describe("tracePath", () => {
    it("parses inbound (callers) output with callers_total", async () => {
      const mockOutput = JSON.stringify({
        function: "CBMAdapter",
        direction: "inbound",
        callers_total: 2,
        callers: {
          cols: ["name", "hop"],
          groups: [
            {
              qn_prefix: "pkg.main",
              file: "src/main.ts",
              rows: [
                ["run", 1],
                ["boot", 2],
              ],
            },
          ],
        },
      });

      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      vi.spyOn(adapter, "runCli").mockResolvedValue(mockOutput);

      const result = await adapter.tracePath("CBMAdapter", "inbound");

      expect(result.direction).toBe("inbound");
      expect(result.total).toBe(2);
      expect(result.nodes).toEqual([
        { qualified_name: "pkg.main.run", label: "", file: "src/main.ts", lines: "", depth: 1 },
        { qualified_name: "pkg.main.boot", label: "", file: "src/main.ts", lines: "", depth: 2 },
      ]);
    });

    it("parses outbound (callees) output with callees_total", async () => {
      const mockOutput = JSON.stringify({
        function: "CBMAdapter",
        direction: "outbound",
        callees_total: 1,
        callees: {
          cols: ["name", "hop"],
          groups: [
            {
              qn_prefix: "pkg.adapter",
              file: "src/adapter.ts",
              rows: [["runCli", 1]],
            },
          ],
        },
      });

      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      vi.spyOn(adapter, "runCli").mockResolvedValue(mockOutput);

      const result = await adapter.tracePath("CBMAdapter", "outbound");

      expect(result.direction).toBe("outbound");
      expect(result.total).toBe(1);
      expect(result.nodes).toEqual([
        { qualified_name: "pkg.adapter.runCli", label: "", file: "src/adapter.ts", lines: "", depth: 1 },
      ]);
    });

    it("passes --format json to the CLI", async () => {
      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      const spy = vi.spyOn(adapter, "runCli").mockResolvedValue(
        JSON.stringify({
          function: "f",
          direction: "inbound",
          callers_total: 0,
          callers: { cols: [], groups: [] },
        }),
      );

      await adapter.tracePath("f", "inbound", 5);

      const args = spy.mock.calls[0]?.[0];
      expect(args).toContain("--format");
      expect(args).toContain("json");
      expect(args).toContain("--depth");
      expect(args).toContain("5");
    });
  });

  describe("getSnippet", () => {
    it("maps source -> code, file_path -> file, start_line-end_line -> lines", async () => {
      const mockOutput = JSON.stringify({
        name: "CBMAdapter",
        qualified_name: "D-proj.packages.cbm-adapter.src.cbm-adapter.CBMAdapter",
        label: "Class",
        file_path: "D:/proj/packages/cbm-adapter/src/cbm-adapter.ts",
        start_line: 10,
        end_line: 61,
        source: "export class CBMAdapter { ... }",
        callers: 1,
        callees: 0,
      });

      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      vi.spyOn(adapter, "runCli").mockResolvedValue(mockOutput);

      const result = await adapter.getSnippet("CBMAdapter");

      expect(result).toEqual({
        qualified_name: "D-proj.packages.cbm-adapter.src.cbm-adapter.CBMAdapter",
        code: "export class CBMAdapter { ... }",
        file: "D:/proj/packages/cbm-adapter/src/cbm-adapter.ts",
        lines: "10-61",
      });
    });
  });

  describe("checkCoverage", () => {
    it("returns covered=true when every path has no_recorded_issue", async () => {
      const mockOutput = JSON.stringify({
        project: "test-project",
        paths: [
          {
            path: "packages/cbm-adapter/src/cbm-adapter.ts",
            status: "no_recorded_issue",
            coverage: [],
          },
        ],
      });

      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      vi.spyOn(adapter, "runCli").mockResolvedValue(mockOutput);

      const result = await adapter.checkCoverage(["packages/cbm-adapter/src/cbm-adapter.ts"]);

      expect(result.covered).toBe(true);
      expect(result.missed_ranges).toEqual([]);
    });

    it("returns covered=false and flattens missed ranges when a path has coverage", async () => {
      const mockOutput = JSON.stringify({
        project: "test-project",
        paths: [
          { path: "a.ts", status: "no_recorded_issue", coverage: [] },
          {
            path: "b.ts",
            status: "partial",
            coverage: [
              {
                path: "b.ts",
                kind: "parse_partial",
                detail: "1-430",
                match: "exact",
                ranges: [{ start: 1, end: 430 }],
              },
            ],
          },
        ],
      });

      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      vi.spyOn(adapter, "runCli").mockResolvedValue(mockOutput);

      const result = await adapter.checkCoverage(["a.ts", "b.ts"]);

      expect(result.covered).toBe(false);
      expect(result.missed_ranges).toEqual(["1-430"]);
    });

    it("passes --paths as a JSON array to the CLI", async () => {
      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      const spy = vi
        .spyOn(adapter, "runCli")
        .mockResolvedValue(JSON.stringify({ project: "test-project", paths: [] }));

      await adapter.checkCoverage(["a.ts", "b.ts"]);

      const args = spy.mock.calls[0]?.[0];
      expect(args).toContain("--paths");
      expect(args).toContain(JSON.stringify(["a.ts", "b.ts"]));
    });
  });

  describe("probe", () => {
    it("uses index_status directly for the configured project without enumerating projects", async () => {
      const adapter = new CBMAdapter("actual-project", "codebase-memory-mcp", "D:/repo", { transport: "cli" });
      const spy = vi.spyOn(adapter, "runCli")
        .mockResolvedValueOnce(JSON.stringify({ project: "actual-project", nodes: 10, edges: 20, status: "ready" }));

      await expect(adapter.probe(1000)).resolves.toEqual({
        project: "actual-project", nodes: 10, edges: 20, status: "ready",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toContain("index_status");
      expect(spy.mock.calls[0]?.[0]).toContain("actual-project");
    });

    it("falls back to list_projects only after index_status fails and switches by repository root", async () => {
      const adapter = new CBMAdapter("stale-project", "codebase-memory-mcp", "D:/repo", { transport: "cli" });
      const spy = vi.spyOn(adapter, "runCli")
        .mockRejectedValueOnce(new Error("project not found"))
        .mockResolvedValueOnce(JSON.stringify([{ name: "actual-project", root_path: "D:/repo", nodes: 10, edges: 20 }]))
        .mockResolvedValueOnce(JSON.stringify({ project: "actual-project", nodes: 10, edges: 20, status: "ready" }));

      await expect(adapter.probe(1000)).resolves.toEqual({
        project: "actual-project", nodes: 10, edges: 20, status: "ready",
      });
      expect(adapter.getRuntimeConfig().project).toBe("actual-project");
      expect(spy.mock.calls[0]?.[0]).toContain("index_status");
      expect(spy.mock.calls[1]?.[0]).toEqual(["cli", "list_projects"]);
      expect(spy.mock.calls[2]?.[0]).toContain("actual-project");
    });


    it("bootstraps a missing repository index exactly once and reuses the discovered project", async () => {
      const adapter = new CBMAdapter("host-project", "codebase-memory-mcp", "/workspace", { transport: "cli" });
      const spy = vi.spyOn(adapter, "runCli")
        .mockRejectedValueOnce(new Error("project not found or not indexed"))
        .mockResolvedValueOnce("[]")
        .mockResolvedValueOnce(JSON.stringify({ status: "indexed" }))
        .mockResolvedValueOnce(JSON.stringify([{ name: "workspace", root_path: "/workspace", nodes: 42, edges: 84 }]))
        .mockResolvedValueOnce(JSON.stringify({ project: "workspace", nodes: 42, edges: 84, status: "ready" }));

      await expect(adapter.ensureReady({ probeTimeoutMs: 1_000, indexTimeoutMs: 5_000, mode: "full" })).resolves.toEqual({
        indexed: true,
        status: { project: "workspace", nodes: 42, edges: 84, status: "ready" },
      });

      const indexCall = spy.mock.calls.find(([args]) => args.includes("index_repository"));
      expect(indexCall?.[0]).toContain("--repo-path");
      expect(indexCall?.[0]).toContain("/workspace");
      expect(indexCall?.[0]).toContain("--mode");
      expect(indexCall?.[0]).toContain("full");
      expect(adapter.getRuntimeConfig().project).toBe("workspace");
    });

  });

  describe("getIndexStatus", () => {
    it("returns project, nodes, edges and status", async () => {
      const mockOutput = JSON.stringify({
        project: "test-project",
        nodes: 34613,
        edges: 117217,
        status: "ready",
      });

      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      vi.spyOn(adapter, "runCli").mockResolvedValue(mockOutput);

      const result = await adapter.getIndexStatus();

      expect(result).toEqual({
        project: "test-project",
        nodes: 34613,
        edges: 117217,
        status: "ready",
      });
    });

    it("retries protocol-shape failures with backward-compatible inline JSON", async () => {
      const adapter = new CBMAdapter("test-project", undefined, undefined, { transport: "cli" });
      const spy = vi.spyOn(adapter, "runCli")
        .mockRejectedValueOnce(new Error("Cannot read properties of undefined (reading 'trim')"))
        .mockResolvedValueOnce(JSON.stringify({ project: "test-project", nodes: 1, edges: 2, status: "ready" }));

      await expect(adapter.getIndexStatus()).resolves.toMatchObject({ project: "test-project", status: "ready" });
      expect(spy.mock.calls[1]?.[0]).toEqual(["cli", "index_status", JSON.stringify({ project: "test-project" })]);
    });
  });

  describe("persistent MCP transport", () => {
    it("requests explicit JSON for search_graph and parses current result shape", async () => {
      const callTool = vi.fn().mockResolvedValue(JSON.stringify({
        total: 1,
        results: [{
          name: "runtimeV2Canary",
          qualified_name: "D-proj.runtime.runtimeV2Canary",
          label: "Function",
          file_path: ".agents/runtime/canary.mjs",
          start_line: 1,
          end_line: 3,
          in_degree: 0,
          out_degree: 0,
        }],
      }));
      const persistentClient = {
        callTool,
        close: vi.fn().mockResolvedValue(undefined),
        getDiagnostics: () => ({ state: "connected" as const, pid: 321, reconnects: 0, calls: callTool.mock.calls.length }),
      };
      const adapter = new CBMAdapter("test-project", "codebase-memory-mcp", "D:/repo", {
        transport: "persistent-mcp", persistentClient,
      });

      const results = await adapter.searchSymbols("runtimeV2Canary");

      expect(callTool).toHaveBeenCalledWith(
        "search_graph",
        { project: "test-project", name_pattern: "runtimeV2Canary", limit: 50, format: "json" },
        expect.any(Number),
      );
      expect(results[0]?.qualified_name).toBe("D-proj.runtime.runtimeV2Canary");
    });


    it("falls back to one-shot CLI when persistent MCP transport closes", async () => {
      const callTool = vi.fn().mockRejectedValue(
        new Error("cbm_mcp_failed:index_status:cbm_mcp_connect_failed:MCP error -32000: Connection closed"),
      );
      const persistentClient = {
        callTool,
        close: vi.fn().mockResolvedValue(undefined),
        getDiagnostics: () => ({ state: "disconnected" as const, pid: null, reconnects: 1, calls: 0 }),
      };
      const adapter = new CBMAdapter("test-project", "codebase-memory-mcp", "D:/repo", {
        transport: "persistent-mcp",
        persistentClient,
      });
      const cli = vi.spyOn(adapter, "runCli").mockResolvedValue(
        JSON.stringify({ project: "test-project", nodes: 10, edges: 20, status: "ready" }),
      );

      const status = await adapter.getIndexStatus();

      expect(status.status).toBe("ready");
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(cli).toHaveBeenCalledWith(
        ["cli", "index_status", "--project", "test-project"],
        expect.any(Number),
      );
      expect(adapter.getRuntimeConfig().persistentCliFallbacks).toBe(1);
    });

    it("routes repeated tool calls through the same injected MCP client instead of spawning the CLI", async () => {
      const callTool = vi.fn()
        .mockResolvedValueOnce(JSON.stringify({ project: "test-project", nodes: 10, edges: 20, status: "ready" }))
        .mockResolvedValueOnce(JSON.stringify({ project: "test-project", nodes: 10, edges: 20, status: "ready" }));
      const persistentClient = {
        callTool,
        close: vi.fn().mockResolvedValue(undefined),
        getDiagnostics: () => ({ state: "connected" as const, pid: 123, reconnects: 0, calls: callTool.mock.calls.length }),
      };
      const adapter = new CBMAdapter("test-project", "codebase-memory-mcp", "D:/repo", {
        transport: "persistent-mcp",
        persistentClient,
      });
      const cli = vi.spyOn(adapter, "runCli");

      await adapter.getIndexStatus();
      await adapter.getIndexStatus();

      expect(callTool).toHaveBeenCalledTimes(2);
      expect(callTool.mock.calls[0]?.[0]).toBe("index_status");
      expect(callTool.mock.calls[0]?.[1]).toEqual({ project: "test-project" });
      expect(cli).not.toHaveBeenCalled();
      expect(adapter.getRuntimeConfig().transport).toBe("persistent-mcp");
      expect(adapter.getRuntimeConfig().persistent?.pid).toBe(123);
    });
  });

});
