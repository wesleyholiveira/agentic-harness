import { describe, expect, it } from "vitest";
import { authoritativeAgentStartArgs } from "../src/tools/agent-runtime.js";

describe("agent_start continuation session authority", () => {
  it("canonicalizes a copied session id from trusted Main Orchestrator sidechannel provenance", () => {
    const args = {
      request: "Implement the fixture.",
      continuation: {
        sessionId: "ses_model_copy_with_typo",
        directory: "/workspace/repository",
        wakeOn: ["run.completed"],
      },
    };

    const result = authoritativeAgentStartArgs(args, {
      transport: "http",
      agentId: "main-orchestrator",
      invocationProvenanceSource: "opencode-plugin-sidechannel",
      invocationSessionId: "ses_authoritative_current_session",
    });

    expect(result).not.toBe(args);
    expect(result.continuation).toEqual({
      sessionId: "ses_authoritative_current_session",
      directory: "/workspace/repository",
      wakeOn: ["run.completed"],
    });
    expect(args.continuation.sessionId).toBe("ses_model_copy_with_typo");
  });

  it("preserves an already-correct trusted session", () => {
    const args = {
      request: "Implement the fixture.",
      continuation: {
        sessionId: "ses_authoritative_current_session",
        directory: "/workspace/repository",
      },
    };

    expect(authoritativeAgentStartArgs(args, {
      transport: "http",
      agentId: "main-orchestrator",
      invocationProvenanceSource: "opencode-plugin-sidechannel",
      invocationSessionId: "ses_authoritative_current_session",
    })).toBe(args);
  });

  it("does not rewrite non-HTTP or untrusted ingress", () => {
    const args = {
      request: "Operator flow.",
      continuation: {
        sessionId: "ses_operator_target",
        directory: "/workspace/repository",
      },
    };

    expect(authoritativeAgentStartArgs(args, {
      transport: "stdio",
      agentId: "main-orchestrator",
      invocationProvenanceSource: null,
      invocationSessionId: "ses_other",
    })).toBe(args);

    expect(authoritativeAgentStartArgs(args, {
      transport: "http",
      agentId: "main-orchestrator",
      invocationProvenanceSource: "missing",
      invocationSessionId: "ses_other",
    })).toBe(args);
  });

  it("does not synthesize continuation intent when continuation is absent", () => {
    const args = { request: "No continuation operator flow." };

    expect(authoritativeAgentStartArgs(args, {
      transport: "http",
      agentId: "main-orchestrator",
      invocationProvenanceSource: "opencode-plugin-sidechannel",
      invocationSessionId: "ses_authoritative_current_session",
    })).toBe(args);
  });
});
