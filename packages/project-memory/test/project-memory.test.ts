import { describe, expect, it, vi } from "vitest";
import { ProjectMemory, canonicalMemoryQueryPhrases, canonicalMemoryTokens } from "../src/index";

describe("ProjectMemory PostgreSQL", () => {
  it("preserves unicode61-like tokenization and legacy quoted phrase grouping", () => {
    expect(canonicalMemoryTokens('Café API foo-bar foo_bar "API"')).toEqual(["cafe", "api", "foo", "bar"]);
    expect(canonicalMemoryQueryPhrases('Café API foo-bar foo_bar "API"')).toEqual([
      ["cafe"], ["api"], ["foo", "bar"], ["foo", "bar"],
    ].filter((phrase, index, all) => all.findIndex((candidate) => candidate.join("\0") === phrase.join("\0")) === index));
  });

  it("stores decisions and revision state atomically through PostgreSQL", async () => {
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const client = { query: clientQuery, release: vi.fn() };
    const poolQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM context_project_memory_revision")) {
        return { rows: [{ decision_count: "2", decision_latest: "20", task_count: "1", task_latest: "10" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const pool = {
      query: poolQuery,
      connect: vi.fn(async () => client),
      end: async () => undefined,
    };
    const memory = new ProjectMemory({ projectId: "p", pool: pool as never, migrationRequired: false });

    await memory.storeDecision({ title: "t", content: "database cache", rationale: "r", files: [], symbols: [], commit: "c" });

    expect(clientQuery).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO context_project_memory_decisions"), expect.any(Array));
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO context_project_memory_revision"), expect.any(Array));
    expect(clientQuery).toHaveBeenLastCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
    expect(await memory.getRevision()).toBe("decisions:2:20|tasks:1:10");
  });
});
