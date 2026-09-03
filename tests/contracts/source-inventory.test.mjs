import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("source inventory counts harness-owned skills independently from vendored Superpowers", () => {
  const output = execFileSync(process.execPath, [resolve(root, "scripts/internal/source-inventory.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  const inventory = JSON.parse(output);
  assert.equal(inventory.expected.agents, 20);
  assert.equal(inventory.actual.agents, 20);
  assert.equal(inventory.expected.harnessSkills, 22);
  assert.equal(inventory.actual.harnessSkills, 22);
  assert.equal(inventory.harnessSkills.length, 22);
  assert.ok(inventory.harnessSkills.includes("sdd-workflow"));
  assert.ok(inventory.harnessSkills.includes("use-rtk"));
  assert.equal(inventory.superpowers.version, "v5.1.0");
  assert.equal(inventory.superpowers.lockedCount, 14);
  assert.equal(inventory.actual.superpowersSkills, 14);
  assert.equal(inventory.superpowers.vendored.length, 14);
  assert.equal(inventory.expected.schemas, 11);
  assert.equal(inventory.actual.schemas, 11);
  assert.equal(inventory.expected.migrations, 11);
  assert.equal(inventory.actual.migrations, 11);
  assert.equal(inventory.expected.publicScripts, 10);
  assert.equal(inventory.actual.publicScripts, 10);
});
