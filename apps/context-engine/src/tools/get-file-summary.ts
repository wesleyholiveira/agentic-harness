import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { CBMAdapter } from "@agent-harness/cbm-adapter";
import { createCacheKey, type TieredContextCache } from "@agent-harness/context-cache";
import { SummaryManager } from "@agent-harness/summary-manager";
import { z } from "zod";
import type { Visibility } from "../visibility.js";

const FILE_SUMMARY_TTL_MS = 30 * 60 * 1000;

function workspacePath(cwd: string, requestedPath: string): { absolute: string; relativePath: string } {
  const absolute = resolve(cwd, requestedPath);
  const relativePath = relative(cwd, absolute).replaceAll("\\", "/");
  if (relativePath.startsWith("../") || relativePath === ".." || isAbsolute(relativePath)) {
    throw new Error("context_get_file_summary only accepts files inside the workspace");
  }
  return { absolute, relativePath };
}

export function registerGetFileSummary(
  visibility: Visibility,
  cbm: CBMAdapter,
  cache?: TieredContextCache,
  cwd = process.cwd(),
): void {
  visibility.registerVisibleTool(
    "context_get_file_summary",
    {
      description: "Get a deterministic summary of a workspace file (defined symbols and responsibility hint).",
      inputSchema: {
        path: z.string().describe("Workspace-relative file path to summarize"),
      },
    },
    async (args) => {
      const target = workspacePath(cwd, args.path);
      const bytes = readFileSync(target.absolute);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const key = createCacheKey("context-tool:file-summary:v1", {
        path: target.relativePath,
        content_hash: hash,
      });

      if (cache) {
        const hit = await cache.get<Awaited<ReturnType<SummaryManager["getSummary"]>>>(key);
        if (hit) {
          await cache.recordFileHash(target.relativePath, hash);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(hit.value, null, 2) }],
            _meta: {
              status: `cache-hit-${hit.tier}`,
              summary: `FILE SUMMARY HIT ${hit.tier.toUpperCase()} · ${target.relativePath}`,
              cache_hit: true,
              cache_tier: hit.tier,
              path: target.relativePath,
              content_hash: hash,
            },
          };
        }
      }

      const summaryManager = new SummaryManager(cbm, target.relativePath, hash);
      const summary = await summaryManager.getSummary();
      if (cache) {
        await cache.recordFileHash(target.relativePath, hash);
        await cache.set(key, summary, [hash], FILE_SUMMARY_TTL_MS);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
        _meta: {
          status: "cache-miss",
          summary: `FILE SUMMARY MISS · ${target.relativePath}`,
          cache_hit: false,
          path: target.relativePath,
          content_hash: hash,
        },
      };
    },
  );
}
