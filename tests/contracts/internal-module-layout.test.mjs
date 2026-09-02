import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("internal scripts keep valid local import targets after relocation", () => {
  const dir = resolve(root, "scripts/internal");
  const missing = [];
  for (const name of readdirSync(dir).filter((item) => item.endsWith(".mjs"))) {
    const file = resolve(dir, name);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolve(dirname(file), match[1]);
      if (!existsSync(target)) missing.push(`${name}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});
