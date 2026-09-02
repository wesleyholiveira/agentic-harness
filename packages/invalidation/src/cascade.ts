import { createHash } from "node:crypto";
import type { CBMAdapter } from "@agent-harness/cbm-adapter";
import type { L1SessionCache, PersistentContextCache } from "@agent-harness/context-cache";
import { computeHash } from "./invalidation";

export interface CascadeResult {
  invalidated_files: string[];
  invalidated_cache_entries: number;
}

function deletedRevision(filePath: string): string {
  return `deleted:${createHash("sha256").update(filePath).digest("hex")}`;
}

export async function invalidateCascade(
  filePath: string,
  cbm: CBMAdapter,
  caches: { l1?: L1SessionCache; l2?: PersistentContextCache },
): Promise<CascadeResult> {
  const invalidatedFiles: string[] = [filePath];
  let cacheEntries = 0;

  const fileName =
    filePath
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.\w+$/, "") ?? "";
  const pattern = `.*${fileName}.*`;
  let symbols: string[] = [];
  try {
    const results = await cbm.searchSymbols(pattern);
    symbols = results
      .filter((symbol) => symbol.file === filePath)
      .map((symbol) => symbol.qualified_name.split(".").pop() ?? symbol.qualified_name);
  } catch {
    // CBM unavailable — degrade gracefully, only invalidate the file itself.
  }

  for (const symbol of symbols) {
    try {
      const trace = await cbm.tracePath(symbol, "inbound");
      for (const node of trace.nodes) {
        if (node.file && !invalidatedFiles.includes(node.file)) {
          invalidatedFiles.push(node.file);
        }
      }
    } catch {
      // tracePath failed — keep invalidating the dependencies we already know.
    }
  }

  for (const file of invalidatedFiles) {
    const previousHash = caches.l2 ? await caches.l2.getFileHash(file) : undefined;
    let currentHash: string;
    try {
      currentHash = computeHash(file);
    } catch {
      currentHash = deletedRevision(file);
    }

    // The dependency stored in cache entries is the hash captured before the edit.
    // Invalidating only by currentHash would miss exactly the entries that became stale.
    const invalidationHash = previousHash ?? (currentHash.startsWith("deleted:") ? undefined : currentHash);
    if (invalidationHash) {
      cacheEntries += caches.l1?.invalidate(invalidationHash) ?? 0;
      cacheEntries += caches.l2 ? await caches.l2.invalidate(invalidationHash) : 0;
      if (caches.l2) await caches.l2.updateHash(invalidationHash, currentHash);
    }
    if (caches.l2) await caches.l2.recordFileHash(file, currentHash);
  }

  return {
    invalidated_files: invalidatedFiles,
    invalidated_cache_entries: cacheEntries,
  };
}
