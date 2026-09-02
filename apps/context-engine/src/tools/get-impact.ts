import type { Visibility } from "../visibility.js";
import { z } from "zod";
import type { CBMAdapter } from "@agent-harness/cbm-adapter";

export function registerGetImpact(visibility: Visibility, cbm: CBMAdapter): void {
  visibility.registerVisibleTool(
    "context_get_impact",
    {
      description: "Get the blast radius / impact of a symbol change (inbound callers).",
      inputSchema: {
        symbol: z.string().describe("Symbol name to analyze impact for"),
        depth: z.number().optional().describe("Max traversal depth (default 3)"),
      },
    },
    async (args) => {
      const trace = await cbm.tracePath(args.symbol, "inbound", args.depth ?? 3);
      return { content: [{ type: "text" as const, text: JSON.stringify(trace, null, 2) }] };
    },
  );
}
