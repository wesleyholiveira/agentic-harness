import { AsyncLocalStorage } from "node:async_hooks";

export type ContextEngineInvocationOrigin =
  | "explicit-human-turn"
  | "autonomous-assistant"
  | "durable-continuation"
  | "qualification-harness"
  | "unknown";

export interface ContextEngineRequestContext {
  transport: "http";
  agentId: string | null;
  invocationOrigin: ContextEngineInvocationOrigin;
  invocationSessionId: string | null;
  invocationCallId: string | null;
  invocationUserMessageId: string | null;
  invocationProvenanceSource: "opencode-plugin-sidechannel" | "missing";
}

const requestContext = new AsyncLocalStorage<ContextEngineRequestContext>();

export function runWithContextEngineRequestContext<T>(
  context: ContextEngineRequestContext,
  fn: () => T,
): T {
  return requestContext.run(context, fn);
}

export function getContextEngineRequestContext(): ContextEngineRequestContext | undefined {
  return requestContext.getStore();
}
