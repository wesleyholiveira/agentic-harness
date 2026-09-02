import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("harness launchers never route executable paths through a shell", async () => {
  const harness = await readFile(resolve(root, "bin", "harness.mjs"), "utf8");
  const opencode = await readFile(resolve(root, "scripts", "opencode-run.mjs"), "utf8");
  const doctor = await readFile(resolve(root, "scripts", "harness-doctor.mjs"), "utf8");
  const qualify = await readFile(resolve(root, "scripts", "harness-qualify.mjs"), "utf8");
  const vendor = await readFile(resolve(root, "scripts", "vendor-superpowers.mjs"), "utf8");

  for (const source of [harness, opencode, doctor, qualify, vendor]) {
    assert.doesNotMatch(source, /shell:\s*process\.platform\s*===\s*["']win32["']/);
  }
  assert.match(harness, /spawnSync\(command, args,[\s\S]*?shell:\s*false/);
  assert.match(opencode, /spawnSync\(["']opencode["'], args,[\s\S]*?shell:\s*false/);
  assert.match(doctor, /spawnSync\(binary, args,[\s\S]*?shell:\s*false/);
  assert.match(qualify, /spawnSync\(command, args,[\s\S]*?shell:\s*false/);
  assert.match(vendor, /spawnSync\(["']git["'][\s\S]*?shell:\s*false/);
});
