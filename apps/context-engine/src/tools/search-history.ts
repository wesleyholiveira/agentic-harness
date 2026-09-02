import type { Visibility } from "../visibility.js";
import { z } from "zod";
import type { ProjectMemory } from "@agent-harness/project-memory";

export function registerSearchHistory(visibility: Visibility, memory: ProjectMemory): void {
  visibility.registerVisibleTool(
    "context_search_history",
    {
      description: "Search past task history by query.",
      inputSchema: {
        query: z.string().describe("Search query for task history"),
        limit: z.number().optional().describe("Max results (default 10)"),
      },
    },
    async (args) => {
      const history = await memory.getTaskHistory(args.query, args.limit ?? 10);
      return { content: [{ type: "text" as const, text: JSON.stringify(history, null, 2) }] };
    },
  );
}
