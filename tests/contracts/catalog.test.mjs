import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentCatalog } from "../../.agents/runtime/agent-catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("distributed agent catalog replaces the monolithic graph registry", async () => {
  const catalog = await loadAgentCatalog(root);
  assert.equal(catalog.orchestrator, "main-orchestrator");
  assert.equal(catalog.authority, ".agents/agents/*/agent.json");
  assert.ok(catalog.agents.length >= 15);
  assert.ok(catalog.agents.some((agent) => agent.id === "security-reviewer"));
  for (const agent of catalog.agents) {
    assert.deepEqual(agent.dependsOn ?? [], []);
    assert.deepEqual(agent.canDelegateTo ?? [], []);
  }
});
