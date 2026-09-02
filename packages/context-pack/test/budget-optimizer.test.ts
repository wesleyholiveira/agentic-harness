import { describe, expect, it } from "vitest";
import { analyzeTask } from "../src/task-analyzer";
import { estimateTokens, optimize, rankByUtility } from "../src/budget-optimizer";
import type { ContextPack, ContextPackItem } from "../src/types";

function makePack(overrides: Partial<ContextPack> = {}): ContextPack {
  return {
    task_analysis: analyzeTask("refactor auth.ts"),
    previous_decisions: [],
    symbols: [],
    architecture: "",
    static_artifacts: [],
    summaries: [],
    dependencies: { callers: [], callees: [], tests: [] },
    external_docs: [],
    metadata: {
      total_tokens: 0,
      budget: 18000,
      sources_queried: [],
      cache_hit: false,
      generated_at: "2026-01-01T00:00:00.000Z",
      warnings: [],
    },
    ...overrides,
  };
}

describe("estimateTokens", () => {
  it("returns chars divided by four", () => {
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("1234")).toBe(1);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens(1234)).toBe(1);
  });
});

describe("rankByUtility", () => {
  it("sorts items by relevance times freshness over token cost", () => {
    const items: ContextPackItem[] = [
      { source: "low", relevance_score: 0.5, freshness: 1, token_cost: 10, content: "x" },
      { source: "high", relevance_score: 0.9, freshness: 1, token_cost: 10, content: "x" },
      { source: "stale", relevance_score: 0.9, freshness: 0.2, token_cost: 10, content: "x" },
    ];

    const ranked = rankByUtility(items);

    expect(ranked.map((item) => item.source)).toEqual(["high", "low", "stale"]);
  });
});

describe("optimize", () => {
  it("returns pack unchanged when under budget", () => {
    const pack = makePack();

    const result = optimize(pack, 100000);

    expect(result).toEqual(pack);
  });

  it("keeps high-utility symbols ahead of a large low-utility architecture block", () => {
    const pack = makePack({
      symbols: [
        { qualified_name: "pkg.Important", file: "a.ts", in_degree: 20, out_degree: 5 },
        { qualified_name: "pkg.Second", file: "b.ts", in_degree: 5, out_degree: 1 },
      ],
      architecture: "architecture ".repeat(2000),
    });

    const result = optimize(pack, 500);

    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.architecture).toBe("");
    expect(result.metadata.warnings).toContain("architecture_removed_by_budget_optimizer");
  });

  it("deduplicates repeated items before spending budget", () => {
    const repeated = { qualified_name: "pkg.Foo", file: "foo.ts", in_degree: 1, out_degree: 0 };
    const pack = makePack({ symbols: [repeated, repeated, repeated] });

    const result = optimize(pack, Math.max(estimateTokens(makePack()), 400));

    expect(result.symbols).toHaveLength(1);
    expect(result.metadata.warnings).toContain("duplicate_items_removed_by_budget_optimizer");
  });

  it("reports when required metadata alone exceeds an extremely small budget", () => {
    const pack = makePack({ architecture: "x".repeat(1000) });

    const result = optimize(pack, 1);

    expect(result.metadata.warnings).toContain("budget_floor_exceeded_by_required_metadata");
  });

  it("treats cached static artifacts as budget candidates instead of forcing large documents inline", () => {
    const pack = makePack({
      symbols: [{ qualified_name: "pkg.Foo", file: "foo.ts", in_degree: 5, out_degree: 1 }],
      static_artifacts: [
        {
          path: "docs/adr/0070-cache.md",
          kind: "adr",
          title: "Cache ADR",
          content_hash: "a".repeat(64),
          token_cost: 5000,
          relevance_score: 0.4,
          content: "large architecture decision ".repeat(1200),
        },
      ],
    });

    const result = optimize(pack, 500);

    expect(result.symbols).toHaveLength(1);
    expect(result.static_artifacts).toEqual([]);
    expect(result.metadata.warnings).toContain("static_artifacts_truncated_by_budget_optimizer");
  });
});
