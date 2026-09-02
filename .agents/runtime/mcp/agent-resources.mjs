import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { agentsResource, artifactsResource, conflictsResource, runResource, taskResource } from "./agent-runtime.mjs";

const Identifier = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/);

function result(uri, data) {
  return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
}

export function registerAgentResources(server, config) {
  server.registerResource("agentic-harness-agents", "agent-harness://agents", {
    description: "Catálogo sanitizado de capacidades dos agentes.", mimeType: "application/json",
  }, async (uri) => result(uri, await agentsResource(config)));

  server.registerResource("agentic-harness-run", new ResourceTemplate("agent-harness://runs/{runId}", { list: undefined }), {
    description: "Run e tasks sanitizados.", mimeType: "application/json",
  }, async (uri, variables) => result(uri, await runResource(config, Identifier.parse(variables.runId))));

  server.registerResource("agentic-harness-task", new ResourceTemplate("agent-harness://runs/{runId}/tasks/{taskId}", { list: undefined }), {
    description: "Task sanitizada de um run.", mimeType: "application/json",
  }, async (uri, variables) => result(uri, await taskResource(config, Identifier.parse(variables.runId), Identifier.parse(variables.taskId))));

  server.registerResource("agentic-harness-run-artifacts", new ResourceTemplate("agent-harness://runs/{runId}/artifacts", { list: undefined }), {
    description: "Metadados confinados dos artefatos de um run.", mimeType: "application/json",
  }, async (uri, variables) => result(uri, await artifactsResource(config, Identifier.parse(variables.runId))));

  server.registerResource("agentic-harness-run-conflicts", new ResourceTemplate("agent-harness://runs/{runId}/conflicts", { list: undefined }), {
    description: "Conflitos sanitizados de um run.", mimeType: "application/json",
  }, async (uri, variables) => result(uri, await conflictsResource(config, Identifier.parse(variables.runId))));
}
