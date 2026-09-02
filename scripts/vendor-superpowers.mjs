import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.env.AGENT_HARNESS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const lockPath = resolve(root, "vendor", "superpowers", "lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const version = process.env.SUPERPOWERS_VERSION || lock.version;
if (version !== lock.version) {
  console.error(`superpowers_lock_mismatch:${version}:${lock.version}`);
  process.exit(2);
}
const checkout = resolve(root, "vendor", "superpowers", ".upstream-tmp");
const skills = resolve(root, "vendor", "superpowers", "skills");
rmSync(checkout, { recursive: true, force: true });
const result = spawnSync("git", ["clone", "--depth", "1", "--branch", version, lock.source + ".git", checkout], {
  stdio: "inherit", shell: false,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
rmSync(skills, { recursive: true, force: true });
cpSync(resolve(checkout, "skills"), skills, { recursive: true });
const actual = readdirSync(skills, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const missing = lock.skills.filter((name) => !actual.includes(name));
if (missing.length > 0) {
  console.error(`superpowers_expected_skills_missing:${missing.join(",")}`);
  process.exit(1);
}
for (const candidate of ["LICENSE", "README.md"]) {
  const source = resolve(checkout, candidate);
  if (existsSync(source)) cpSync(source, resolve(root, "vendor", "superpowers", `UPSTREAM-${candidate}`));
}
rmSync(checkout, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, version, skills: actual.length, target: skills }, null, 2));
