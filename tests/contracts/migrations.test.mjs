import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dir = resolve(root, "infra/postgres/migrations");

test("standalone migrations include runtime authority and durable continuation", () => {
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.length >= 10);
  const sql = files.map((name) => readFileSync(resolve(dir, name), "utf8")).join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS agent_runs/);
  assert.match(sql, /agent_runtime_outbox/);
  assert.match(sql, /agent_continuations/);
  assert.match(sql, /agent_runtime_inbox/);
  const legacyProductToken = ["clip", "compass"].join("_");
  assert.equal(new RegExp(`${legacyProductToken}|transcription|semantic_analysis`, "i").test(sql), false);
});
