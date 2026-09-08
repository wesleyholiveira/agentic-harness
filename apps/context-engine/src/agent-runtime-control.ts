import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { ContextProvider } from "./runtime-services.js";

type ControlPlane = {
  start(input: Record<string, unknown>, invocation?: Record<string, unknown>): Promise<unknown>;
  status(runId?: string | null): Promise<unknown>;
  getDag(runId: string): Promise<unknown>;
  wait(runId: string, options?: Record<string, unknown>): Promise<unknown>;
  bindContinuation(runId: string, continuation: Record<string, unknown>): Promise<unknown>;
  resume(runId: string): Promise<unknown>;
  retry(runId: string, taskId: string): Promise<unknown>;
  cancel(runId: string): Promise<unknown>;
  summary(runId?: string | null): Promise<unknown>;
  efficiency(runId: string): Promise<unknown>;
  getAgentInputArtifact(input: Record<string, unknown>): Promise<unknown>;
  progress(runId?: string | null, options?: { includeEfficiency?: boolean }): Promise<unknown>;
  progressForSession(sessionId: string, options?: { includeEfficiency?: boolean }): Promise<unknown>;
  recordProgressObservation(observation: Record<string, unknown>): Promise<unknown>;
  doctor(): Promise<unknown>;
  assertObservationAllowed(toolName: string, runId?: string | null, invocation?: Record<string, unknown>): Promise<unknown>;
};

export class AgentRuntimeControlAdapter {
  private controlPromise?: Promise<ControlPlane>;

  constructor(
    private repositoryRoot: string,
    private contextProvider: ContextProvider,
    private harnessRoot: string = process.env.AGENT_HARNESS_ROOT?.trim() || repositoryRoot,
  ) {}

  private async control(): Promise<ControlPlane> {
    if (!this.controlPromise) {
      this.controlPromise = (async () => {
        // Runtime source is owned by the harness repository while workspaces,
        // PRDs/ADRs and generated run evidence belong to the consuming project.
        const modulePath = resolve(this.harnessRoot, ".agents", "runtime", "control-plane.mjs");
        const moduleUrl = pathToFileURL(modulePath).href;
        const runtimeModule = (await import(moduleUrl)) as {
          AgentRuntimeControlPlane: new (options: Record<string, unknown>) => ControlPlane;
        };
        return new runtimeModule.AgentRuntimeControlPlane({
          repositoryRoot: this.repositoryRoot,
          harnessRoot: this.harnessRoot,
          contextProvider: this.contextProvider,
          // The same control adapter runs under stdio (host) and Streamable HTTP
          // (container). Let the normal database resolver choose host/compose
          // semantics from AGENT_HARNESS_AGENT_DATABASE_NETWORK_MODE instead of
          // baking host networking into the MCP adapter.
          databaseNetworkMode: process.env.AGENT_HARNESS_AGENT_DATABASE_NETWORK_MODE ?? "auto",
        });
      })();
    }
    return await this.controlPromise;
  }

  async start(input: Record<string, unknown>, invocation?: Record<string, unknown>): Promise<unknown> { return await (await this.control()).start(input, invocation); }
  async status(runId?: string | null): Promise<unknown> { return await (await this.control()).status(runId); }
  async getDag(runId: string): Promise<unknown> { return await (await this.control()).getDag(runId); }
  async wait(runId: string, options?: Record<string, unknown>): Promise<unknown> { return await (await this.control()).wait(runId, options); }
  async bindContinuation(runId: string, continuation: Record<string, unknown>): Promise<unknown> { return await (await this.control()).bindContinuation(runId, continuation); }
  async resume(runId: string): Promise<unknown> { return await (await this.control()).resume(runId); }
  async retry(runId: string, taskId: string): Promise<unknown> { return await (await this.control()).retry(runId, taskId); }
  async cancel(runId: string): Promise<unknown> { return await (await this.control()).cancel(runId); }
  async summary(runId?: string | null): Promise<unknown> { return await (await this.control()).summary(runId); }
  async efficiency(runId: string): Promise<unknown> { return await (await this.control()).efficiency(runId); }
  async getAgentInputArtifact(input: Record<string, unknown>): Promise<unknown> { return await (await this.control()).getAgentInputArtifact(input); }
  async progress(runId?: string | null, options?: { includeEfficiency?: boolean }): Promise<unknown> { return await (await this.control()).progress(runId, options); }
  async progressForSession(sessionId: string, options?: { includeEfficiency?: boolean }): Promise<unknown> { return await (await this.control()).progressForSession(sessionId, options); }
  async recordProgressObservation(observation: Record<string, unknown>): Promise<unknown> { return await (await this.control()).recordProgressObservation(observation); }
  async doctor(): Promise<unknown> { return await (await this.control()).doctor(); }
  async assertObservationAllowed(toolName: string, runId?: string | null, invocation?: Record<string, unknown>): Promise<unknown> { return await (await this.control()).assertObservationAllowed(toolName, runId, invocation); }
}
