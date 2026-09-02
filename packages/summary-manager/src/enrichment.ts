import type { EnrichedSummary, FileSummary } from "./types";
import type { SummaryManager } from "./summary-manager";

export type LlmCallback = (summary: FileSummary, code: string) => Promise<string>;

export class SummaryEnricher {
  private enrichedCache = new Map<string, { summary: EnrichedSummary; hash: string }>();

  constructor(
    private summaryManager: SummaryManager,
    private llmCallback: LlmCallback,
  ) {}

  async enrich(filePath: string, code: string): Promise<EnrichedSummary> {
    const detSummary = await this.summaryManager.getSummary();

    // Check cache
    const cached = this.enrichedCache.get(filePath);
    if (cached && cached.hash === detSummary.hash) {
      return cached.summary;
    }

    // Call LLM for enrichment
    let enrichedContent: string;
    try {
      enrichedContent = await this.llmCallback(detSummary, code);
    } catch {
      // LLM unavailable — return deterministic summary as fallback
      return {
        ...detSummary,
        enriched_content: "",
        enriched_at: 0,
      };
    }

    const enriched: EnrichedSummary = {
      ...detSummary,
      enriched_content: enrichedContent,
      enriched_at: Date.now(),
    };

    this.enrichedCache.set(filePath, { summary: enriched, hash: detSummary.hash });
    return enriched;
  }

  invalidate(filePath: string): void {
    this.enrichedCache.delete(filePath);
  }

  clear(): void {
    this.enrichedCache.clear();
  }
}
