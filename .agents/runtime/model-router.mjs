import { retryRationale } from "./execution-liveness.mjs";
import { assertRouteSatisfiesRequirements, modelRequirementsForTask } from "./model-capabilities.mjs";
import { isBootstrapReviewStage } from "./bootstrap-capabilities.mjs";

const LEVELS = ["low", "medium", "high", "max"];
export const ACTIVE_OPENCODE_MODEL = process.env.AGENT_HARNESS_DEFAULT_MODEL || "openai/gpt-5.6-luna";

function normalizeLevel(value, fallback = "medium") {
  return LEVELS.includes(value) ? value : fallback;
}

function complexityOf(task) {
  const explicit = task.complexity;
  if (["low", "medium", "high", "critical"].includes(explicit)) return explicit;
  const files = Number(task.estimatedFiles ?? task.ownedPaths?.length ?? 0);
  const criteria = task.acceptanceCriteria?.length ?? 0;
  if (task.contractChange || task.migration || files >= 12 || criteria >= 10) return "high";
  if (files <= 4 && criteria <= 5) return "low";
  return "medium";
}

function stepsFor(level, role) {
  const base = { low: 45, medium: 70, high: 100, max: 140 }[normalizeLevel(level)] ?? 70;
  if (["technical-lead", "solution-architect", "quality-assurance"].includes(role)) return Math.max(base, 100);
  return base;
}

function implementationReasoning({ task, reasoning, attempt }) {
  const complexity = complexityOf(task);
  const simple = complexity === "low"
    && Number(task.estimatedFiles ?? task.ownedPaths?.length ?? 0) <= 4
    && (task.acceptanceCriteria?.length ?? 0) <= 5
    && task.contractChange !== true
    && task.migration !== true;
  if (attempt >= 3 || complexity === "critical") return "max";
  if (simple && attempt === 1) return normalizeLevel(reasoning?.level, "medium");
  return attempt >= 2 ? "max" : normalizeLevel(reasoning?.level, "high");
}

export function resolveModelRoute({ agent, task, reasoning, attempt = 1, priorFailureCode = reasoning?.priorFailureCode ?? null, routingCatalog = null }) {
  const role = task.sddRole ?? agent.role ?? "developer";
  const requirements = modelRequirementsForTask(task);
  const level = normalizeLevel(reasoning?.level ?? task.reasoningLevel, "medium");
  let reasoningEffort = level;
  let rationale = "qualified champion route";

  if (["developer", "platform-engineer", "database-administrator"].includes(role) || task.role === "implementation" || task.role === "platform") {
    reasoningEffort = implementationReasoning({ task, reasoning: { ...reasoning, level }, attempt });
    rationale = attempt >= 2
      ? `implementation retry remains on the configured champion after ${retryRationale(priorFailureCode)}`
      : "implementation routed to the configured champion";
  } else if (role === "technical-lead") {
    reasoningEffort = attempt >= 2 || level === "max" ? "max" : "high";
    rationale = attempt >= 2
      ? `technical-lead retry remains on the configured champion after ${retryRationale(priorFailureCode)}`
      : "technical decomposition routed to the configured champion";
  } else if (role === "quality-assurance") {
    reasoningEffort = attempt >= 2 ? "max" : (level === "max" ? "max" : "high");
    rationale = attempt >= 2
      ? `QA retry remains on the configured champion after ${retryRationale(priorFailureCode)}`
      : "QA routed to the configured champion; independence comes from role/context rather than model-family separation";
  } else if (["product-owner", "solution-architect", "ux-designer"].includes(role)) {
    reasoningEffort = attempt >= 2 ? "max" : (level === "max" ? "max" : "high");
    rationale = attempt >= 2
      ? `governance retry remains on the configured champion after ${retryRationale(priorFailureCode)}`
      : "governance routed to the configured champion";
  } else if (isBootstrapReviewStage(task.stage) || ["devops-engineer", "ai-llmops-engineer"].includes(role)) {
    reasoningEffort = attempt >= 2 || level === "max" ? "max" : "high";
    rationale = attempt >= 2
      ? `operational review retry remains on the configured champion after ${retryRationale(priorFailureCode)}`
      : "operational review routed to the configured champion";
  }

  let model = ACTIVE_OPENCODE_MODEL;
  if (routingCatalog) {
    const routeClass = routingCatalog.classes?.[requirements.modelClass];
    if (!routeClass) throw new Error(`model_route_class_unknown:${requirements.modelClass}`);
    model = routeClass.default;
    if (!model || !routingCatalog.models?.[model]) throw new Error(`model_route_catalog_model_unknown:${model || "missing"}`);
  }
  const classPerformance = routingCatalog?.performancePolicy?.classes?.[requirements.modelClass] ?? null;
  return assertRouteSatisfiesRequirements({
    model,
    modelClass: requirements.modelClass,
    requiredCapabilities: requirements.capabilities,
    variant: null,
    reasoningEffort,
    rationale,
    costClass: routingCatalog?.models?.[model]?.billing ?? "configured-provider",
    stepsLimit: stepsFor(reasoningEffort, role),
    attempt,
    role,
    latencySloMs: Number.isFinite(Number(classPerformance?.targetP95Ms)) ? Number(classPerformance.targetP95Ms) : null,
    routingPolicy: "champion",
  }, requirements, routingCatalog);
}
