import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

function normalized(path) {
  return typeof path === "string" ? path.trim().replaceAll("\\", "/") : "";
}

export function resolveExecutable(command, { knownCandidates = [], env = process.env } = {}) {
  const requested = String(command ?? "").trim();
  if (!requested) return null;

  const candidates = [requested, ...knownCandidates].filter(Boolean);
  for (const candidate of candidates) {
    const value = String(candidate).trim();
    if (!value) continue;
    if ((isAbsolute(value) || /[\\/]/.test(value)) && existsSync(value)) return normalized(resolve(value));
  }

  const lookup = process.platform === "win32"
    ? spawnSync("where.exe", [requested], { encoding: "utf8", shell: false, windowsHide: true })
    : spawnSync("which", [requested], { encoding: "utf8", shell: false });
  if (lookup.status === 0) {
    const first = String(lookup.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first && existsSync(first)) return normalized(first);
  }
  return null;
}

export function resolveCodebaseMemoryExecutable(env = process.env) {
  const explicit = String(env.CODEBASE_MEMORY_MCP_COMMAND ?? "").trim();
  const windowsDefault = resolve(homedir(), ".cache", "codebase-memory-mcp", "codebase-memory-mcp.exe");
  const unixDefault = resolve(homedir(), ".cache", "codebase-memory-mcp", "codebase-memory-mcp");
  return resolveExecutable(explicit || "codebase-memory-mcp", {
    env,
    knownCandidates: [process.platform === "win32" ? windowsDefault : unixDefault],
  });
}
