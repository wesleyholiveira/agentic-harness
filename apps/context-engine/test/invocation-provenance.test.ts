import { describe, expect, it } from "vitest";
import { InvocationProvenanceRegistry, invocationArgsDigest } from "../src/invocation-provenance.js";

describe("InvocationProvenanceRegistry current user message authority", () => {
  it("carries provenance-bound user message identity until the matching tool call consumes it", () => {
    const registry = new InvocationProvenanceRegistry();
    const args = { requestSource: "current-user-message", continuation: { sessionId: "ses_authoritative" } };
    const message = "Implement the complete modernization request.\n".repeat(2_000);

    registry.register({
      agentId: "main-orchestrator",
      toolName: "agent_start",
      argsDigest: invocationArgsDigest(args),
      origin: "explicit-human-turn",
      sessionId: "ses_authoritative",
      callId: "call-1",
      userMessageId: "msg-1",
      userMessageText: message,
      userMessageSha256: "sha256:fixture",
      userMessageBytes: Buffer.byteLength(message, "utf8"),
      observedAt: Date.now(),
    });

    const consumed = registry.consume({
      agentId: "main-orchestrator",
      toolName: "agent_start",
      argsDigest: invocationArgsDigest(args),
    });

    expect(consumed?.userMessageText).toBe(message);
    expect(consumed?.userMessageBytes).toBe(Buffer.byteLength(message, "utf8"));
    expect(registry.consume({
      agentId: "main-orchestrator",
      toolName: "agent_start",
      argsDigest: invocationArgsDigest(args),
    })).toBeNull();
  });
});
