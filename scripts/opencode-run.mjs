import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runHeadroomOpenCode } from "./internal/headroom-opencode.mjs";

const root = resolve(process.env.AGENT_HARNESS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const project = resolve(process.env.AGENT_HARNESS_PROJECT_ROOT || process.cwd());

for (const legacyName of ["opencode.json", "opencode.jsonc"]) {
  const legacyPath = resolve(root, legacyName);
  if (existsSync(legacyPath)) {
    console.error(`agent_harness_legacy_opencode_project_config_present:${legacyPath}`);
    console.error("Remove the legacy root OpenCode config. The harness template now lives at config/opencode.template.jsonc.");
    process.exit(2);
  }
}
const generator = spawnSync(process.execPath, [resolve(root, "scripts", "generate-opencode-config.mjs")], {
  cwd: project,
  env: { ...process.env, AGENT_HARNESS_ROOT: root, AGENT_HARNESS_PROJECT_ROOT: project },
  encoding: "utf8",
});
if (generator.error) throw generator.error;
if (generator.status !== 0) {
  process.stderr.write(generator.stderr || "");
  process.exit(generator.status ?? 1);
}
const effective = (generator.stdout || "").trim().split(/\r?\n/).at(-1);
const env = {
  ...process.env,
  AGENT_HARNESS_ROOT: root,
  AGENT_HARNESS_PROJECT_ROOT: project,
  OPENCODE_CONFIG: effective,
  OPENCODE_CONFIG_DIR: resolve(root, ".opencode"),
};
const args = process.argv.slice(2);
if (!args.includes("--hostname")) args.push("--hostname", "0.0.0.0");
if (!args.includes("--port")) args.push("--port", env.OPENCODE_PORT || "4096");

if (String(env.AGENT_HARNESS_HEADROOM_ENABLED ?? "true").toLowerCase() !== "false") {
  process.exitCode = await runHeadroomOpenCode(args, env);
} else {
  const result = spawnSync("opencode", args, { cwd: project, env, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
