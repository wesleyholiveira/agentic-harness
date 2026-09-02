import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { PersistentMcpToolClient } from "../src/persistent-mcp-client";

describe("PersistentMcpToolClient", () => {
  it("reuses one stdio MCP child process across tool calls", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-cbm-mcp-server.mjs");
    const client = new PersistentMcpToolClient(process.execPath, [fixture], process.cwd());
    try {
      const first = JSON.parse(await client.callTool("index_status", { project: "test-project" }, 5_000));
      const firstDiagnostics = client.getDiagnostics();
      const second = JSON.parse(await client.callTool("index_status", { project: "test-project" }, 5_000));
      const secondDiagnostics = client.getDiagnostics();

      expect(first).toEqual({ project: "test-project", nodes: 10, edges: 20, status: "ready" });
      expect(second).toEqual(first);
      expect(firstDiagnostics.state).toBe("connected");
      expect(firstDiagnostics.pid).toBeTypeOf("number");
      expect(secondDiagnostics.pid).toBe(firstDiagnostics.pid);
      expect(secondDiagnostics.calls).toBe(2);
      expect(secondDiagnostics.reconnects).toBe(0);
    } finally {
      await client.close();
    }
    expect(client.getDiagnostics().state).toBe("idle");
  });
});
