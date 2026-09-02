import { describe, expect, it, vi } from "vitest";
import { StatsCollector } from "../src/stats.js";
import { registerGetEfficiency } from "../src/tools/get-efficiency.js";
import type { Visibility } from "../src/visibility.js";

interface CapturedTool {
  handler: (args: { runId?: string }) => Promise<{ content: Array<{ text: string }> }>;
}

describe("context_efficiency", () => {
  it("keeps delivery savings, cache reuse and budget accounting non-additive", async () => {
    const tools = new Map<string, CapturedTool>();
    const visibility = {
      registerVisibleTool(name: string, _config: unknown, handler: CapturedTool["handler"]) {
        tools.set(name, { handler });
      },
    } as unknown as Visibility;
    const stats = new StatsCollector();
    stats.recordPack(100, 25, {
      mode: "compact",
      cacheHit: true,
      cacheTier: "l2",
      budgetTokens: 50,
    });
    const efficiency = vi.fn().mockResolvedValue({ contractVersion: "runtime-efficiency/v1", runId: "run-1" });
    registerGetEfficiency(visibility, stats, undefined, { efficiency } as never);
    const tool = tools.get("context_efficiency");
    expect(tool).toBeDefined();
    const response = await tool!.handler({ runId: "run-1" });
    const body = JSON.parse(response.content[0].text);
    expect(body.contractVersion).toBe("context-efficiency/v2");
    expect(body.scope).toBe("run-primary-with-process-lifetime-diagnostics");
    expect(body.primary.contractVersion).toBe("runtime-efficiency/v1");
    expect(body.runScoped.contractVersion).toBe("runtime-efficiency/v1");
    expect(body.processLifetime.observed.contextDelivery.tokensSaved).toBe(75);
    expect(body.processLifetime.observed.exactCache.l2Hits).toBe(1);
    expect(body.processLifetime.observed.budget.requestedTokens).toBe(50);
    expect(body.processLifetime.accountingPolicy.grandTotalTokensSaved).toBeNull();
    expect(body.processLifetime.scope).toBe("context-engine-process-lifetime");
    expect(body.notes.scopeAuthority).toContain("runScoped");
    expect(efficiency).toHaveBeenCalledWith("run-1");
  });
});
