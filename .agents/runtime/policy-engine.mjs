import { join } from "node:path";
import { readJson } from "./utils.mjs";
import { stableFingerprint } from "./event-driven-contracts.mjs";
import { retryEfficiencyDetails } from "./retry-efficiency.mjs";

export const RUNTIME_POLICY_CONTRACT_VERSION = "runtime-policy/v1";
export const RUNTIME_POLICY_DECISION_CONTRACT_VERSION = "runtime-policy-decision/v1";

export const DEFAULT_RUNTIME_POLICY_DOCUMENT = Object.freeze({
  schemaVersion: 1,
  contractVersion: RUNTIME_POLICY_CONTRACT_VERSION,
  defaultEffect: "deny",
  rules: {
    plan: { requiredPhase: "bootstrap", unresolvedFactPolicy: "provider-edge", selfDependencyPolicy: "deny", cyclePolicy: "deny" },
    dispatch: {
      terminalRunStatuses: ["closed", "failed", "blocked", "cancelled"],
      dispatchableTaskStatuses: ["routed", "retrying"],
      requireSatisfiedDependencies: true,
      requireOpenRetryWindow: true,
      requireRefinedBootstrapTopology: true,
    },
    retry: { requireRetryableFailure: true, respectAttemptBudget: true, defaultDelayMs: 30_000 },
    compile: { requiredSourcePhase: "bootstrap", requireAcceptedTechnicalLead: true, requireZeroPreflightIssues: true },
    promotion: { requireQa: true, requireReadinessWhenPresent: true, requireProductAcceptance: true, maxBlockingFailures: 0 },
    reuse: {
      scopeFields: ["projectId", "branch", "stage", "role", "schemaVersion"],
      requireRevisionEquality: true,
      requireFingerprintEquality: true,
    },
  },
});

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

const REQUIRED_POLICY_RULES = Object.freeze(["plan", "dispatch", "retry", "compile", "promotion", "reuse"]);

function policyRuleError(path) {
  throw new Error(`runtime_policy_rule_invalid:${path}`);
}

function requirePolicyObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) policyRuleError(path);
  return value;
}

function requirePolicyString(value, path, allowed = null) {
  if (typeof value !== "string" || !value.trim()) policyRuleError(path);
  if (allowed && !allowed.includes(value)) policyRuleError(path);
}

function requirePolicyBoolean(value, path) {
  if (typeof value !== "boolean") policyRuleError(path);
}

function requirePolicyStringArray(value, path) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) policyRuleError(path);
  if (new Set(value).size !== value.length) policyRuleError(path);
}

function requirePolicyNonNegativeNumber(value, path) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) policyRuleError(path);
}

function normalizeDocument(document) {
  if (!document || document.schemaVersion !== 1 || document.contractVersion !== RUNTIME_POLICY_CONTRACT_VERSION) {
    throw new Error("runtime_policy_document_invalid");
  }
  if (document.defaultEffect !== "deny") throw new Error("runtime_policy_default_must_deny");
  const normalized = clone(document);
  const rules = requirePolicyObject(normalized.rules, "rules");
  for (const ruleName of REQUIRED_POLICY_RULES) {
    if (!Object.hasOwn(rules, ruleName)) throw new Error(`runtime_policy_rules_missing:${ruleName}`);
    requirePolicyObject(rules[ruleName], ruleName);
  }

  requirePolicyString(rules.plan.requiredPhase, "plan.requiredPhase", ["bootstrap"]);
  requirePolicyString(rules.plan.unresolvedFactPolicy, "plan.unresolvedFactPolicy", ["provider-edge"]);
  requirePolicyString(rules.plan.selfDependencyPolicy, "plan.selfDependencyPolicy", ["deny"]);
  requirePolicyString(rules.plan.cyclePolicy, "plan.cyclePolicy", ["deny"]);

  requirePolicyStringArray(rules.dispatch.terminalRunStatuses, "dispatch.terminalRunStatuses");
  requirePolicyStringArray(rules.dispatch.dispatchableTaskStatuses, "dispatch.dispatchableTaskStatuses");
  requirePolicyBoolean(rules.dispatch.requireSatisfiedDependencies, "dispatch.requireSatisfiedDependencies");
  requirePolicyBoolean(rules.dispatch.requireOpenRetryWindow, "dispatch.requireOpenRetryWindow");
  requirePolicyBoolean(rules.dispatch.requireRefinedBootstrapTopology, "dispatch.requireRefinedBootstrapTopology");

  requirePolicyBoolean(rules.retry.requireRetryableFailure, "retry.requireRetryableFailure");
  requirePolicyBoolean(rules.retry.respectAttemptBudget, "retry.respectAttemptBudget");
  requirePolicyNonNegativeNumber(rules.retry.defaultDelayMs, "retry.defaultDelayMs");

  requirePolicyString(rules.compile.requiredSourcePhase, "compile.requiredSourcePhase", ["bootstrap"]);
  requirePolicyBoolean(rules.compile.requireAcceptedTechnicalLead, "compile.requireAcceptedTechnicalLead");
  requirePolicyBoolean(rules.compile.requireZeroPreflightIssues, "compile.requireZeroPreflightIssues");

  requirePolicyBoolean(rules.promotion.requireQa, "promotion.requireQa");
  requirePolicyBoolean(rules.promotion.requireReadinessWhenPresent, "promotion.requireReadinessWhenPresent");
  requirePolicyBoolean(rules.promotion.requireProductAcceptance, "promotion.requireProductAcceptance");
  requirePolicyNonNegativeNumber(rules.promotion.maxBlockingFailures, "promotion.maxBlockingFailures");

  requirePolicyStringArray(rules.reuse.scopeFields, "reuse.scopeFields");
  requirePolicyBoolean(rules.reuse.requireRevisionEquality, "reuse.requireRevisionEquality");
  requirePolicyBoolean(rules.reuse.requireFingerprintEquality, "reuse.requireFingerprintEquality");
  return normalized;
}


function cyclicReviewStages(edges = []) {
  const stages = new Set();
  const outgoing = new Map();
  const indegree = new Map();
  for (const edge of edges ?? []) {
    const from = String(edge?.fromStage ?? "").trim();
    const to = String(edge?.toStage ?? "").trim();
    if (!from || !to) continue;
    stages.add(from);
    stages.add(to);
    if (!outgoing.has(from)) outgoing.set(from, []);
    outgoing.get(from).push(to);
    indegree.set(from, indegree.get(from) ?? 0);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  const queue = [...stages].filter((stage) => (indegree.get(stage) ?? 0) === 0).sort();
  let visited = 0;
  while (queue.length > 0) {
    const stage = queue.shift();
    visited += 1;
    for (const target of outgoing.get(stage) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
    queue.sort();
  }
  if (visited === stages.size) return [];
  return [...stages].filter((stage) => (indegree.get(stage) ?? 0) > 0).sort();
}

function decision(engine, action, input, allowed, code, ruleId, details = {}) {
  const subjectFingerprint = stableFingerprint(input ?? null);
  const receipt = {
    schemaVersion: 1,
    contractVersion: RUNTIME_POLICY_DECISION_CONTRACT_VERSION,
    policyContractVersion: engine.contractVersion,
    policyFingerprint: engine.fingerprint,
    action,
    subjectFingerprint,
    allowed: Boolean(allowed),
    effect: allowed ? "allow" : "deny",
    code,
    ruleId,
    details: clone(details),
  };
  const decisionFingerprint = stableFingerprint(receipt);
  return Object.freeze({ ...receipt, decisionId: decisionFingerprint, decisionFingerprint, ...(details.retryAfterMs == null ? {} : { retryAfterMs: Number(details.retryAfterMs) }) });
}

export async function loadRuntimePolicyDocument(repositoryRoot) {
  return normalizeDocument(await readJson(join(repositoryRoot, ".agents", "policies", "runtime-policy.json")));
}

export class RuntimePolicyEngine {
  constructor({ document = DEFAULT_RUNTIME_POLICY_DOCUMENT } = {}) {
    this.document = normalizeDocument(document);
    this.contractVersion = this.document.contractVersion;
    this.decisionContractVersion = RUNTIME_POLICY_DECISION_CONTRACT_VERSION;
    this.fingerprint = stableFingerprint(this.document);
  }

  allow(action, input, ruleId, details = {}) { return decision(this, action, input, true, "policy_allowed", ruleId, details); }
  deny(action, input, code, ruleId, details = {}) { return decision(this, action, input, false, code, ruleId, details); }

  evaluatePlan(input = {}) {
    const { phase, bootstrapFactBindings = [], bootstrapReviewDependencies = [], topologyState = "refined" } = input;
    const rules = this.document.rules.plan;
    if (phase !== rules.requiredPhase) return this.deny("plan", input, "policy_plan_phase_invalid", "plan.phase", { phase });
    if (!['provisional', 'refined'].includes(topologyState)) return this.deny("plan", input, "policy_plan_topology_state_invalid", "plan.topology-state", { topologyState });
    // Structural topology validity is independent from materialization state.
    // Fail cycles/self-dependencies first so the policy receipt identifies the
    // actual graph defect instead of masking it behind missing task identities.
    const selfEdges = bootstrapReviewDependencies.filter((edge) => edge?.fromStage === edge?.toStage);
    if (selfEdges.length > 0) return this.deny("plan", input, "policy_plan_self_dependency", "plan.review-topology", { selfEdges });
    const cyclicStages = cyclicReviewStages(bootstrapReviewDependencies);
    if (cyclicStages.length > 0) return this.deny("plan", input, "policy_plan_cycle", "plan.review-topology", { cyclicStages });

    const unresolvedWithoutProvider = bootstrapFactBindings.filter((binding) => {
      if (binding?.status === "unresolved") return true;
      return binding?.status === "unresolved-review-input" && !binding.providerCapabilityId;
    });
    if (unresolvedWithoutProvider.length > 0) {
      return this.deny("plan", input, "policy_plan_unresolved_facts", "plan.fact-resolution", { unresolvedFacts: unresolvedWithoutProvider.map((item) => item.factId) });
    }
    // During provisional planning Product Discovery has not materialized review
    // task identities yet. Capability identity is sufficient until the topology
    // becomes refined; refined plans require both ends to be materialized.
    if (topologyState === "refined") {
      const unmaterializedFacts = bootstrapFactBindings.filter((binding) =>
        !binding?.consumerTaskId
        || (binding?.status === "unresolved-review-input" && !binding.providerTaskId));
      if (unmaterializedFacts.length > 0) {
        return this.deny("plan", input, "policy_plan_unmaterialized_facts", "plan.fact-materialization", {
          unmaterializedFacts: unmaterializedFacts.map((item) => item.factId),
        });
      }
      const unmaterializedEdges = bootstrapReviewDependencies.filter((edge) => !edge?.fromTaskId || !edge?.toTaskId);
      if (unmaterializedEdges.length > 0) {
        return this.deny("plan", input, "policy_plan_unmaterialized_edges", "plan.review-materialization", { unmaterializedEdges });
      }
    }
    return this.allow("plan", input, "plan.bootstrap-authorized", { topologyState, factBindings: bootstrapFactBindings.length, reviewEdges: bootstrapReviewDependencies.length });
  }

  evaluateDispatch(input = {}) {
    const { runStatus, taskStatus, dependenciesSatisfied, retryWindowOpen = true, topologyReady = true } = input;
    const rules = this.document.rules.dispatch;
    if (rules.terminalRunStatuses.includes(String(runStatus))) return this.deny("dispatch", input, "policy_dispatch_run_terminal", "dispatch.run-terminal", { runStatus });
    if (!rules.dispatchableTaskStatuses.includes(String(taskStatus))) return this.deny("dispatch", input, "policy_dispatch_task_status", "dispatch.task-status", { taskStatus });
    if (rules.requireSatisfiedDependencies && dependenciesSatisfied !== true) return this.deny("dispatch", input, "policy_dispatch_dependencies_unsatisfied", "dispatch.dependencies");
    if (rules.requireOpenRetryWindow && retryWindowOpen !== true) return this.deny("dispatch", input, "policy_dispatch_retry_window_closed", "dispatch.retry-window");
    if (rules.requireRefinedBootstrapTopology && topologyReady !== true) return this.deny("dispatch", input, "policy_dispatch_topology_not_refined", "dispatch.bootstrap-topology");
    return this.allow("dispatch", input, "dispatch.ready");
  }

  evaluateRetry(input = {}) {
    const { failure, attempt, maxAttempts, retryBudgetState = null, rng = Math.random } = input;
    const rules = this.document.rules.retry;
    if (rules.requireRetryableFailure && failure?.retryable !== true) return this.deny("retry", input, "policy_retry_failure_non_retryable", "retry.retryability", { failureCode: failure?.code ?? null });
    if (rules.respectAttemptBudget && Number(attempt) >= Number(maxAttempts)) return this.deny("retry", input, "policy_retry_budget_exhausted", "retry.attempt-budget", { attempt: Number(attempt), maxAttempts: Number(maxAttempts) });
    const efficiency = retryEfficiencyDetails({ failure, defaultDelayMs: Number(rules.defaultDelayMs ?? 30_000), attempt, rng, budgetState: retryBudgetState });
    if (!efficiency.classificationKnown) {
      return this.deny("retry", input, "policy_retry_classification_required", "retry.failure-strategy-registry", { failureCode: failure?.code ?? null, category: failure?.category ?? null });
    }
    if (efficiency.sameAttemptRepairPreferred && failure?.repairExhausted !== true) {
      return this.deny("retry", input, "policy_retry_same_attempt_repair_required", "retry.same-attempt-repair", efficiency);
    }
    if (!efficiency.retryBudget.allowed) {
      return this.deny("retry", input, "policy_retry_elapsed_budget_exhausted", "retry.elapsed-budget", {
        retryDisposition: efficiency.disposition,
        retryAfterMs: efficiency.retryAfterMs,
        ...efficiency.retryBudget,
      });
    }
    return this.allow("retry", input, "retry.allowed", {
      retryAfterMs: efficiency.retryAfterMs,
      retryDisposition: efficiency.disposition,
      backoffApplied: efficiency.backoffApplied,
      repairBudget: efficiency.repairBudget,
      providerRetryAfterMs: efficiency.providerRetryAfterMs,
      retryBudget: efficiency.retryBudget,
    });
  }

  evaluateCompile(input = {}) {
    const { phase, technicalLeadAccepted, validationIssues = [] } = input;
    const rules = this.document.rules.compile;
    if (phase !== rules.requiredSourcePhase) return this.deny("compile", input, "policy_compile_phase_invalid", "compile.source-phase", { phase });
    if (rules.requireAcceptedTechnicalLead && technicalLeadAccepted !== true) return this.deny("compile", input, "policy_compile_technical_lead_not_accepted", "compile.technical-lead-authority");
    if (rules.requireZeroPreflightIssues && validationIssues.length > 0) return this.deny("compile", input, "policy_compile_preflight_rejected", "compile.preflight", { validationIssues: [...validationIssues] });
    return this.allow("compile", input, "compile.authorized");
  }

  evaluatePromotion(input = {}) {
    const { qaAccepted, readinessAccepted, readinessRequired = true, productAcceptanceAccepted, blockingFailures = 0 } = input;
    const rules = this.document.rules.promotion;
    if (rules.requireQa && qaAccepted !== true) return this.deny("promotion", input, "policy_promotion_qa_unproven", "promotion.qa");
    if (readinessRequired && rules.requireReadinessWhenPresent && readinessAccepted !== true) return this.deny("promotion", input, "policy_promotion_readiness_unproven", "promotion.readiness");
    if (rules.requireProductAcceptance && productAcceptanceAccepted !== true) return this.deny("promotion", input, "policy_promotion_product_acceptance_unproven", "promotion.product-acceptance");
    if (Number(blockingFailures) > Number(rules.maxBlockingFailures ?? 0)) return this.deny("promotion", input, "policy_promotion_blocking_failures", "promotion.blocking-failures", { blockingFailures: Number(blockingFailures) });
    return this.allow("promotion", input, "promotion.authorized", { readinessRequired: Boolean(readinessRequired) });
  }

  evaluateReuse(input = {}) {
    const { expected, candidate } = input;
    const rules = this.document.rules.reuse;
    if (!expected || !candidate) return this.deny("reuse", input, "policy_reuse_evidence_missing", "reuse.evidence");
    for (const field of rules.scopeFields ?? []) {
      if (String(expected?.[field] ?? "") !== String(candidate?.[field] ?? "")) return this.deny("reuse", input, "policy_reuse_scope_mismatch", "reuse.scope", { field });
    }
    if (rules.requireRevisionEquality && Number(expected?.revision) !== Number(candidate?.revision)) return this.deny("reuse", input, "policy_reuse_revision_mismatch", "reuse.revision");
    if (rules.requireFingerprintEquality && String(expected?.fingerprint ?? "") !== String(candidate?.fingerprint ?? "")) return this.deny("reuse", input, "policy_reuse_fingerprint_mismatch", "reuse.fingerprint");
    return this.allow("reuse", input, "reuse.authorized");
  }
}

export function assertPolicyAllowed(value, prefix = "runtime_policy_denied") {
  if (value?.allowed === true) return value;
  const error = new Error(`${prefix}:${value?.code ?? "unknown"}`);
  error.code = value?.code ?? prefix;
  error.policyDecision = value ?? null;
  throw error;
}

export async function recordPolicyDecision(store, input, taskId = null, legacyDecision = null) {
  let runId;
  let decisionValue;
  let operation = null;
  if (typeof input === "string") {
    runId = input;
    decisionValue = legacyDecision ?? taskId;
    taskId = legacyDecision == null ? null : taskId;
  } else {
    runId = input?.runId;
    taskId = input?.taskId ?? null;
    operation = input?.operation ?? null;
    decisionValue = input?.decision ?? null;
  }
  if (!store?.event || !runId || !decisionValue) return decisionValue;
  await store.event(runId, taskId, "policy.decision", { operation: operation ?? decisionValue.action ?? null, authoritative: true, ...decisionValue });
  return decisionValue;
}

export async function createRuntimePolicyEngine(repositoryRoot) {
  return new RuntimePolicyEngine({ document: await loadRuntimePolicyDocument(repositoryRoot) });
}
