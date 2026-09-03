import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodebaseMemoryExecutable } from "./internal/tool-resolution.mjs";
import { resolveComposeProjectIdentity } from "./internal/compose-project-identity.mjs";

const root = resolve(process.env.AGENT_HARNESS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const project = resolve(process.argv[2] || process.env.AGENT_HARNESS_PROJECT_ROOT || process.cwd());
const composeProject = resolveComposeProjectIdentity(project, process.env);
function probe(binary, args = ["--version"]) {
  const result = spawnSync(binary, args, { stdio: "ignore", shell: false });
  return result.status === 0;
}
const codebaseMemoryExecutable = resolveCodebaseMemoryExecutable(process.env);
const codebaseMemoryResolved = Boolean(codebaseMemoryExecutable) && existsSync(codebaseMemoryExecutable);
const binary = Object.fromEntries([
  ["node", probe("node")], ["git", probe("git")], ["docker", probe("docker")],
  ["opencode", probe("opencode")], ["uvx", probe("uvx")], ["cargo", probe("cargo")], ["rtk", probe("rtk")],
  // codebase-memory-mcp is an MCP stdio server. Availability here means its executable
  // resolves to a real file; functional initialize/list-tools connectivity belongs to
  // the MCP qualification gate. Do not require an optional `--version` CLI contract.
  ["codebase-memory-mcp", codebaseMemoryResolved],
]);
const required = [
  ".agents/workflow.json", ".agents/model-routing.json", ".opencode/plugins/runtime-invocation-provenance.js",
  "apps/context-engine/src/http.ts", "apps/runtime-worker/src/agent_runtime.rs", "compose.yaml",
];
const files = Object.fromEntries(required.map((path) => [path, existsSync(resolve(root, path))]));
const agentDir = resolve(root, ".agents", "agents");
const agentCount = existsSync(agentDir) ? readdirSync(agentDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0;
const superpowersLock = JSON.parse(readFileSync(resolve(root, "vendor", "superpowers", "lock.json"), "utf8"));
const superpowersDir = resolve(root, "vendor", "superpowers", "skills");
const vendoredSuperpowers = existsSync(superpowersDir)
  ? readdirSync(superpowersDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  : [];
const missingSuperpowers = superpowersLock.skills.filter((name) => !vendoredSuperpowers.includes(name));
const ok = Object.values(files).every(Boolean) && agentCount > 0 && binary.node && binary.git;
console.log(JSON.stringify({
  ok, harnessRoot: root, projectRoot: project, composeProject, binary, codebaseMemoryExecutable, files, agentCount,
  codebaseMemory: {
    requiredWhenEnabled: true,
    resolved: codebaseMemoryResolved,
    executable: codebaseMemoryExecutable,
    availabilityProof: codebaseMemoryResolved ? "executable-resolved" : "unresolved",
    mcpHandshake: "not-run-by-doctor",
    qualificationGate: "prove initialize/list-tools connectivity in MCP integration gate",
  },
  superpowers: {
    version: superpowersLock.version,
    vendoredSkills: vendoredSuperpowers.length,
    expectedSkills: superpowersLock.skills.length,
    complete: missingSuperpowers.length === 0,
    missing: missingSuperpowers,
    repair: missingSuperpowers.length ? "node scripts/vendor-superpowers.mjs (requires network once; commit vendor/superpowers/skills afterward)" : null,
  },
  optionalRequirements: {
    docker: "required for harness:up/runtime integration",
    opencode: "required for harness:opencode",
    uvx: "required for Serena/Headroom",
    cargo: "required to build/qualify the Rust worker",
    rtk: "optional context-reduction helper",
    codebaseMemory: "executable resolution is checked here; MCP handshake is checked in integration qualification",
  },
}, null, 2));
process.exit(ok ? 0 : 1);
