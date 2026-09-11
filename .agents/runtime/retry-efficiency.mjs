import { createHash } from "node:crypto";

export const RETRY_FAILURE_STRATEGIES = Object.freeze({
  handoff_schema_invalid: { disposition: "same-attempt-repair", category: "contract" },
  implementation_plan_invalid: { disposition: "same-attempt-repair", category: "contract" },
  implementation_plan_missing: { disposition: "same-attempt-repair", category: "contract" },
  product_discovery_bootstrap_assessment_missing: { disposition: "same-attempt-repair", category: "contract" },
  product_discovery_bootstrap_assessment_invalid: { disposition: "same-attempt-repair", category: "contract" },
  product_acceptance_criteria_missing: { disposition: "same-attempt-repair", category: "contract" },
  product_acceptance_process_criterion_leaked: { disposition: "same-attempt-repair", category: "contract" },
  product_acceptance_criterion_invalid: { disposition: "same-attempt-repair", category: "contract" },
  product_acceptance_proof_stage_missing: { disposition: "same-attempt-repair", category: "contract" },
  product_acceptance_proof_stage_invalid: { disposition: "same-attempt-repair", category: "contract" },
  product_acceptance_criterion_duplicate: { disposition: "same-attempt-repair", category: "contract" },
  review_not_approved: { disposition: "review-dependent", category: "review" },
  review_contract_invalid: { disposition: "true-retry-semantic", category: "review" },
  product_not_accepted: { disposition: "true-retry-semantic", category: "review" },
  product_review_contract_invalid: { disposition: "true-retry-semantic", category: "review" },
  completion_evidence_missing: { disposition: "true-retry-semantic", category: "contract" },
  completion_contract_conflict: { disposition: "true-retry-semantic", category: "contract" },
  completion_semantic_unproven: { disposition: "true-retry-semantic", category: "contract" },
  completion_validation_failed: { disposition: "true-retry-semantic", category: "contract" },
  context_semantic_dependency_unavailable: { disposition: "true-retry-transient", category: "context-infrastructure" },
  executor_stalled: { disposition: "true-retry-transient", category: "liveness" },
  executor_soft_timeout: { disposition: "true-retry-transient", category: "liveness" },
  executor_timeout: { disposition: "true-retry-transient", category: "liveness" },
  executor_service_failed: { disposition: "true-retry-transient", category: "service" },
  opencode_state_database_locked: { disposition: "true-retry-transient", category: "tooling-infrastructure" },
  executor_exit_nonzero: { disposition: "true-retry-semantic", category: "code" },
  provider_unavailable: { disposition: "true-retry-transient", category: "provider" },
  provider_rate_limited: { disposition: "true-retry-transient", category: "provider" },
  network_error: { disposition: "true-retry-transient", category: "transport" },
  worker_unavailable: { disposition: "true-retry-transient", category: "worker" },
  handoff_missing: { disposition: "true-retry-semantic", category: "contract" },
  handoff_reused_paths_invalid: { disposition: "true-retry-semantic", category: "contract" },
  agent_failed: { disposition: "true-retry-semantic", category: "agent" },
});

const TRANSIENT_CATEGORIES = new Set(["context-infrastructure", "infrastructure", "tooling-infrastructure", "provider", "transport", "liveness", "worker", "service"]);

function strategyForFailure(failure = {}) {
  const code = String(failure?.code ?? "").trim();
  if (code && RETRY_FAILURE_STRATEGIES[code]) return RETRY_FAILURE_STRATEGIES[code];
  if (failure?.explicitRetryDisposition && ["same-attempt-repair", "true-retry-transient", "true-retry-semantic", "terminal"].includes(failure.explicitRetryDisposition)) {
    return { disposition: failure.explicitRetryDisposition, category: failure?.category ?? "explicit" };
  }
  // Category-only transient classification is permitted only for known infrastructure domains.
  if (TRANSIENT_CATEGORIES.has(String(failure?.category ?? ""))) return { disposition: "true-retry-transient", category: failure.category };
  return null;
}

export function retryDispositionForFailure(failure = {}) {
  if (failure?.retryable !== true) return "terminal";
  const strategy = strategyForFailure(failure);
  if (!strategy) return "unclassified";
  if (failure?.repairExhausted === true && ["same-attempt-repair", "review-dependent"].includes(strategy.disposition)) {
    return "true-retry-repair-exhausted";
  }
  if (strategy.disposition === "review-dependent") {
    return failure?.reviewDecision === "changes_requested" ? "same-attempt-repair" : "true-retry-semantic";
  }
  return strategy.disposition;
}

export function repairBudgetForFailure(failure = {}) {
  const disposition = retryDispositionForFailure({ ...failure, retryable: true, repairExhausted: false });
  if (disposition !== "same-attempt-repair") return 0;
  const configured = Number(process.env.AGENT_HARNESS_RUNTIME_SAME_ATTEMPT_REPAIR_PASSES ?? 2);
  return Math.max(1, Math.min(3, Number.isFinite(configured) ? Math.trunc(configured) : 2));
}

export function parseProviderRetryAfterMs(value, nowMs = Date.now()) {
  if (value == null || value === "") return null;
  if (Number.isFinite(Number(value))) return Math.max(0, Math.round(Number(value)));
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed - nowMs);
}

export function retryDelayForFailure({ failure = {}, defaultDelayMs = 30_000, attempt = 1, rng = Math.random } = {}) {
  const disposition = retryDispositionForFailure(failure);
  if (["true-retry-repair-exhausted", "true-retry-semantic", "same-attempt-repair", "terminal", "unclassified"].includes(disposition)) return 0;
  if (disposition !== "true-retry-transient") return 0;

  // ADR 0033 canonical full-jitter caps. Config may override only by explicit list.
  const configured = String(process.env.AGENT_HARNESS_RUNTIME_RETRY_CAPS_MS ?? "5000,15000,45000,120000,300000")
    .split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value >= 0);
  const caps = configured.length > 0 ? configured : [5_000, 15_000, 45_000, 120_000, 300_000];
  const index = Math.max(0, Math.min(caps.length - 1, Number(attempt ?? 1) - 1));
  const upperBoundMs = caps[index] ?? Math.max(0, Number(defaultDelayMs ?? 30_000));
  const unit = Math.max(0, Math.min(0.999999999999, Number(rng?.() ?? Math.random())));
  const localFullJitterMs = Math.floor(unit * (upperBoundMs + 1));
  const providerRetryAfterMs = parseProviderRetryAfterMs(failure?.providerRetryAfterMs ?? failure?.retryAfterMs ?? failure?.retryAfter);
  return Math.max(localFullJitterMs, providerRetryAfterMs ?? 0);
}

export function retryBudgetLimits(env = process.env) {
  const maxElapsedMs = Math.max(1_000, Number(env.AGENT_HARNESS_RUNTIME_RETRY_MAX_ELAPSED_MS ?? 900_000));
  const maxCumulativeBackoffMs = Math.max(0, Number(env.AGENT_HARNESS_RUNTIME_RETRY_MAX_CUMULATIVE_BACKOFF_MS ?? 300_000));
  return { maxElapsedMs, maxCumulativeBackoffMs };
}

function payloadOf(event) {
  if (!event) return {};
  if (event.payload && typeof event.payload === "object") return event.payload;
  try { return typeof event.payload_json === "string" ? JSON.parse(event.payload_json) : (event.payload_json ?? {}); } catch { return {}; }
}

export function deriveRetryBudgetState(events = [], { taskId = null, startedAtMs = null, nowMs = Date.now() } = {}) {
  let cumulativeBackoffMs = 0;
  let firstObservedMs = Number(startedAtMs ?? 0) || null;
  for (const event of events ?? []) {
    const eventTaskId = event.task_id ?? event.taskId ?? null;
    if (taskId && eventTaskId && eventTaskId !== taskId) continue;
    const created = Date.parse(event.created_at ?? event.createdAt ?? "");
    if (Number.isFinite(created)) firstObservedMs = firstObservedMs == null ? created : Math.min(firstObservedMs, created);
    if ((event.event_type ?? event.type) === "retry.backoff_applied") cumulativeBackoffMs += Math.max(0, Number(payloadOf(event).retryAfterMs ?? 0));
  }
  return {
    elapsedMs: firstObservedMs == null ? 0 : Math.max(0, nowMs - firstObservedMs),
    cumulativeBackoffMs,
  };
}

export function evaluateRetryBudget({ budgetState = {}, retryAfterMs = 0, limits = retryBudgetLimits() } = {}) {
  const elapsedMs = Math.max(0, Number(budgetState.elapsedMs ?? 0));
  const cumulativeBackoffMs = Math.max(0, Number(budgetState.cumulativeBackoffMs ?? 0));
  const nextDelay = Math.max(0, Number(retryAfterMs ?? 0));
  const remainingElapsedMs = Math.max(0, limits.maxElapsedMs - elapsedMs);
  const remainingBackoffMs = Math.max(0, limits.maxCumulativeBackoffMs - cumulativeBackoffMs);
  // A zero-delay retry must not bypass an already-exhausted wall-clock budget.
  // Previously elapsedMs >= maxElapsedMs still produced remainingElapsedMs=0 and
  // `0 <= 0`, allowing another full attempt after the temporal budget was spent.
  const elapsedBudgetOpen = elapsedMs < limits.maxElapsedMs;
  const backoffBudgetOpen = cumulativeBackoffMs <= limits.maxCumulativeBackoffMs;
  const allowed = elapsedBudgetOpen
    && backoffBudgetOpen
    && nextDelay <= remainingElapsedMs
    && nextDelay <= remainingBackoffMs;
  return { allowed, elapsedMs, cumulativeBackoffMs, retryAfterMs: nextDelay, remainingElapsedMs, remainingBackoffMs, ...limits };
}

export function repairEffectKey({ runId, taskId, taskAttempt, repairKind, repairPass = 0, sourceRevision = 0, eventType = "repair" } = {}) {
  const value = [runId, taskId, taskAttempt, repairKind, repairPass, sourceRevision, eventType].map((item) => String(item ?? "")).join("|");
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function retryEfficiencyDetails({ failure = {}, defaultDelayMs = 30_000, attempt = 1, rng = Math.random, budgetState = null, limits = null } = {}) {
  const disposition = retryDispositionForFailure(failure);
  const retryAfterMs = retryDelayForFailure({ failure, defaultDelayMs, attempt, rng });
  const budget = evaluateRetryBudget({ budgetState: budgetState ?? {}, retryAfterMs, limits: limits ?? retryBudgetLimits() });
  return {
    disposition,
    retryAfterMs,
    repairBudget: repairBudgetForFailure(failure),
    backoffApplied: retryAfterMs > 0,
    sameAttemptRepairPreferred: disposition === "same-attempt-repair",
    classificationKnown: disposition !== "unclassified",
    providerRetryAfterMs: parseProviderRetryAfterMs(failure?.providerRetryAfterMs ?? failure?.retryAfterMs ?? failure?.retryAfter),
    retryBudget: budget,
  };
}
