export class AgentMcpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentMcpError";
    this.code = code;
  }
}

export function agentMcpError(error) {
  if (error instanceof AgentMcpError) return { code: error.code, message: error.message };
  return { code: "internal_error", message: "Falha interna no MCP do runtime multiagente." };
}
