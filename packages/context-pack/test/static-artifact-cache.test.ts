import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { L1SessionCache, TieredContextCache } from "@agent-harness/context-cache";
import { TestPersistentCache } from "./test-persistent-cache";
import { analyzeTask } from "../src/task-analyzer";
import { StaticArtifactCache } from "../src/static-artifact-cache";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function workspace(): { root: string; cache: TieredContextCache } {
  const root = mkdtempSync(join(tmpdir(), "static-artifacts-test-"));
  const cache = new TieredContextCache(new L1SessionCache(60_000), new TestPersistentCache());
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, cache };
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
}

describe("StaticArtifactCache", () => {
  it("discovers and ranks stable ADR/PRD/evaluation artifacts without indexing ordinary source files", async () => {
    const { root, cache } = workspace();
    write(root, "docs/adr/0070-context-engine-cache.md", "# Context Engine cache\nContent-addressed cache rules.");
    write(root, "docs/specs/context-engine/PRD.md", "# PRD — Context Engine\nDeterministic context retrieval.");
    write(root, "docs/evaluations/2026-08-15-context-engine-cache.md", "# Cache evaluation\nHit rate evidence.");
    write(root, "apps/context-engine/src/server.ts", "export const server = true;");

    const artifacts = new StaticArtifactCache({ cache, cwd: root });
    const result = await artifacts.search(analyzeTask("optimize cache in the context engine"));

    expect(result.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(result.artifacts.some((artifact) => artifact.kind === "adr")).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.kind === "prd")).toBe(true);
    expect(result.artifacts.every((artifact) => artifact.path.startsWith("docs/"))).toBe(true);
    expect(result.discovered_count).toBe(3);
  });

  it("reuses the parsed artifact by content hash but changes identity immediately when the file changes", async () => {
    const { root, cache } = workspace();
    const path = "docs/adr/0070-context-engine-cache.md";
    write(root, path, "# Cache ADR\nRevision one.");
    const artifacts = new StaticArtifactCache({ cache, cwd: root });
    const task = analyzeTask("inspect ADR 0070 context engine cache");

    const first = await artifacts.search(task);
    const second = await artifacts.search(task);
    expect(first.artifacts[0]?.content).toContain("Revision one");
    expect(second.cache_hits).toBeGreaterThan(0);
    expect(second.artifacts[0]?.content_hash).toBe(first.artifacts[0]?.content_hash);

    write(root, path, "# Cache ADR\nRevision two, changed on disk.");
    const third = await artifacts.search(task);

    expect(third.artifacts[0]?.content).toContain("Revision two");
    expect(third.artifacts[0]?.content_hash).not.toBe(first.artifacts[0]?.content_hash);
    expect(third.cache_misses).toBeGreaterThan(0);
  });

  it("changes the catalog revision when a new stable artifact is added", () => {
    const { root, cache } = workspace();
    write(root, "docs/adr/0001-a.md", "# A\nA");
    const artifacts = new StaticArtifactCache({ cache, cwd: root });

    const before = artifacts.getCatalogRevision();
    write(root, "docs/specs/cache/PRD.md", "# Cache PRD\nB");
    const after = artifacts.getCatalogRevision();

    expect(after).not.toBe(before);
  });

  it("supports future ICR directories with the same content-addressed safety", async () => {
    const { root, cache } = workspace();
    write(root, "docs/icr/ICR-0042-gpu-liveness.md", "# ICR 0042 — GPU liveness\nIncident change request.");
    const artifacts = new StaticArtifactCache({ cache, cwd: root });

    const result = await artifacts.search(analyzeTask("review ICR 0042 GPU liveness"));

    expect(result.artifacts[0]?.kind).toBe("icr");
    expect(result.artifacts[0]?.path).toContain("ICR-0042");
  });
});
