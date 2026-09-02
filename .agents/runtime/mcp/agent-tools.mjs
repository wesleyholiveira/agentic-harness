import { z } from "zod";
import { agentMcpError } from "./agent-errors.mjs";
import { runtimeDoctor, runtimeStatus, runtimeSummary, validateRuntimeArtifact } from "./agent-runtime.mjs";

const Identifier = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const Output = { data: z.unknown() };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function success(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: { data } };
}

function failure(error) {
  const data = agentMcpError(error);
  return { content: [{ type: "text", text: JSON.stringify(data) }], isError: true };
}

export function registerAgentTools(server, config) {
  if (config.actions.has("status")) server.registerTool("clip_compass_agents_status", {
    description: "Consulta runs e tasks do runtime multiagente sem expor requests ou comandos.",
    annotations: readOnly,
    inputSchema: { runId: Identifier.optional() },
    outputSchema: Output,
  }, async ({ runId }) => {
    try { return success(await runtimeStatus(config, runId ?? null)); } catch (error) { return failure(error); }
  });

  if (config.actions.has("summary")) server.registerTool("clip_compass_agents_summary", {
    description: "Consulta métricas agregadas e summary sanitizado do runtime multiagente.",
    annotations: readOnly,
    inputSchema: { runId: Identifier.optional() },
    outputSchema: Output,
  }, async ({ runId }) => {
    try { return success(await runtimeSummary(config, runId ?? null)); } catch (error) { return failure(error); }
  });

  if (config.actions.has("validate")) server.registerTool("clip_compass_agents_validate_artifact", {
    description: "Valida um objeto fornecido pelo cliente contra um schema existente, sem ler paths arbitrários.",
    annotations: readOnly,
    inputSchema: {
      schemaName: z.enum(["taskBrief", "contextPacket", "handoffResult", "integrationDecision", "executionPlan"]),
      artifact: z.unknown(),
    },
    outputSchema: Output,
  }, async ({ schemaName, artifact }) => {
    try { return success(await validateRuntimeArtifact(config, schemaName, artifact)); } catch (error) { return failure(error); }
  });

  if (config.actions.has("doctor")) server.registerTool("clip_compass_agents_doctor", {
    description: "Executa os diagnósticos read-only do runtime multiagente.",
    annotations: readOnly,
    outputSchema: Output,
  }, async () => {
    try { return success(await runtimeDoctor(config)); } catch (error) { return failure(error); }
  });
}
