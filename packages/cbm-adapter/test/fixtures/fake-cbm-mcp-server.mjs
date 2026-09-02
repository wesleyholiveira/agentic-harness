import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "fake-cbm", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "index_status",
    description: "Return a deterministic fake index status.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" } },
      required: ["project"],
      additionalProperties: false,
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "index_status") {
    return { isError: true, content: [{ type: "text", text: `unknown tool:${request.params.name}` }] };
  }
  const project = typeof request.params.arguments?.project === "string"
    ? request.params.arguments.project
    : "unknown";
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ project, nodes: 10, edges: 20, status: "ready" }),
    }],
  };
});

await server.connect(new StdioServerTransport());
