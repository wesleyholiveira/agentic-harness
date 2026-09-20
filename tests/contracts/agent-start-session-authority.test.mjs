import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

test("agent_start canonicalizes continuation session from trusted plugin-sidechannel ingress", () => {
  const source = readFileSync(resolve(root, "apps/context-engine/src/tools/agent-runtime.ts"), "utf8");

  assert.match(source, /export function authoritativeAgentStartArgs/u);
  assert.match(source, /invocationProvenanceSource !== "opencode-plugin-sidechannel"/u);
  assert.match(source, /sessionId: trustedSessionId/u);
  assert.match(source, /const authoritativeArgs = authoritativeAgentStartArgs\(args, requestContext\)/u);
  assert.match(source, /control\.start\(authoritativeArgs, \{/u);
});

test("agent_start session canonicalization preserves explicit continuation intent boundary", () => {
  const source = readFileSync(resolve(root, "apps/context-engine/src/tools/agent-runtime.ts"), "utf8");

  assert.match(source, /if \(!args\?\.continuation\) return args;/u);
  assert.match(source, /if \(requestContext\?\.transport !== "http"\) return args;/u);
  assert.match(source, /if \(requestContext\.agentId\?\.trim\(\) !== "main-orchestrator"\) return args;/u);
});


test("agent_start can source the authoritative request from the current explicit human message", () => {
  const toolSource = readFileSync(resolve(root, "apps/context-engine/src/tools/agent-runtime.ts"), "utf8");
  const httpSource = readFileSync(resolve(root, "apps/context-engine/src/http.ts"), "utf8");
  const pluginSource = readFileSync(resolve(root, ".opencode/plugins/runtime-invocation-provenance.js"), "utf8");

  assert.match(toolSource, /requestSource: z\.literal\("current-user-message"\)/u);
  assert.match(toolSource, /agent_start_current_user_message_provenance_required/u);
  assert.match(toolSource, /invocationUserMessageText/u);
  assert.match(pluginSource, /userMessageText/u);
  assert.match(pluginSource, /MAX_AGENT_START_USER_MESSAGE_BYTES/u);
  assert.match(httpSource, /runtime_invocation_user_message_hash_mismatch/u);
  assert.match(httpSource, /invocationLogContext/u);
  assert.doesNotMatch(httpSource, /\.\.\.requestDescription, callerAgentId: normalizedCallerAgentId, \.\.\.invocationContext,/u);
});
