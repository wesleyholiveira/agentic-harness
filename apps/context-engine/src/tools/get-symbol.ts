import type { Visibility } from "../visibility.js";
import { z } from "zod";
import type { CBMAdapter } from "@agent-harness/cbm-adapter";
import type { SerenaAdapter } from "@agent-harness/serena-adapter";

export function registerGetSymbol(visibility: Visibility, cbm: CBMAdapter, serena: SerenaAdapter): void {
  visibility.registerVisibleTool(
    "context_get_symbol",
    {
      description:
        "Get symbol info and relations by qualified name. Uses CBM for graph data and Serena for LSP details.",
      inputSchema: {
        qualified_name: z.string().describe("Fully qualified symbol name"),
      },
    },
    async (args) => {
      const [snippet, serenaInfo] = await Promise.all([
        cbm.getSnippet(args.qualified_name).catch(() => null),
        serena.getSymbol(args.qualified_name).catch(() => null),
      ]);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ snippet, serena_info: serenaInfo }, null, 2),
          },
        ],
      };
    },
  );
}
