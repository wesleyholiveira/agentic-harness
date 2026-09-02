import { describe, expect, it } from "vitest";
import { cbmBootstrapRetryDelayMs, isRetryableCbmBootstrapFailure } from "../src/cbm-bootstrap-retry";

describe("CBM bootstrap recovery", () => {
  it("retries transport-close failures but not semantic tool errors", () => {
    expect(isRetryableCbmBootstrapFailure(
      new Error("cbm_mcp_failed:index_status:cbm_mcp_connect_failed:MCP error -32000: Connection closed"),
    )).toBe(true);
    expect(isRetryableCbmBootstrapFailure(
      new Error("cbm_mcp_failed:index_status:request timed out"),
    )).toBe(true);
    expect(isRetryableCbmBootstrapFailure(
      new Error("cbm_mcp_tool_error:index_status:project not found"),
    )).toBe(false);
  });

  it("backs off without an idle busy loop and caps at 30 seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 99].map(cbmBootstrapRetryDelayMs)).toEqual([
      1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000,
    ]);
  });
});
