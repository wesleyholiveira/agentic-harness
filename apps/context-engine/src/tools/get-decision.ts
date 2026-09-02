import type { Visibility } from "../visibility.js";
import { z } from "zod";
import type { ProjectMemory } from "@agent-harness/project-memory";

export function registerGetDecision(visibility: Visibility, memory: ProjectMemory): void {
  visibility.registerVisibleTool(
    "context_get_decision",
    {
      description: "Search past architectural decisions by query.",
      inputSchema: {
        query: z.string().describe("Search query for decisions"),
        limit: z.number().optional().describe("Max results (default 5)"),
      },
    },
    async (args) => {
      const decisions = await memory.getDecisions({ query: args.query, limit: args.limit ?? 5 });
      return { content: [{ type: "text" as const, text: JSON.stringify(decisions, null, 2) }] };
    },
  );
}
