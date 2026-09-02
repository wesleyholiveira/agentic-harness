import type { SymbolInfo } from "./types";

export class SerenaAdapter {
  constructor(readonly projectPath: string) {}

  async getSymbol(namePath: string): Promise<SymbolInfo | null> {
    // V1: Serena integration via MCP tools — returns null until wired
    void namePath;
    return null;
  }

  async findReferences(namePath: string): Promise<string[]> {
    // V1: Serena integration via MCP tools — returns null until wired
    void namePath;
    return [];
  }
}
