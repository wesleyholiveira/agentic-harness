import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CBMAdapter, SymbolSearchResult } from "@agent-harness/cbm-adapter";
import { L1SessionCache, TieredContextCache } from "@agent-harness/context-cache";
import { TestPersistentCache } from "./test-persistent-cache";
import type { Context7Adapter } from "@agent-harness/context7-adapter";
import type { Decision, ProjectMemory } from "@agent-harness/project-memory";
import type { SummaryManager } from "@agent-harness/summary-manager";
import { ContextPackBuilder } from "../src/context-pack-builder";
import { StaticArtifactCache } from "../src/static-artifact-cache";

function makeSymbol(name: string, file = "src/foo.ts"): SymbolSearchResult {
  return {
    qualified_name: name,
    label: "Function",
    file,
    lines: "1-10",
    in_degree: 2,
    out_degree: 1,
  };
}

function makeDecision(file = "src/foo.ts"): Decision {
  return {
    id: "d1",
    title: "Use adapter pattern",
    content: "Adapters isolate external tools",
    rationale: "Testability",
    files: [file],
    symbols: ["app.Foo"],
    commit: "abc123",
    created_at: 1700000000000,
  };
}

function makeBuilder(
  overrides: {
    cbm?: Partial<{
      searchSymbols: ReturnType<typeof vi.fn>;
      getArchitecture: ReturnType<typeof vi.fn>;
      getIndexStatus: ReturnType<typeof vi.fn>;
    }>;
    memory?: Partial<{
      getDecisions: ReturnType<typeof vi.fn>;
      getRevision: ReturnType<typeof vi.fn>;
    }>;
    context7?: Partial<{ getDocsByName: ReturnType<typeof vi.fn> }>;
    cache?: TieredContextCache;
    cwd?: string;
    symbolFile?: string;
    staticArtifacts?: StaticArtifactCache | false;
  } = {},
) {
  const symbolFile = overrides.symbolFile ?? "src/foo.ts";
  const cbm = {
    searchSymbols: vi.fn().mockResolvedValue([makeSymbol("app.Foo", symbolFile)]),
    getArchitecture: vi.fn().mockResolvedValue("architecture overview"),
    getIndexStatus: vi.fn().mockResolvedValue({ project: "p", nodes: 10, edges: 20, status: "ready" }),
    ...overrides.cbm,
  };
  const memory = {
    getDecisions: vi.fn().mockResolvedValue([makeDecision(symbolFile)]),
    getRevision: vi.fn().mockResolvedValue("memory:1"),
    ...overrides.memory,
  };
  const summaryManager = {} as SummaryManager;
  const context7 = {
    getDocsByName: vi.fn().mockResolvedValue([{ library: "oauth", query: "caching", content: "docs" }]),
    ...overrides.context7,
  };

  const builderOptions: {
    cache?: TieredContextCache;
    cwd?: string;
    staticArtifacts: StaticArtifactCache | false;
  } = {
    staticArtifacts: overrides.staticArtifacts ?? false,
  };
  if (overrides.cache) builderOptions.cache = overrides.cache;
  if (overrides.cwd) builderOptions.cwd = overrides.cwd;

  const builder = new ContextPackBuilder(
    cbm as unknown as CBMAdapter,
    memory as unknown as ProjectMemory,
    summaryManager,
    context7 as unknown as Context7Adapter,
    builderOptions,
  );

  return { builder, cbm, memory, context7 };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function makeCache(): { cache: TieredContextCache; root: string } {
  const root = mkdtempSync(join(tmpdir(), "context-pack-cache-test-"));
  const cache = new TieredContextCache(new L1SessionCache(60_000), new TestPersistentCache());
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return { cache, root };
}

describe("ContextPackBuilder", () => {
  it("builds a complete context pack from all sources", async () => {
    const { builder, cbm, memory, context7 } = makeBuilder();

    const pack = await builder.build("add OAuth login to auth.ts");

    expect(pack.task_analysis.external_api_needed).toBe(true);
    expect(pack.task_analysis.detected_language).toBe("typescript");
    expect(pack.task_analysis.signature.external_libraries).toContain("oauth");
    expect(pack.previous_decisions).toHaveLength(1);
    expect(pack.symbols).toHaveLength(1);
    expect(pack.architecture).toBe("architecture overview");
    expect(pack.external_docs).toHaveLength(1);
    expect(pack.metadata.sources_queried).toEqual(["memory", "cbm", "architecture", "context7"]);
    expect(pack.metadata.total_tokens).toBeGreaterThan(0);
    expect(pack.metadata.cache_hit).toBe(false);
    expect(pack.metadata.warnings).toEqual([]);
    expect(cbm.searchSymbols).toHaveBeenCalledTimes(1);
    expect(memory.getDecisions).toHaveBeenCalledTimes(1);
    expect(context7.getDocsByName).toHaveBeenCalledWith("oauth", "add OAuth login to auth.ts");
  });

  it("degrades gracefully when CBM is unavailable", async () => {
    const { builder } = makeBuilder({
      cbm: {
        searchSymbols: vi.fn().mockRejectedValue(new Error("down")),
        getArchitecture: vi.fn().mockRejectedValue(new Error("down")),
        getIndexStatus: vi.fn().mockRejectedValue(new Error("down")),
      },
    });

    const pack = await builder.build("rename function foo");

    expect(pack.symbols).toEqual([]);
    expect(pack.architecture).toBe("");
    expect(pack.metadata.warnings).toContain("cbm_unavailable");
    expect(pack.metadata.warnings).toContain("architecture_unavailable");
  });

  it("does not cache degraded raw packs and recovers immediately when CBM returns", async () => {
    const { cache } = makeCache();
    const { builder, cbm } = makeBuilder({
      cache,
      cbm: {
        getIndexStatus: vi
          .fn()
          .mockRejectedValueOnce(new Error("down"))
          .mockResolvedValue({ project: "p", nodes: 10, edges: 20, status: "ready" }),
        searchSymbols: vi
          .fn()
          .mockRejectedValueOnce(new Error("down"))
          .mockResolvedValue([makeSymbol("app.Foo")]),
        getArchitecture: vi
          .fn()
          .mockRejectedValueOnce(new Error("down"))
          .mockResolvedValue("architecture overview"),
      },
    });

    const degraded = await builder.build("rename function foo");
    const recovered = await builder.build("rename function foo");
    const cachedHealthy = await builder.build("rename function foo");

    expect(degraded.metadata.cache_hit).toBe(false);
    expect(degraded.metadata.warnings).toContain("cbm_unavailable");
    expect(degraded.metadata.warnings).toContain("architecture_unavailable");

    expect(recovered.metadata.cache_hit).toBe(false);
    expect(recovered.metadata.warnings).not.toContain("cbm_unavailable");
    expect(recovered.metadata.warnings).not.toContain("architecture_unavailable");
    expect(recovered.symbols).toHaveLength(1);
    expect(recovered.architecture).toBe("architecture overview");

    expect(cachedHealthy.metadata.cache_hit).toBe(true);
    expect(cbm.getIndexStatus).toHaveBeenCalledTimes(2);
    expect(cbm.searchSymbols).toHaveBeenCalledTimes(2);
    expect(cbm.getArchitecture).toHaveBeenCalledTimes(2);
  });

  it("degrades gracefully when memory is unavailable", async () => {
    const { builder } = makeBuilder({
      memory: {
        getDecisions: vi.fn().mockImplementation(() => {
          throw new Error("down");
        }),
      },
    });

    const pack = await builder.build("rename function foo");

    expect(pack.previous_decisions).toEqual([]);
    expect(pack.metadata.warnings).toContain("memory_unavailable");
  });

  it("does not call context7 when no external API is needed", async () => {
    const { builder, context7 } = makeBuilder();

    const pack = await builder.build("rename function calculate total");

    expect(pack.task_analysis.external_api_needed).toBe(false);
    expect(context7.getDocsByName).not.toHaveBeenCalled();
    expect(pack.external_docs).toEqual([]);
  });

  it("returns the second identical build from raw pack cache with zero repeated retrieval", async () => {
    const { cache } = makeCache();
    const { builder, cbm, memory, context7 } = makeBuilder({ cache });

    const first = await builder.build("add OAuth login to auth.ts", 18_000);
    const second = await builder.build("add OAuth login to auth.ts", 18_000);

    expect(first.metadata.cache_hit).toBe(false);
    expect(second.metadata.cache_hit).toBe(true);
    expect(second.metadata.cache_tier).toBe("l1");
    expect(memory.getDecisions).toHaveBeenCalledTimes(1);
    expect(cbm.searchSymbols).toHaveBeenCalledTimes(1);
    expect(cbm.getArchitecture).toHaveBeenCalledTimes(1);
    expect(cbm.getIndexStatus).toHaveBeenCalledTimes(1);
    expect(context7.getDocsByName).toHaveBeenCalledTimes(1);
  });

  it("reuses the same raw pack across different budgets", async () => {
    const { cache } = makeCache();
    const symbols = Array.from({ length: 20 }, (_, index) => makeSymbol(`app.Func${index}`));
    const { builder, cbm, memory } = makeBuilder({
      cache,
      cbm: { searchSymbols: vi.fn().mockResolvedValue(symbols) },
    });

    const generous = await builder.build("refactor authentication module", 18_000);
    const tight = await builder.build("refactor authentication module", 450);

    expect(generous.metadata.cache_hit).toBe(false);
    expect(tight.metadata.cache_hit).toBe(true);
    expect(memory.getDecisions).toHaveBeenCalledTimes(1);
    expect(cbm.searchSymbols).toHaveBeenCalledTimes(1);
    expect(tight.symbols.length).toBeLessThanOrEqual(generous.symbols.length);
  });

  it("invalidates a cached raw pack when a tracked file hash changes", async () => {
    const { cache, root } = makeCache();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/foo.ts"), "export const value = 1;\n");
    const { builder, cbm, memory } = makeBuilder({ cache, cwd: root, symbolFile: "src/foo.ts" });

    await builder.build("refactor authentication module");
    writeFileSync(join(root, "src/foo.ts"), "export const value = 2;\n");
    const second = await builder.build("refactor authentication module");

    expect(second.metadata.cache_hit).toBe(false);
    expect(memory.getDecisions).toHaveBeenCalledTimes(2);
    expect(cbm.searchSymbols).toHaveBeenCalledTimes(2);
    expect(cbm.getArchitecture).toHaveBeenCalledTimes(1);
  });

  it("turns deterministic Portuguese/English paraphrases into the same raw-pack cache hit", async () => {
    const { cache } = makeCache();
    const { builder, cbm } = makeBuilder({ cache });

    await builder.build("optimize cache in the context engine");
    const second = await builder.build("otimizar o caching do context engine");

    expect(second.metadata.cache_hit).toBe(true);
    expect(cbm.searchSymbols).toHaveBeenCalledTimes(1);
    expect(cbm.getArchitecture).toHaveBeenCalledTimes(1);
  });

  it("reuses broad components when nearby tasks differ enough to miss the raw-pack key", async () => {
    const { cache } = makeCache();
    const { builder, cbm, memory } = makeBuilder({ cache });

    await builder.build("optimize cache in the context engine");
    const second = await builder.build("optimize cache retrieval in the context engine");

    expect(second.metadata.cache_hit).toBe(false);
    expect(memory.getDecisions).toHaveBeenCalledTimes(2);
    expect(cbm.searchSymbols).toHaveBeenCalledTimes(1);
    expect(cbm.getArchitecture).toHaveBeenCalledTimes(1);
    expect(second.metadata.component_cache?.hit_sources).toContain("cbm-symbols");
    expect(second.metadata.component_cache?.hit_sources).toContain("architecture");
  });

  it("keeps the complete raw pack available when the requested delivery budget is tight", async () => {
    const { cache } = makeCache();
    const symbols = Array.from({ length: 25 }, (_, index) => makeSymbol(`app.Func${index}`));
    const { builder } = makeBuilder({
      cache,
      cbm: { searchSymbols: vi.fn().mockResolvedValue(symbols) },
    });

    const result = await builder.buildWithRaw("refactor authentication module", 450);

    expect(result.rawPack.symbols).toHaveLength(25);
    expect(result.pack.symbols.length).toBeLessThan(result.rawPack.symbols.length);
    expect(result.rawPack.metadata.raw_pack_cache_key).toBe(result.pack.metadata.raw_pack_cache_key);
  });

  it("adds relevant stable workspace artifacts and invalidates the raw pack immediately when one changes", async () => {
    const { cache, root } = makeCache();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "docs/adr"), { recursive: true });
    mkdirSync(join(root, "docs/specs/context-engine"), { recursive: true });
    writeFileSync(join(root, "src/foo.ts"), "export const value = 1;\n");
    writeFileSync(
      join(root, "docs/adr/0070-context-engine-cache.md"),
      "# Context Engine cache\nUse content-addressed references.\n",
    );
    writeFileSync(
      join(root, "docs/specs/context-engine/PRD.md"),
      "# PRD — Context Engine\nDeterministic retrieval and cache safety.\n",
    );
    const staticArtifacts = new StaticArtifactCache({ cache, cwd: root });
    const { builder, cbm } = makeBuilder({
      cache,
      cwd: root,
      symbolFile: "src/foo.ts",
      staticArtifacts,
    });

    const first = await builder.build("optimize context engine cache");
    const second = await builder.build("optimize context engine cache");

    expect(first.static_artifacts.some((artifact) => artifact.kind === "adr")).toBe(true);
    expect(first.static_artifacts.some((artifact) => artifact.kind === "prd")).toBe(true);
    expect(second.metadata.cache_hit).toBe(true);

    writeFileSync(
      join(root, "docs/adr/0070-context-engine-cache.md"),
      "# Context Engine cache\nRevision 2 changes the cache safety contract.\n",
    );
    const third = await builder.build("optimize context engine cache");

    expect(third.metadata.cache_hit).toBe(false);
    expect(third.static_artifacts.find((artifact) => artifact.kind === "adr")?.content).toContain("Revision 2");
    expect(cbm.searchSymbols).toHaveBeenCalledTimes(1);
    expect(third.metadata.component_cache?.hit_sources).toContain("cbm-symbols");
  });
});
