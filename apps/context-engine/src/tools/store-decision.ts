import type { Visibility } from "../visibility.js";
import { z } from "zod";
import type { ProjectMemory } from "@agent-harness/project-memory";

export function registerStoreDecision(visibility: Visibility, memory: ProjectMemory): void {
  visibility.registerVisibleTool(
    "context_store_decision",
    {
      description: "Store a new architectural decision for future reference.",
      inputSchema: {
        title: z.string().describe("Decision title"),
        content: z.string().describe("Decision content"),
        rationale: z.string().describe("Why this decision was made"),
        files: z.array(z.string()).describe("Affected file paths"),
        symbols: z.array(z.string()).describe("Affected symbol names"),
        commit: z.string().describe("Git commit hash"),
      },
    },
    async (args) => {
      const id = await memory.storeDecision({
        title: args.title,
        content: args.content,
        rationale: args.rationale,
        files: args.files,
        symbols: args.symbols,
        commit: args.commit,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ id }) }] };
    },
  );
}
