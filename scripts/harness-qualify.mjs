import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.env.AGENT_HARNESS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const commands = [
  [process.execPath, [resolve(root, "scripts", "harness-test.mjs")]],
  ["cargo", ["check", "--manifest-path", resolve(root, "apps", "runtime-worker", "Cargo.toml")]],
];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`qualification_command_unavailable:${command}:${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("standalone harness qualification PASS");
