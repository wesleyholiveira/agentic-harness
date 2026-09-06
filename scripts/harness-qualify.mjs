import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.env.AGENT_HARNESS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const command = process.execPath;
const args = [resolve(root, "scripts", "qualification", "standalone-v1.mjs"), ...process.argv.slice(2)];
const result = spawnSync(command, args, {
  cwd: root,
  env: { ...process.env, AGENT_HARNESS_ROOT: root },
  stdio: "inherit",
  windowsHide: true,
  shell: false,
});
if (result.error) {
  console.error(`qualification_command_unavailable:${command}:${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
