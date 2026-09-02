import { describe, expect, it, vi } from "vitest";
import { SummaryEnricher } from "../src/enrichment";
import type { FileSummary } from "../src/types";

function makeSummary(hash: string): FileSummary {
  return {
    path: "src/auth.ts",
    hash,
    symbols: ["app.AuthService.login"],
    imports: [],
    defined_symbols: ["app.AuthService.login"],
    responsibility_hint: "Contains function implementations",
    generated_at: 1000,
  };
}

describe("SummaryEnricher", () => {
  it("enrich produces an EnrichedSummary with LLM content", async () => {
    const summaryManager = {
      getSummary: vi.fn().mockResolvedValue(makeSummary("hash_v1")),
    } as never;
    const llmCallback = vi.fn().mockResolvedValue("This module handles auth");
    const enricher = new SummaryEnricher(summaryManager, llmCallback);

    const enriched = await enricher.enrich("src/auth.ts", "code");

    expect(enriched.enriched_content).toBe("This module handles auth");
    expect(enriched.enriched_at).toBeGreaterThan(0);
    expect(enriched.hash).toBe("hash_v1");
    expect(enriched.path).toBe("src/auth.ts");
    expect(llmCallback).toHaveBeenCalledTimes(1);
  });

  it("enrich returns the cached result on the second call", async () => {
    const summaryManager = {
      getSummary: vi.fn().mockResolvedValue(makeSummary("hash_v1")),
    } as never;
    const llmCallback = vi.fn().mockResolvedValue("This module handles auth");
    const enricher = new SummaryEnricher(summaryManager, llmCallback);

    const first = await enricher.enrich("src/auth.ts", "code");
    const second = await enricher.enrich("src/auth.ts", "code");

    expect(llmCallback).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("invalidate clears the cache entry for a file", async () => {
    const summaryManager = {
      getSummary: vi.fn().mockResolvedValue(makeSummary("hash_v1")),
    } as never;
    const llmCallback = vi.fn().mockResolvedValue("This module handles auth");
    const enricher = new SummaryEnricher(summaryManager, llmCallback);

    await enricher.enrich("src/auth.ts", "code");
    enricher.invalidate("src/auth.ts");
    await enricher.enrich("src/auth.ts", "code");

    expect(llmCallback).toHaveBeenCalledTimes(2);
  });

  it("enrich falls back to the deterministic summary when the LLM throws", async () => {
    const summaryManager = {
      getSummary: vi.fn().mockResolvedValue(makeSummary("hash_v1")),
    } as never;
    const llmCallback = vi.fn().mockRejectedValue(new Error("LLM unavailable"));
    const enricher = new SummaryEnricher(summaryManager, llmCallback);

    const enriched = await enricher.enrich("src/auth.ts", "code");

    expect(enriched.enriched_content).toBe("");
    expect(enriched.enriched_at).toBe(0);
    expect(enriched.hash).toBe("hash_v1");
    expect(enriched.symbols).toEqual(["app.AuthService.login"]);
  });

  it("enrich regenerates when the summary hash changes", async () => {
    const summaryManager = {
      getSummary: vi
        .fn()
        .mockResolvedValueOnce(makeSummary("hash_v1"))
        .mockResolvedValueOnce(makeSummary("hash_v2")),
    } as never;
    const llmCallback = vi.fn().mockResolvedValue("This module handles auth");
    const enricher = new SummaryEnricher(summaryManager, llmCallback);

    await enricher.enrich("src/auth.ts", "code");
    const enriched = await enricher.enrich("src/auth.ts", "code");

    expect(llmCallback).toHaveBeenCalledTimes(2);
    expect(enriched.hash).toBe("hash_v2");
  });

  it("clear removes all cached enrichments", async () => {
    const summaryManager = {
      getSummary: vi.fn().mockResolvedValue(makeSummary("hash_v1")),
    } as never;
    const llmCallback = vi.fn().mockResolvedValue("This module handles auth");
    const enricher = new SummaryEnricher(summaryManager, llmCallback);

    await enricher.enrich("src/auth.ts", "code");
    await enricher.enrich("src/logout.ts", "code");
    expect(llmCallback).toHaveBeenCalledTimes(2);

    enricher.clear();
    await enricher.enrich("src/auth.ts", "code");

    expect(llmCallback).toHaveBeenCalledTimes(3);
  });
});
