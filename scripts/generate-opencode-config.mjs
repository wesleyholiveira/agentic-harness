import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodebaseMemoryExecutable } from "./internal/tool-resolution.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.AGENT_HARNESS_ROOT || resolve(scriptDir, ".."));
const projectRoot = resolve(process.env.AGENT_HARNESS_PROJECT_ROOT || process.cwd());

function stripJsonComments(input) {
  return input
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function expand(value) {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, expand(nested)]));
  }
  if (typeof value !== "string") return value;
  return value
    .replaceAll("{env:AGENT_HARNESS_ROOT}", root.replaceAll("\\", "/"))
    .replaceAll("{env:AGENT_HARNESS_PROJECT_ROOT}", projectRoot.replaceAll("\\", "/"));
}

const configSource = await readFile(resolve(root, "config", "opencode.template.jsonc"), "utf8");
const config = expand(JSON.parse(stripJsonComments(configSource)));
config.mcp["context-engine"].url = process.env.AGENT_HARNESS_CONTEXT_ENGINE_MCP_URL?.trim() || "http://127.0.0.1:8789/mcp";
const context7Key = process.env.CONTEXT7_API_KEY?.trim();
if (config.mcp.context7) {
  config.mcp.context7.enabled = Boolean(context7Key);
  if (context7Key) {
    config.mcp.context7.headers = { Authorization: `Bearer ${context7Key}` };
  } else {
    delete config.mcp.context7.headers;
  }
}
const headroomPort = String(process.env.HEADROOM_PROXY_PORT ?? "8793").trim();
if (config.mcp.headroom) {
  config.mcp.headroom.command = [
    "uvx",
    "--isolated",
    "--managed-python",
    "--python",
    "3.12",
    "--from",
    "headroom-ai[mcp]==0.36.5",
    "headroom",
    "mcp",
    "serve",
    "--proxy-url",
    `http://127.0.0.1:${headroomPort}`,
  ];
}

const codebaseMemoryExecutable = resolveCodebaseMemoryExecutable(process.env);
if (config.mcp["codebase-memory-mcp"] && codebaseMemoryExecutable) {
  config.mcp["codebase-memory-mcp"].command = [codebaseMemoryExecutable];
}

if (process.env.AGENT_HARNESS_OPENCODE_RUNTIME_CHILD === "1") {
  for (const name of ["serena", "headroom", "codebase-memory-mcp", "caveman"]) {
    if (config.mcp[name]) config.mcp[name].enabled = false;
  }
}
config.agent = expand(JSON.parse(await readFile(resolve(root, ".opencode", "agents.generated.json"), "utf8")));

// The generated config is project runtime evidence, not reusable harness source.
// Keep it under the consuming repository so the harness submodule remains immutable
// and every .runtime artifact shares the AGENT_HARNESS_PROJECT_ROOT authority.
const runtimeDir = resolve(projectRoot, ".runtime");
await mkdir(runtimeDir, { recursive: true });
const output = resolve(runtimeDir, "opencode.effective.json");
await writeFile(output, `${JSON.stringify(config, null, 2)}\n`);
console.log(output);
