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

const runtimeChild = process.env.AGENT_HARNESS_OPENCODE_RUNTIME_CHILD === "1";
if (runtimeChild) {
  for (const name of ["serena", "headroom", "codebase-memory-mcp", "caveman"]) {
    if (config.mcp[name]) config.mcp[name].enabled = false;
  }
} else {
  // The persistent Main Orchestrator is only a Runtime ingress/egress control plane.
  // Superpowers injects using-superpowers into every OpenCode chat and its
  // brainstorming workflow requires a separate user approval before proceeding.
  // That process contract conflicts with mandatory runtime-continuation -> agent_start
  // ingress for an already-actionable delivery request. Keep Superpowers available
  // only to Runtime-dispatched specialist child processes.
  if (Array.isArray(config.plugin)) {
    config.plugin = config.plugin.filter((entry) => !String(entry).startsWith("superpowers@"));
  }
  if (Array.isArray(config.skills?.paths)) {
    config.skills.paths = config.skills.paths.filter((entry) => !String(entry).replaceAll("\\", "/").includes("/vendor/superpowers/skills"));
  }
}
config.agent = expand(JSON.parse(await readFile(resolve(root, ".opencode", "agents.generated.json"), "utf8")));

// Host effective configuration is project-owned runtime evidence under <consumer>/.runtime.
// Runtime children may provide AGENT_HARNESS_OPENCODE_CONFIG_OUTPUT to keep their
// container-specific config outside the bind-mounted consumer tree, preventing a
// later host regeneration from replacing Linux /workspace/* references with host paths.
const explicitOutput = process.env.AGENT_HARNESS_OPENCODE_CONFIG_OUTPUT?.trim();
const runtimeDir = resolve(projectRoot, ".runtime");
const output = explicitOutput
  ? resolve(explicitOutput)
  : resolve(runtimeDir, "opencode.effective.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(config, null, 2)}\n`);
console.log(output);
