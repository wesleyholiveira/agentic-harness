#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.env.AGENT_HARNESS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const EXPECTED = Object.freeze({
  agents: 20,
  harnessSkills: 22,
  superpowersSkills: 14,
  schemas: 11,
  migrations: 11,
  publicScripts: 10,
});

function directoriesWithFile(parent, marker) {
  const absolute = resolve(root, parent);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(absolute, entry.name, marker)))
    .map((entry) => entry.name)
    .sort();
}

function filesWithSuffix(parent, suffix) {
  const absolute = resolve(root, parent);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => entry.name)
    .sort();
}

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(root, "vendor/superpowers/lock.json"), "utf8"));
const agents = directoriesWithFile(".agents/agents", "agent.json");
const harnessSkills = directoriesWithFile(".agents/skills", "SKILL.md");
const superpowersSkills = directoriesWithFile("vendor/superpowers/skills", "SKILL.md");
const schemas = filesWithSuffix(".agents/schemas", ".json");
const migrations = filesWithSuffix("infra/postgres/migrations", ".sql");
const publicScripts = Object.keys(packageJson.scripts ?? {}).sort();

const actual = {
  agents: agents.length,
  harnessSkills: harnessSkills.length,
  superpowersSkills: superpowersSkills.length,
  schemas: schemas.length,
  migrations: migrations.length,
  publicScripts: publicScripts.length,
};
const mismatches = Object.entries(EXPECTED)
  .filter(([key, expected]) => actual[key] !== expected)
  .map(([key, expected]) => ({ key, expected, actual: actual[key] }));

const lockMatches = lock.version === "v5.1.0" && lock.skills?.length === EXPECTED.superpowersSkills;
const ok = mismatches.length === 0 && lockMatches;
const result = {
  ok,
  code: ok ? "agent_harness_source_inventory_matches_v1_contract" : "agent_harness_source_inventory_mismatch",
  contractVersion: "v1",
  expected: EXPECTED,
  actual,
  agents,
  harnessSkills,
  superpowers: {
    version: lock.version,
    lockedCount: Array.isArray(lock.skills) ? lock.skills.length : 0,
    vendored: superpowersSkills,
  },
  schemas,
  migrations,
  publicScripts,
  mismatches,
};

console.log(JSON.stringify(result, null, 2));
if (process.argv.includes("--check") && !result.ok) process.exitCode = 1;
