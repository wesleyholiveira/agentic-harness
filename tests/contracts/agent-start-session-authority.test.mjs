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
