import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const agentRoot = resolve(root, ".agents", "agents");
const localSkills = resolve(root, ".agents", "skills");
const lock = JSON.parse(readFileSync(resolve(root, "vendor/superpowers/lock.json"), "utf8"));

test("every agent skill reference resolves to a local harness skill or pinned Superpowers skill", () => {
  const missing = [];
  for (const entry of readdirSync(agentRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const manifest = JSON.parse(readFileSync(resolve(agentRoot, entry.name, "agent.json"), "utf8"));
    for (const skill of manifest.skills ?? []) {
      if (!existsSync(resolve(localSkills, skill, "SKILL.md"))) missing.push(`${manifest.id}:local:${skill}`);
    }
    for (const skill of manifest.superpowersSkills ?? []) {
      if (!lock.skills.includes(skill)) missing.push(`${manifest.id}:superpowers:${skill}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the complete pinned Superpowers v5.1.0 skill tree is vendored locally", () => {
  const vendorRoot = resolve(root, "vendor/superpowers/skills");
  const vendored = readdirSync(vendorRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(vendorRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
  assert.equal(lock.version, "v5.1.0");
  assert.equal(lock.skills.length, 14);
  assert.deepEqual(vendored, [...lock.skills].sort());
});
