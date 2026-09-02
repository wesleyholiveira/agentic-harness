const CBM_BOOTSTRAP_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export function isRetryableCbmBootstrapFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/cbm_mcp_tool_error:/i.test(message)) return false;
  return /(cbm_mcp_(?:failed|connect_failed)|mcp error).*(connection|closed|not connected|transport|econn|epipe|request.*timeout|timed out|abort)/i.test(message)
    || /(connection|closed|not connected|transport|econn|epipe|request.*timeout|timed out|abort).*(cbm_mcp|mcp error)/i.test(message);
}

export function cbmBootstrapRetryDelayMs(failureCount: number): number {
  const normalized = Number.isFinite(failureCount) ? Math.max(1, Math.trunc(failureCount)) : 1;
  const index = Math.min(normalized - 1, CBM_BOOTSTRAP_RETRY_DELAYS_MS.length - 1);
  return CBM_BOOTSTRAP_RETRY_DELAYS_MS[index] ?? 30_000;
}
