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

  it("materializes the current explicit human request from trusted sidechannel authority", () => {
    const args = {
      requestSource: "current-user-message" as const,
      continuation: {
        sessionId: "ses_model_copy_with_typo",
        directory: "/workspace/repository",
      },
    };

    const result = authoritativeAgentStartArgs(args, {
      transport: "http",
      agentId: "main-orchestrator",
      invocationOrigin: "explicit-human-turn",
      invocationProvenanceSource: "opencode-plugin-sidechannel",
      invocationSessionId: "ses_authoritative_current_session",
      invocationUserMessageId: "msg_authoritative",
      invocationUserMessageText: "Implement the full committed modernization package.\n".repeat(4_000),
      invocationUserMessageSha256: "sha256:fixture",
      invocationUserMessageBytes: 200_000,
    });

    expect(result.request).toContain("Implement the full committed modernization package.");
    expect(result.requestSource).toBeUndefined();
    expect(result.continuation?.sessionId).toBe("ses_authoritative_current_session");
    expect(args).not.toHaveProperty("request");
  });

  it("fails closed for untrusted/non-human current-message sourcing and inline conflicts", () => {
    const args = {
      requestSource: "current-user-message" as const,
      continuation: { sessionId: "ses_target" },
    };

    expect(() => authoritativeAgentStartArgs(args, {
      transport: "http",
      agentId: "main-orchestrator",
      invocationOrigin: "durable-continuation",
      invocationProvenanceSource: "opencode-plugin-sidechannel",
      invocationSessionId: "ses_target",
      invocationUserMessageText: "Runtime continuation event.",
    })).toThrow("agent_start_current_user_message_provenance_required");

    expect(() => authoritativeAgentStartArgs({ ...args, request: "model copy" }, {
      transport: "http",
      agentId: "main-orchestrator",
      invocationOrigin: "explicit-human-turn",
      invocationProvenanceSource: "opencode-plugin-sidechannel",
      invocationSessionId: "ses_target",
      invocationUserMessageText: "human authority",
    })).toThrow("agent_start_request_source_conflict");

    expect(() => authoritativeAgentStartArgs(args, {
      transport: "http",
      agentId: "main-orchestrator",
      invocationOrigin: "explicit-human-turn",
      invocationProvenanceSource: "opencode-plugin-sidechannel",
      invocationSessionId: "ses_target",
      invocationUserMessageText: null,
    })).toThrow("agent_start_current_user_message_text_missing");
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
