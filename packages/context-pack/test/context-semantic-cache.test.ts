import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CBMAdapter, SymbolSearchResult } from "@agent-harness/cbm-adapter";
import type { Context7Adapter } from "@agent-harness/context7-adapter";
import type { Decision, ProjectMemory } from "@agent-harness/project-memory";
import type { SummaryManager } from "@agent-harness/summary-manager";
import {
  DeterministicSemanticEmbeddingProvider,
  SemanticContextCache,
  type SemanticCandidateRecord,
  type SemanticCandidateStore,
  type SemanticCandidateStoreHealth,
} from "@agent-harness/context-semantic-cache";
import { ContextPackBuilder } from "../src/context-pack-builder";

class CandidateStore implements SemanticCandidateStore {
  candidates: SemanticCandidateRecord[] = [];
  async query() { return this.candidates.map((candidate) => structuredClone(candidate)); }
  async put(input: Parameters<SemanticCandidateStore["put"]>[0]) {
    this.candidates = [{
      candidateId: input.payload.candidateId,
      payload: structuredClone(input.payload),
      distance: 0.04,
      similarity: 0.96,
    }];
  }
  async health(): Promise<SemanticCandidateStoreHealth> { return { status: "up", latencyMs: 0 }; }
  async close() {}
}

function makeSymbol(file: string): SymbolSearchResult {
  return { qualified_name: "runtime.ContextCache", label: "Class", file, lines: "1-10", in_degree: 2, out_degree: 1 };
}

function makeDecision(file: string): Decision {
  return {
    id: "decision-1", title: "Keep exact cache authoritative", content: "Semantic retrieval is candidate-only",
    rationale: "Authority safety", files: [file], symbols: ["runtime.ContextCache"], commit: "abc", created_at: 1,
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(mode: "observe" | "enforce") {
  const root = mkdtempSync(join(tmpdir(), "context-semantic-builder-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  const file = "src/context-cache.ts";
  writeFileSync(join(root, file), "export const version = 1;\n");
  const cbm = {
    searchSymbols: vi.fn().mockResolvedValue([makeSymbol(file)]),
    getArchitecture: vi.fn().mockResolvedValue("architecture"),
    getIndexStatus: vi.fn().mockResolvedValue({ project: "p", nodes: 20, edges: 30, status: "ready" }),
  };
  const memory = {
    getDecisions: vi.fn().mockReturnValue([makeDecision(file)]),
    getRevision: vi.fn().mockReturnValue("memory:1"),
  };
  const store = new CandidateStore();
  const semanticCache = new SemanticContextCache({
    mode, failureMode: "open", minSimilarity: -1, topK: 5, ttlMs: 60_000, failureCooldownMs: 1_000,
    projectId: "p", branch: "main", schemaVersion: "context-semantic-candidate/v1", cwd: root,
  }, store, new DeterministicSemanticEmbeddingProvider(128));
  const builder = new ContextPackBuilder(
    cbm as unknown as CBMAdapter,
    memory as unknown as ProjectMemory,
    {} as SummaryManager,
    {} as Context7Adapter,
    { cwd: root, staticArtifacts: false, semanticCache },
  );
  const context = { semanticScope: { projectId: "p", branch: "main", role: "developer", stage: "implementation" } };
  return { root, file, cbm, memory, semanticCache, builder, context };
}

describe("ContextPackBuilder semantic candidate integration", () => {
  it("observes reusable candidates without bypassing fresh Memory/CBM retrieval", async () => {
    const f = fixture("observe");
    await f.builder.build("fix Context Engine cache lookup", 18_000, f.context);
    const second = await f.builder.build("repair context retrieval cache behavior", 18_000, f.context);
    expect(second.metadata.cache_hit).toBe(false);
    expect(second.metadata.semantic_cache?.status).toBe("candidate-observed");
    expect(second.metadata.semantic_cache?.components_reused).toEqual([]);
    expect(second.metadata.semantic_cache?.would_reuse_components).toEqual(expect.arrayContaining(["memory-decisions", "cbm-symbols"]));
    expect(f.memory.getDecisions).toHaveBeenCalledTimes(2);
    expect(f.cbm.searchSymbols).toHaveBeenCalledTimes(2);
  });

  it("enforces only revalidated Memory/CBM snapshots while assembling a fresh pack", async () => {
    const f = fixture("enforce");
    const first = await f.builder.build("fix Context Engine cache lookup", 18_000, f.context);
    const second = await f.builder.build("repair context retrieval cache behavior", 18_000, f.context);
    expect(first.metadata.cache_hit).toBe(false);
    expect(second.metadata.cache_hit).toBe(false);
    expect(second.metadata.raw_pack_cache_key).not.toBe(first.metadata.raw_pack_cache_key);
    expect(second.metadata.semantic_cache?.status).toBe("candidate-reused");
    expect(second.metadata.semantic_cache?.components_reused).toEqual(expect.arrayContaining(["memory-decisions", "cbm-symbols"]));
    expect(second.metadata.semantic_cache?.retrieval_calls_avoided).toBe(2);
    expect(f.memory.getDecisions).toHaveBeenCalledTimes(1);
    expect(f.cbm.searchSymbols).toHaveBeenCalledTimes(1);
    expect(f.cbm.getArchitecture).toHaveBeenCalledTimes(2);
  });

  it("refreshes CBM when a captured workspace hash changes while reusing revision-authoritative Project Memory", async () => {
    const f = fixture("enforce");
    await f.builder.build("fix Context Engine cache lookup", 18_000, f.context);
    writeFileSync(join(f.root, f.file), "export const version = 2;\n");
    const second = await f.builder.build("repair context retrieval cache behavior", 18_000, f.context);
    expect(second.metadata.semantic_cache?.status).toBe("candidate-reused");
    expect(second.metadata.semantic_cache?.components_reused).toContain("memory-decisions");
    expect(second.metadata.semantic_cache?.stale_components).toEqual(["cbm-symbols"]);
    expect(second.metadata.semantic_cache?.stale_component_reasons?.["cbm-symbols"]).toContain("dependency-hash-mismatch");
    expect(f.memory.getDecisions).toHaveBeenCalledTimes(1);
    expect(f.cbm.searchSymbols).toHaveBeenCalledTimes(2);
  });

  it("refreshes Project Memory only when its authoritative PostgreSQL revision advances", async () => {
    const f = fixture("enforce");
    await f.builder.build("fix Context Engine cache lookup", 18_000, f.context);
    f.memory.getRevision.mockReturnValue("memory:2");
    const second = await f.builder.build("repair context retrieval cache behavior", 18_000, f.context);
    expect(second.metadata.semantic_cache?.status).toBe("candidate-reused");
    expect(second.metadata.semantic_cache?.components_reused).toContain("cbm-symbols");
    expect(second.metadata.semantic_cache?.stale_components).toEqual(["memory-decisions"]);
    expect(second.metadata.semantic_cache?.stale_component_reasons?.["memory-decisions"]).toEqual(["source-revision-mismatch"]);
    expect(f.memory.getDecisions).toHaveBeenCalledTimes(2);
    expect(f.cbm.searchSymbols).toHaveBeenCalledTimes(1);
  });

  it("does not treat historical Decision.files provenance as a workspace content dependency", async () => {
    const f = fixture("enforce");
    f.memory.getDecisions.mockResolvedValue([makeDecision("src/historical-removed-file.ts")]);
    f.cbm.searchSymbols.mockResolvedValue([makeSymbol("src/stale-cbm-file.ts")]);
    await f.builder.build("fix Context Engine cache lookup", 18_000, f.context);
    const second = await f.builder.build("repair context retrieval cache behavior", 18_000, f.context);
    expect(second.metadata.semantic_cache?.status).toBe("candidate-reused");
    expect(second.metadata.semantic_cache?.components_reused).toEqual(["memory-decisions"]);
    expect(second.metadata.semantic_cache?.stale_components).toEqual(["cbm-symbols"]);
    expect(second.metadata.semantic_cache?.stale_component_reasons?.["cbm-symbols"]).toContain("dependency-coverage-incomplete");
    expect(f.memory.getDecisions).toHaveBeenCalledTimes(1);
    expect(f.cbm.searchSymbols).toHaveBeenCalledTimes(2);
  });
});
