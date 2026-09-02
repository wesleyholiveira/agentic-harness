import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodebaseMemoryCommand } from "../src/cbm-command-resolver.js";

describe("resolveCodebaseMemoryCommand", () => {
  it("prefers CODEBASE_MEMORY_MCP_BINARY over repository configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "context-engine-cbm-env-"));
    try {
      writeFileSync(
        join(root, "opencode.json"),
        JSON.stringify({ mcp: { "codebase-memory-mcp": { command: ["from-config"] } } }),
      );

      expect(
        resolveCodebaseMemoryCommand(root, { CODEBASE_MEMORY_MCP_BINARY: "from-env" }),
      ).toEqual({ binary: "from-env", args: [], source: "environment" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses the codebase-memory-mcp command from the nearest opencode.json", () => {
    const root = mkdtempSync(join(tmpdir(), "context-engine-cbm-config-"));
    const nested = join(root, "apps", "context-engine");
    mkdirSync(nested, { recursive: true });
    const configPath = join(root, "opencode.json");
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcp: {
            "codebase-memory-mcp": {
              type: "local",
              enabled: true,
              command: ["C:/Users/test/.cache/codebase-memory-mcp/codebase-memory-mcp.exe"],
            },
          },
        }),
      );

      expect(resolveCodebaseMemoryCommand(nested, {})).toEqual({
        binary: "C:/Users/test/.cache/codebase-memory-mcp/codebase-memory-mcp.exe",
        args: [],
        source: "opencode-config",
        configPath,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors an explicit OPENCODE_CONFIG path", () => {
    const root = mkdtempSync(join(tmpdir(), "context-engine-cbm-explicit-"));
    const configPath = join(root, "custom-opencode.json");
    try {
      writeFileSync(
        configPath,
        JSON.stringify({ mcp: { "codebase-memory-mcp": { command: ["custom-cbm"] } } }),
      );

      expect(resolveCodebaseMemoryCommand(root, { OPENCODE_CONFIG: configPath })).toEqual({
        binary: "custom-cbm",
        args: [],
        source: "opencode-config",
        configPath,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to PATH resolution when no explicit or repository command exists", () => {
    const root = mkdtempSync(join(tmpdir(), "context-engine-cbm-path-"));
    try {
      expect(resolveCodebaseMemoryCommand(root, {})).toEqual({
        binary: "codebase-memory-mcp",
        args: [],
        source: "path-default",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves configured codebase-memory-mcp command arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "context-engine-cbm-args-"));
    const configPath = join(root, "opencode.json");
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcp: {
            "codebase-memory-mcp": {
              command: ["custom-cbm", "--transport", "stdio", "--log-level", "warn"],
            },
          },
        }),
      );

      expect(resolveCodebaseMemoryCommand(root, {})).toEqual({
        binary: "custom-cbm",
        args: ["--transport", "stdio", "--log-level", "warn"],
        source: "opencode-config",
        configPath,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
