import { tool } from "@opencode-ai/plugin";

/**
 * Capture the local OpenCode session identity without asking the LLM to guess it.
 * The continuation server URL and credentials remain deployment configuration;
 * this tool intentionally never returns either value to the model.
 */
export default tool({
  description: "Return the current OpenCode session context for a durable Agentic Harness Runtime V2 continuation.",
  args: {},
  async execute(_args, context) {
    return JSON.stringify({
      schemaVersion: "opencode-runtime-continuation-context/v1",
      sessionId: context.sessionID,
      messageId: context.messageID,
      directory: context.directory,
      worktree: context.worktree,
      continuation: {
        sessionId: context.sessionID,
        directory: context.worktree || context.directory,
        wakeOn: ["run.completed", "run.failed", "run.blocked", "run.cancelled"],
      },
      security: {
        serverUrlReturned: false,
        credentialsReturned: false,
      },
    });
  },
});
