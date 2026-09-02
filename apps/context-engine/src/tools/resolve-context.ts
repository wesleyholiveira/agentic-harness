import { z } from "zod";
import type { ContextReferenceStore } from "@agent-harness/context-pack";
import type { Visibility } from "../visibility.js";

export function registerResolveContext(
  visibility: Visibility,
  references: ContextReferenceStore,
): void {
  visibility.registerVisibleTool(
    "context_resolve",
    {
      description: "Resolve a ctxref:* section or ctxpack:* full pack without rerunning retrieval.",
      inputSchema: {
        ref: z.string().describe("Content-addressed context reference returned by context_get_task_context"),
      },
    },
    async (args) => {
      const resolved = await references.resolveWithMeta(args.ref);
      if (!resolved) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "context_reference_not_found", ref: args.ref }),
            },
          ],
          _meta: {
            status: "cache-miss-reference",
            summary: "REFERENCE MISS · expired, stale, or unknown ctxref",
            cache_hit: false,
          },
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(resolved.value, null, 2) }],
        _meta: {
          status: `cache-hit-reference-${resolved.tier}`,
          summary: `REFERENCE HIT ${resolved.tier.toUpperCase()} · ${resolved.value.source}`,
          cache_hit: true,
          cache_tier: resolved.tier,
          source: resolved.value.source,
        },
      };
    },
  );
}
