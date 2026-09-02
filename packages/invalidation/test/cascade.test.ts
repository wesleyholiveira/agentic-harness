import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CBMAdapter } from "@agent-harness/cbm-adapter";
import type { L1SessionCache, PersistentContextCache } from "@agent-harness/context-cache";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { invalidateCascade } from "../src/cascade";

function createCbmMock() {
  const searchSymbols = vi.fn();
  const tracePath = vi.fn();
  const cbm = { searchSymbols, tracePath } as unknown as CBMAdapter;
  return { cbm, searchSymbols, tracePath };
}

function createCacheMocks() {
  const l1Invalidate = vi.fn().mockReturnValue(1);
  const l2Invalidate = vi.fn().mockReturnValue(1);
  const getFileHash = vi.fn().mockReturnValue(undefined);
  const updateHash = vi.fn();
  const recordFileHash = vi.fn();
  const l1 = { invalidate: l1Invalidate } as unknown as L1SessionCache;
  const l2 = {
    invalidate: l2Invalidate,
    getFileHash,
    updateHash,
    recordFileHash,
  } as unknown as PersistentContextCache;
  return { l1, l2, l1Invalidate, l2Invalidate, getFileHash, updateHash, recordFileHash };
}

describe("invalidateCascade", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cascade-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("invalidates the changed file and its dependents", async () => {
    const sourceFile = join(tempDir, "source.ts");
    const depFile1 = join(tempDir, "dep1.ts");
    const depFile2 = join(tempDir, "dep2.ts");
    writeFileSync(sourceFile, "export function compute() { return 1; }");
    writeFileSync(depFile1, "import { compute } from './source';");
    writeFileSync(depFile2, "import { compute } from './source';");

    const { cbm, searchSymbols, tracePath } = createCbmMock();
    searchSymbols.mockResolvedValue([
      {
        qualified_name: "pkg.source.compute",
        label: "Function",
        file: sourceFile,
        lines: "1-3",
        in_degree: 2,
        out_degree: 0,
      },
    ]);
    tracePath.mockResolvedValue({
      direction: "inbound",
      total: 2,
      nodes: [
        { qualified_name: "pkg.dep1.usesCompute", file: depFile1, depth: 1 },
        { qualified_name: "pkg.dep2.usesCompute", file: depFile2, depth: 1 },
      ],
    });

    const { l1, l2, l1Invalidate, l2Invalidate } = createCacheMocks();
    const result = await invalidateCascade(sourceFile, cbm, { l1, l2 });

    expect(result.invalidated_files).toEqual([sourceFile, depFile1, depFile2]);
    expect(result.invalidated_cache_entries).toBe(6);
    expect(l1Invalidate).toHaveBeenCalledTimes(3);
    expect(l2Invalidate).toHaveBeenCalledTimes(3);
  });

  it("invalidates only the source file when there are no dependents", async () => {
    const sourceFile = join(tempDir, "source.ts");
    writeFileSync(sourceFile, "export function compute() { return 1; }");

    const { cbm, searchSymbols, tracePath } = createCbmMock();
    searchSymbols.mockResolvedValue([
      {
        qualified_name: "pkg.source.compute",
        label: "Function",
        file: sourceFile,
        lines: "1-3",
        in_degree: 0,
        out_degree: 0,
      },
    ]);
    tracePath.mockResolvedValue({ direction: "inbound", total: 0, nodes: [] });

    const { l1, l2, l1Invalidate, l2Invalidate } = createCacheMocks();
    const result = await invalidateCascade(sourceFile, cbm, { l1, l2 });

    expect(result.invalidated_files).toEqual([sourceFile]);
    expect(result.invalidated_cache_entries).toBe(2);
    expect(l1Invalidate).toHaveBeenCalledTimes(1);
    expect(l2Invalidate).toHaveBeenCalledTimes(1);
  });

  it("degrades gracefully when searchSymbols throws", async () => {
    const sourceFile = join(tempDir, "source.ts");
    writeFileSync(sourceFile, "export function compute() { return 1; }");

    const { cbm, searchSymbols, tracePath } = createCbmMock();
    searchSymbols.mockRejectedValue(new Error("CBM unavailable"));

    const { l1, l2, l1Invalidate, l2Invalidate } = createCacheMocks();
    const result = await invalidateCascade(sourceFile, cbm, { l1, l2 });

    expect(result.invalidated_files).toEqual([sourceFile]);
    expect(result.invalidated_cache_entries).toBe(2);
    expect(tracePath).not.toHaveBeenCalled();
    expect(l1Invalidate).toHaveBeenCalledTimes(1);
    expect(l2Invalidate).toHaveBeenCalledTimes(1);
  });

  it("skips symbols whose tracePath throws", async () => {
    const sourceFile = join(tempDir, "source.ts");
    writeFileSync(sourceFile, "export function compute() { return 1; }");

    const { cbm, searchSymbols, tracePath } = createCbmMock();
    searchSymbols.mockResolvedValue([
      {
        qualified_name: "pkg.source.compute",
        label: "Function",
        file: sourceFile,
        lines: "1-3",
        in_degree: 1,
        out_degree: 0,
      },
    ]);
    tracePath.mockRejectedValue(new Error("trace failed"));

    const { l1, l2, l1Invalidate, l2Invalidate } = createCacheMocks();
    const result = await invalidateCascade(sourceFile, cbm, { l1, l2 });

    expect(tracePath).toHaveBeenCalledTimes(1);
    expect(result.invalidated_files).toEqual([sourceFile]);
    expect(result.invalidated_cache_entries).toBe(2);
    expect(l1Invalidate).toHaveBeenCalledTimes(1);
    expect(l2Invalidate).toHaveBeenCalledTimes(1);
  });

  it("continues when a dependent file no longer exists", async () => {
    const sourceFile = join(tempDir, "source.ts");
    writeFileSync(sourceFile, "export function compute() { return 1; }");
    const missingFile = join(tempDir, "deleted.ts");

    const { cbm, searchSymbols, tracePath } = createCbmMock();
    searchSymbols.mockResolvedValue([
      {
        qualified_name: "pkg.source.compute",
        label: "Function",
        file: sourceFile,
        lines: "1-3",
        in_degree: 1,
        out_degree: 0,
      },
    ]);
    tracePath.mockResolvedValue({
      direction: "inbound",
      total: 1,
      nodes: [{ qualified_name: "pkg.deleted.usesCompute", file: missingFile, depth: 1 }],
    });

    const { l1, l2, l1Invalidate, l2Invalidate } = createCacheMocks();
    const result = await invalidateCascade(sourceFile, cbm, { l1, l2 });

    expect(result.invalidated_files).toEqual([sourceFile, missingFile]);
    expect(result.invalidated_cache_entries).toBe(2);
    expect(l1Invalidate).toHaveBeenCalledTimes(1);
    expect(l2Invalidate).toHaveBeenCalledTimes(1);
  });

  it("invalidates by the previously registered hash and advances it to the new hash", async () => {
    const sourceFile = join(tempDir, "source.ts");
    writeFileSync(sourceFile, "export const value = 2;");

    const { cbm, searchSymbols, tracePath } = createCbmMock();
    searchSymbols.mockResolvedValue([{
      qualified_name: "pkg.source.value",
      label: "Variable",
      file: sourceFile,
      lines: "1",
      in_degree: 0,
      out_degree: 0,
    }]);
    tracePath.mockResolvedValue({ direction: "inbound", total: 0, nodes: [] });

    const { l1, l2, l1Invalidate, l2Invalidate, getFileHash, updateHash, recordFileHash } =
      createCacheMocks();
    getFileHash.mockReturnValue("hash-before-edit");

    await invalidateCascade(sourceFile, cbm, { l1, l2 });

    expect(l1Invalidate).toHaveBeenCalledWith("hash-before-edit");
    expect(l2Invalidate).toHaveBeenCalledWith("hash-before-edit");
    expect(updateHash).toHaveBeenCalledWith("hash-before-edit", expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(recordFileHash).toHaveBeenCalledWith(sourceFile, expect.stringMatching(/^[0-9a-f]{64}$/));
  });

});
