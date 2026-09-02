import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

const DEFAULT_CBM_BINARY = "codebase-memory-mcp";

export interface ResolvedCbmCommand {
  binary: string;
  args: string[];
  source: "environment" | "opencode-config" | "path-default";
  configPath?: string;
}

function findOpencodeConfig(startDir: string): string | null {
  let current = resolve(startDir);
  const root = parse(current).root;

  while (true) {
    const candidate = join(current, "opencode.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    if (current === root) {
      return null;
    }
    current = dirname(current);
  }
}

export function resolveCodebaseMemoryCommand(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCbmCommand {
  const configuredBinary = env.CODEBASE_MEMORY_MCP_BINARY?.trim();
  if (configuredBinary) {
    return { binary: configuredBinary, args: [], source: "environment" };
  }

  const explicitConfig = env.OPENCODE_CONFIG?.trim();
  const configPath = explicitConfig
    ? isAbsolute(explicitConfig)
      ? explicitConfig
      : resolve(cwd, explicitConfig)
    : findOpencodeConfig(cwd);

  if (configPath && existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        mcp?: Record<string, { command?: unknown }>;
      };
      const command = config.mcp?.["codebase-memory-mcp"]?.command;
      if (Array.isArray(command) && typeof command[0] === "string" && command[0].trim()) {
        return {
          binary: command[0].trim(),
          args: command.slice(1).filter((value): value is string => typeof value === "string"),
          source: "opencode-config",
          configPath,
        };
      }
    } catch {
      // OpenCode configuration is advisory for binary discovery. If it is
      // unreadable, fall back to PATH and let Context Engine health expose the
      // concrete executable failure instead of preventing server startup.
    }
  }

  return { binary: DEFAULT_CBM_BINARY, args: [], source: "path-default" };
}
