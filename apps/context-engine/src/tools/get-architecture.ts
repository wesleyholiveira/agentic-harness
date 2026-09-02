import type { Visibility } from "../visibility.js";
import type { CBMAdapter } from "@agent-harness/cbm-adapter";

export function registerGetArchitecture(visibility: Visibility, cbm: CBMAdapter): void {
  visibility.registerVisibleTool(
    "context_get_architecture",
    {
      description: "Get high-level architecture overview of the project.",
      inputSchema: {},
    },
    async () => {
      const arch = await cbm.getArchitecture();
      return { content: [{ type: "text" as const, text: arch }] };
    },
  );
}
