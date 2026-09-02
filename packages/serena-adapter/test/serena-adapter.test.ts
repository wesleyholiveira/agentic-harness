import { describe, expect, it } from "vitest";
import { SerenaAdapter } from "../src/serena-adapter";
import type { SymbolInfo } from "../src/types";

describe("SerenaAdapter", () => {
  it("returns null from getSymbol for V1 (not yet wired to Serena MCP)", async () => {
    const adapter = new SerenaAdapter("D:/agentic-harness-refactor-codebase-modernization");

    const symbol = await adapter.getSymbol("parseTranscript");

    expect(symbol).toBeNull();
  });

  it("returns an empty array from findReferences for V1", async () => {
    const adapter = new SerenaAdapter("D:/agentic-harness-refactor-codebase-modernization");

    const references = await adapter.findReferences("parseTranscript");

    expect(references).toEqual([]);
  });

  it("accepts a project path in the constructor", () => {
    const adapter = new SerenaAdapter("D:/agentic-harness-refactor-codebase-modernization");

    expect(adapter).toBeInstanceOf(SerenaAdapter);
  });

  it("exposes a correctly structured SymbolInfo type", () => {
    const symbolInfo: SymbolInfo = {
      name: "parseTranscript",
      kind: "function",
      file_path: "packages/core/src/parser.ts",
      start_line: 1,
      end_line: 42,
      body: "export function parseTranscript(...) { ... }",
    };

    expect(symbolInfo).toEqual({
      name: "parseTranscript",
      kind: "function",
      file_path: "packages/core/src/parser.ts",
      start_line: 1,
      end_line: 42,
      body: "export function parseTranscript(...) { ... }",
    });
  });
});
