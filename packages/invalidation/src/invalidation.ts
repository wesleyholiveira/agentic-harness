import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function computeHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export function getChangedFiles(filePaths: string[], oldHashes: Record<string, string>): string[] {
  return filePaths.filter((filePath) => {
    const currentHash = computeHash(filePath);
    const oldHash = oldHashes[filePath];
    return oldHash !== currentHash;
  });
}
