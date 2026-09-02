import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { L1SessionCache, TieredContextCache } from "@agent-harness/context-cache";
import { TestPersistentCache } from "./test-persistent-cache";
import { analyzeTask } from "../src/task-analyzer";
import { estimateTokens } from "../src/budget-optimizer";
import { toCompactContextPack } from "../src/compact-view";
import { ContextReferenceStore } from "../src/reference-store";
import type { ContextPack } from "../src/types";

function makePack(): ContextPack {
  return {
    task_analysis: analyzeTask("optimize cache context engine with Headroom"),
    previous_decisions: Array.from({ length: 8 }, (_, index) => ({
      id: `d${index}`,
      title: `Decision ${index}`,
      content: "detailed rationale and historical context ".repeat(80),
      rationale: "keep deterministic context",
      files: [`src/${index}.ts`],
      symbols: [`pkg.Symbol${index}`],
      created_at: 1700000000000 + index,
    })),
    symbols: Array.from({ length: 30 }, (_, index) => ({
      qualified_name: `pkg.Symbol${index}`,
      label: "Function",
      file: `src/${index}.ts`,
      lines: "1-20",
      in_degree: index,
      out_degree: index % 4,
    })),
    architecture: "architecture graph boundary dependency ".repeat(800),
    static_artifacts: [],
    summaries: [],
    dependencies: { callers: [], callees: [], tests: [] },
    external_docs: [
      { library: "headroom", query: "compression", content: "external documentation ".repeat(500) },
    ],
    metadata: {
      total_tokens: 0,
      budget: 18000,
      sources_queried: ["memory", "cbm", "architecture", "context7"],
      cache_hit: false,
      generated_at: "2026-08-15T00:00:00.000Z",
      warnings: [],
    },
  };
}

describe("ContextReferenceStore + compact delivery", () => {
  let tempDir: string;
  let store: ContextReferenceStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "context-ref-test-"));
    const cache = new TieredContextCache(new L1SessionCache(60_000), new TestPersistentCache());
    store = new ContextReferenceStore(cache, 60_000, tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses content addressing and resolves the original losslessly", async () => {
    const first = await store.put("symbols", [{ qualified_name: "pkg.Foo" }]);
    const second = await store.put("symbols", [{ qualified_name: "pkg.Foo" }]);

    expect(first.ref).toBe(second.ref);
    expect(first.ref).toMatch(/^ctxref:[0-9a-f]{64}$/);
    expect((await store.resolve(first.ref))?.content).toEqual([{ qualified_name: "pkg.Foo" }]);
  });

  it("exposes the tier used to resolve a reference without changing resolve() compatibility", async () => {
    const reference = await store.put("architecture", "full architecture");

    expect(await store.resolveWithMeta(reference.ref)).toMatchObject({
      tier: "l1",
      value: { source: "architecture", content: "full architecture" },
    });
    expect((await store.resolve(reference.ref))?.content).toBe("full architecture");
  });

  it("keeps pack ids stable across delivery-only metadata changes", async () => {
    const first = makePack();
    const second = makePack();
    second.metadata.budget = 4000;
    second.metadata.cache_hit = true;
    second.metadata.cache_tier = "l2";
    second.metadata.total_tokens = 1234;
    second.metadata.generated_at = "2026-08-15T01:00:00.000Z";
    second.metadata.served_at = "2026-08-15T01:00:01.000Z";

    expect(await store.putPack(first)).toBe(await store.putPack(second));
  });

  it("returns a compact pack with resolvable sections and material token savings", async () => {
    const pack = makePack();
    const compact = await toCompactContextPack(pack, store);

    expect(compact.pack_id).toMatch(/^ctxpack:[0-9a-f]{64}$/);
    expect(compact.references.some((reference) => reference.source === "architecture")).toBe(true);
    expect(compact.references.some((reference) => reference.source === "external_docs")).toBe(true);
    expect((await store.resolve(compact.pack_id))?.content).toEqual(pack);
    expect(compact.metadata.full_tokens).toBe(estimateTokens(pack));
    expect(compact.metadata.delivered_tokens).toBeLessThan(compact.metadata.full_tokens);
    expect(compact.metadata.delivery_savings_percent).toBeGreaterThan(50);
  });

  it("refuses to resolve a file-backed reference after the underlying artifact changes", async () => {
    mkdirSync(join(tempDir, "docs/adr"), { recursive: true });
    const path = "docs/adr/0070-cache.md";
    const absolute = join(tempDir, path);
    writeFileSync(absolute, "# Cache\nRevision one\n");
    const hash = createHash("sha256").update("# Cache\nRevision one\n").digest("hex");
    const reference = await store.put(
      `static-artifact:${path}`,
      { path, content: "# Cache\nRevision one\n" },
      [{ path, hash }],
    );

    expect((await store.resolve(reference.ref))?.content).toEqual({ path, content: "# Cache\nRevision one\n" });

    writeFileSync(absolute, "# Cache\nRevision two\n");
    expect(await store.resolve(reference.ref)).toBeUndefined();
  });

  it("puts static artifact contents behind individual refs in compact delivery", async () => {
    mkdirSync(join(tempDir, "docs/adr"), { recursive: true });
    const path = "docs/adr/0070-cache.md";
    const content = "# Cache ADR\n" + "Detailed cache contract. ".repeat(400);
    writeFileSync(join(tempDir, path), content);
    const hash = createHash("sha256").update(content).digest("hex");
    const pack = makePack();
    pack.static_artifacts = [
      {
        path,
        kind: "adr",
        title: "Cache ADR",
        content_hash: hash,
        token_cost: estimateTokens(content),
        relevance_score: 1,
        content,
      },
    ];

    const compact = await toCompactContextPack(pack, store);
    const descriptor = compact.focus.static_artifacts[0];

    expect(descriptor?.path).toBe(path);
    expect(descriptor?.ref).toMatch(/^ctxref:/);
    expect(compact.references.some((reference) => reference.source === `static-artifact:${path}`)).toBe(true);
    expect((await store.resolve(descriptor?.ref ?? ""))?.content).toMatchObject({ path, content_hash: hash, content });
    expect(compact.metadata.delivered_tokens).toBeLessThan(compact.metadata.full_tokens);
  });
});
