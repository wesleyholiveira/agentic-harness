import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { computeHash, getChangedFiles } from "../src/invalidation";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("invalidation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "invalidation-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("computeHash returns SHA-256 hex of file content", () => {
    const filePath = join(tempDir, "test.ts");
    writeFileSync(filePath, "export const x = 1;");
    const hash = computeHash(filePath);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("computeHash returns same hash for same content", () => {
    const file1 = join(tempDir, "a.ts");
    const file2 = join(tempDir, "b.ts");
    writeFileSync(file1, "const x = 1;");
    writeFileSync(file2, "const x = 1;");
    expect(computeHash(file1)).toBe(computeHash(file2));
  });

  it("computeHash returns different hash for different content", () => {
    const file1 = join(tempDir, "a.ts");
    const file2 = join(tempDir, "b.ts");
    writeFileSync(file1, "const x = 1;");
    writeFileSync(file2, "const x = 2;");
    expect(computeHash(file1)).not.toBe(computeHash(file2));
  });

  it("computeHash throws for nonexistent file", () => {
    expect(() => computeHash(join(tempDir, "nonexistent.ts"))).toThrow();
  });

  it("getChangedFiles returns files whose hash differs from registry", () => {
    const file1 = join(tempDir, "a.ts");
    const file2 = join(tempDir, "b.ts");
    writeFileSync(file1, "const x = 1;");
    writeFileSync(file2, "const y = 2;");

    const oldHashes: Record<string, string> = {
      [file1]: computeHash(file1),
      [file2]: "old_hash_that_does_not_match",
    };

    const changed = getChangedFiles([file1, file2], oldHashes);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toBe(file2);
  });

  it("getChangedFiles returns all files when registry is empty", () => {
    const file1 = join(tempDir, "a.ts");
    writeFileSync(file1, "const x = 1;");

    const changed = getChangedFiles([file1], {});
    expect(changed).toHaveLength(1);
  });

  it("getChangedFiles returns empty array when nothing changed", () => {
    const file1 = join(tempDir, "a.ts");
    writeFileSync(file1, "const x = 1;");
    const hash = computeHash(file1);

    const changed = getChangedFiles([file1], { [file1]: hash });
    expect(changed).toEqual([]);
  });
});
