import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

test("current user message request authority is transported out-of-band and bounded", () => {
  const plugin = readFileSync(resolve(root, ".opencode/plugins/runtime-invocation-provenance.js"), "utf8");
  const http = readFileSync(resolve(root, "apps/context-engine/src/http.ts"), "utf8");
  const tool = readFileSync(resolve(root, "apps/context-engine/src/tools/agent-runtime.ts"), "utf8");

  assert.match(plugin, /MAX_AGENT_START_USER_MESSAGE_BYTES = 1024 \* 1024/u);
  assert.match(plugin, /agentStartUserMessageAuthority/u);
  assert.match(plugin, /userMessageSha256/u);
  assert.match(http, /normalizeInvocationUserMessageAuthority/u);
  assert.match(http, /runtime_invocation_user_message_identity_invalid/u);
  assert.match(http, /runtime_invocation_user_message_hash_mismatch/u);
  assert.match(tool, /requestSource: z\.literal\("current-user-message"\)/u);
  assert.match(tool, /request: z\.string\(\)\.min\(1\)\.optional\(\)/u);
});

test("provenance logging records only message identity, never current human text", () => {
  const http = readFileSync(resolve(root, "apps/context-engine/src/http.ts"), "utf8");
  const logBlock = http.slice(http.indexOf("const invocationLogContext"), http.indexOf("const requestStartedAt"));
  assert.match(logBlock, /invocationUserMessageSha256/u);
  assert.match(logBlock, /invocationUserMessageBytes/u);
  assert.doesNotMatch(logBlock, /invocationUserMessageText/u);
});

test("persistent Main Orchestrator is instructed not to reserialize long delivery prompts", () => {
  const agent = readFileSync(resolve(root, ".agents/agents/main-orchestrator/AGENT.md"), "utf8");
  assert.match(agent, /requestSource="current-user-message"/u);
  assert.match(agent, /never copy or regenerate a long human request into tool-call JSON/u);
});
