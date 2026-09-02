import { isBootstrapReviewStage } from "./bootstrap-capabilities.mjs";

const GOVERNANCE_STAGES = new Set([
  "product-discovery",
  "architecture-review",
  "database-review",
  "infrastructure-review",
  "ai-operations-review",
  "technical-refinement",
  "product-acceptance",
]);

function boundedPositive(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed);
}

export function resolveExecutionLivenessPolicy({ task, attempt = 1, hardTimeoutMs = 3_600_000 } = {}) {
  const hard = boundedPositive(hardTimeoutMs, 3_600_000);
  const currentAttempt = Math.max(1, Math.trunc(Number(attempt) || 1));
  const stage = String(task?.stage ?? "");
  const governance = GOVERNANCE_STAGES.has(stage) || isBootstrapReviewStage(stage);

  if (!governance) {
    return {
      hardTimeoutMs: hard,
      softTimeoutMs: null,
      stallTimeoutMs: null,
      policy: "hard-timeout-only",
    };
  }

  // A hard one-hour deadline remains the final safety boundary, but governance
  // attempts should not consume the entire failure budget slot when a provider
  // is silent or one model is making pathologically slow progress. Attempt 1
  // gets a 30 minute soft budget; a precision-escalated retry gets 45 minutes.
  const softCap = currentAttempt === 1 ? 30 * 60_000 : 45 * 60_000;
  const softTimeoutMs = Math.min(hard, softCap);

  // No output from the OpenCode wrapper for 12 minutes is a liveness failure,
  // not useful reasoning. This is deliberately longer than normal provider/tool
  // pauses observed in the Run 6 baseline and applies only to governance stages.
  const stallTimeoutMs = Math.min(softTimeoutMs, 12 * 60_000);

  return {
    hardTimeoutMs: hard,
    softTimeoutMs: softTimeoutMs < hard ? softTimeoutMs : null,
    stallTimeoutMs: stallTimeoutMs < hard ? stallTimeoutMs : null,
    policy: "governance-progress-watchdog-v1",
  };
}

export function retryRationale(priorFailureCode) {
  const code = String(priorFailureCode ?? "").trim();
  if (!code) return "previous attempt rejected";
  if (code === "executor_stalled") return "executor stalled without output progress";
  if (code === "executor_soft_timeout") return "executor exceeded governance soft deadline";
  if (code === "executor_timeout") return "executor reached hard timeout";
  if (code.startsWith("completion_") || code.includes("criterion") || code.includes("contract")) return `contract/completion rejection (${code})`;
  return `previous failure (${code})`;
}
