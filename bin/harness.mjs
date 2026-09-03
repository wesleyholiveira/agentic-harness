#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(process.env.AGENT_HARNESS_PROJECT_ROOT || process.cwd());
const cmd = process.argv[2] || "doctor";
const rest = process.argv.slice(3);
const env = { ...process.env, AGENT_HARNESS_ROOT: harnessRoot, AGENT_HARNESS_PROJECT_ROOT: projectRoot };

const defaultAuth = resolve(homedir(), ".local", "share", "opencode", "auth.json");
if (!env.AGENT_HARNESS_OPENCODE_AUTH_HOST_FILE && existsSync(defaultAuth)) {
  env.AGENT_HARNESS_OPENCODE_AUTH_HOST_FILE = defaultAuth;
}
if (!env.AGENT_HARNESS_OPENCODE_CONTINUATION_PASSWORD && env.OPENCODE_SERVER_PASSWORD) {
  env.AGENT_HARNESS_OPENCODE_CONTINUATION_PASSWORD = env.OPENCODE_SERVER_PASSWORD;
}
if (!env.AGENT_HARNESS_OPENCODE_CONTINUATION_USERNAME && env.OPENCODE_SERVER_USERNAME) {
  env.AGENT_HARNESS_OPENCODE_CONTINUATION_USERNAME = env.OPENCODE_SERVER_USERNAME;
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || harnessRoot,
    env: { ...env, ...(options.env || {}) },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

switch (cmd) {
  case "bootstrap": run(process.execPath, [resolve(harnessRoot, "scripts/harness-bootstrap.mjs"), projectRoot]); break;
  case "doctor": run(process.execPath, [resolve(harnessRoot, "scripts/harness-doctor.mjs"), projectRoot]); break;
  case "up": run("docker", ["compose", "--profile", "runtime", "up", "-d", "--build", ...rest]); break;
  case "down": run("docker", ["compose", "--profile", "runtime", "down", ...rest]); break;
  case "logs": run("docker", ["compose", "--profile", "runtime", "logs", "--tail", "200", ...rest]); break;
  case "migrate": run(process.execPath, [resolve(harnessRoot, "scripts/harness-migrate.mjs")]); break;
  case "test": run(process.execPath, [resolve(harnessRoot, "scripts/harness-test.mjs")]); break;
  case "qualify": run(process.execPath, [resolve(harnessRoot, "scripts/harness-qualify.mjs")]); break;
  case "opencode": run(process.execPath, [resolve(harnessRoot, "scripts/opencode-run.mjs"), ...rest], { cwd: projectRoot }); break;
  case "clean":
    rmSync(resolve(projectRoot, ".runtime", "agents"), { recursive: true, force: true });
    rmSync(resolve(projectRoot, ".runtime", "opencode.effective.json"), { force: true });
    break;
  default: console.error(`unknown harness command: ${cmd}`); process.exit(2);
}
