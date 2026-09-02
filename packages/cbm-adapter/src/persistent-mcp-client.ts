import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLIENT_VERSION = "1.2.0";
const STDERR_LIMIT = 8_000;

interface Session {
  client: Client;
  transport: StdioClientTransport;
  connectedAt: number;
}

export interface PersistentMcpDiagnostics {
  state: "idle" | "connecting" | "connected" | "disconnected";
  pid: number | null;
  connected_at?: string;
  reconnects: number;
  calls: number;
  last_error?: string;
  stderr_tail?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableTransportFailure(message: string): boolean {
  return /(connection|closed|not connected|transport|econn|epipe|request.*timeout|timed out|abort)/i.test(message);
}

function toolErrorText(result: unknown): string {
  if (!result || typeof result !== "object") return String(result);
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = (entry as Record<string, unknown>).text;
      return typeof value === "string" ? [value] : [];
    })
    .join("\n")
    .trim();
  return text || JSON.stringify(record);
}

function extractToolText(tool: string, result: unknown): string {
  if (!result || typeof result !== "object") {
    throw new Error(`cbm_mcp_invalid_result:${tool}`);
  }
  const record = result as Record<string, unknown>;
  if (record.isError === true) {
    throw new Error(`cbm_mcp_tool_error:${tool}:${toolErrorText(record)}`);
  }
  if (record.structuredContent !== undefined && record.structuredContent !== null) {
    return typeof record.structuredContent === "string"
      ? record.structuredContent
      : JSON.stringify(record.structuredContent);
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = (entry as Record<string, unknown>).text;
      return typeof value === "string" ? [value] : [];
    })
    .join("\n")
    .trim();
  if (text) return text;
  return JSON.stringify(content);
}

export interface PersistentToolClient {
  getDiagnostics(): PersistentMcpDiagnostics;
  close(): Promise<void>;
  callTool(tool: string, input: Record<string, unknown>, timeoutMs: number): Promise<string>;
}

export class PersistentMcpToolClient implements PersistentToolClient {
  private session: Session | undefined;
  private connecting: Promise<Session> | undefined;
  private reconnects = 0;
  private calls = 0;
  private lastError: string | undefined;
  private stderrTail = "";

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly cwd?: string,
  ) {}

  getDiagnostics(): PersistentMcpDiagnostics {
    const pid = this.session?.transport.pid ?? null;
    let state: PersistentMcpDiagnostics["state"] = "idle";
    if (this.connecting) state = "connecting";
    else if (this.session && pid !== null) state = "connected";
    else if (this.session) state = "disconnected";
    return {
      state,
      pid,
      ...(this.session ? { connected_at: new Date(this.session.connectedAt).toISOString() } : {}),
      reconnects: this.reconnects,
      calls: this.calls,
      ...(this.lastError ? { last_error: this.lastError } : {}),
      ...(this.stderrTail ? { stderr_tail: this.stderrTail } : {}),
    };
  }

  async close(): Promise<void> {
    await this.resetSession(false);
  }

  async callTool(tool: string, input: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const startedAt = Date.now();
    const remaining = () => Math.max(250, timeoutMs - (Date.now() - startedAt));
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const session = await this.ensureSession(remaining());
        const request = Object.keys(input).length > 0
          ? { name: tool, arguments: input }
          : { name: tool };
        const result = await session.client.callTool(
          request,
          undefined,
          { timeout: remaining(), maxTotalTimeout: remaining() },
        );
        this.calls += 1;
        this.lastError = undefined;
        return extractToolText(tool, result);
      } catch (error) {
        lastError = error;
        this.lastError = errorMessage(error);
        const retryable = isRetryableTransportFailure(this.lastError) && !this.lastError.startsWith("cbm_mcp_tool_error:");
        if (retryable) await this.resetSession(true);
        if (!retryable || attempt > 0 || Date.now() - startedAt >= timeoutMs) break;
      }
    }

    throw new Error(`cbm_mcp_failed:${tool}:${errorMessage(lastError)}`);
  }

  private async ensureSession(timeoutMs: number): Promise<Session> {
    if (this.session?.transport.pid !== null && this.session?.transport.pid !== undefined) return this.session;
    if (this.session) await this.resetSession(true);
    if (!this.connecting) {
      const pending = this.connect(timeoutMs);
      this.connecting = pending;
      void pending.finally(() => {
        if (this.connecting === pending) this.connecting = undefined;
      }).catch(() => undefined);
    }
    return await this.connecting;
  }

  private async connect(timeoutMs: number): Promise<Session> {
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-STDERR_LIMIT);
    });
    const client = new Client({ name: "agentic-harness-context-engine-cbm", version: CLIENT_VERSION });
    try {
      await client.connect(transport, { timeout: Math.max(250, timeoutMs), maxTotalTimeout: Math.max(250, timeoutMs) });
      const session = { client, transport, connectedAt: Date.now() } satisfies Session;
      this.session = session;
      this.lastError = undefined;
      return session;
    } catch (error) {
      this.lastError = errorMessage(error);
      await client.close().catch(() => undefined);
      throw new Error(`cbm_mcp_connect_failed:${this.lastError}`);
    }
  }

  private async resetSession(countReconnect: boolean): Promise<void> {
    const current = this.session;
    this.session = undefined;
    if (countReconnect && current) this.reconnects += 1;
    if (current) await current.client.close().catch(() => undefined);
  }
}
