import type { Visibility } from "../visibility.js";
import { z } from "zod";
import type { CBMAdapter } from "@agent-harness/cbm-adapter";

export function registerFindRelated(visibility: Visibility, cbm: CBMAdapter): void {
  visibility.registerVisibleTool(
    "context_find_related",
    {
      description: "Find symbols related to given concepts via CBM search.",
      inputSchema: {
        concepts: z.array(z.string()).describe("Concept names to search for"),
      },
    },
    async (args) => {
      const allResults = await Promise.all(
        args.concepts.map((c: string) => cbm.searchSymbols(`.*${c}.*`).catch(() => [])),
      );
      const merged = allResults.flat();
      return { content: [{ type: "text" as const, text: JSON.stringify(merged, null, 2) }] };
    },
  );
}
