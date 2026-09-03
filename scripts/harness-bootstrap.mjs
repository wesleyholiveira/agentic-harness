import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.env.AGENT_HARNESS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const project = resolve(process.argv[2] || process.env.AGENT_HARNESS_PROJECT_ROOT || process.cwd());
const configDir = resolve(project, ".agent-harness");
await mkdir(configDir, { recursive: true });
await writeFile(resolve(configDir, "config.json"), `${JSON.stringify({
  schemaVersion: 1,
  harnessRoot: relative(project, root).replaceAll("\\", "/"),
  projectRoot: ".",
  createdAt: new Date().toISOString(),
}, null, 2)}\n`);
console.log(JSON.stringify({
  ok: true,
  projectRoot: project,
  harnessRoot: root,
  projectRootResolution: {
    source: process.env.AGENT_HARNESS_PROJECT_ROOT_SOURCE || (process.argv[2] ? "launcher-positional" : "direct-resolution"),
    staleInheritedHarnessRootIgnored: process.env.AGENT_HARNESS_STALE_PROJECT_ROOT_IGNORED === "true",
  },
  next: "run <submodule>/bin/harness.mjs opencode",
}, null, 2));
