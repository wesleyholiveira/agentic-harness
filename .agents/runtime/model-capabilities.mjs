import { isBootstrapReviewStage } from "./bootstrap-capabilities.mjs";

const HIGH_REASONING_STAGES = new Set([
  "product-discovery",
  "architecture-review",
  "database-review",
  "infrastructure-review",
  "ai-operations-review",
  "technical-refinement",
  "quality-assurance",
  "operational-readiness",
  "product-acceptance",
]);

function unique(values) { return [...new Set(values.filter(Boolean))]; }

export function modelClassForTask(task = {}) {
  if (task.executionRequirements?.modelClass) return task.executionRequirements.modelClass;
  const role = task.sddRole ?? task.role ?? "developer";
  if (task.stage === "quality-assurance" || role === "quality-assurance") return "quality-high";
  if (task.stage === "technical-refinement" || role === "technical-lead") return "reasoning-high";
  if (isBootstrapReviewStage(task.stage) || HIGH_REASONING_STAGES.has(task.stage) || ["product-owner", "solution-architect", "database-administrator", "devops-engineer", "ai-llmops-engineer"].includes(role)) return "reasoning-high";
  if (task.role === "implementation" || task.role === "platform" || ["developer", "platform-engineer"].includes(role)) {
    return task.complexity === "low" && task.contractChange !== true && task.migration !== true ? "coding-fast" : "coding-pro";
  }
  return "reasoning-cost-balanced";
}

export function modelRequirementsForTask(task = {}) {
  const modelClass = modelClassForTask(task);
  const role = task.sddRole ?? task.role ?? "developer";
  const explicit = task.executionRequirements ?? {};
  const capabilities = unique([
    ...(modelClass.startsWith("coding") ? ["coding", "tool-use"] : ["reasoning", "tool-use"]),
    ...(isBootstrapReviewStage(task.stage) || ["technical-lead", "product-owner", "solution-architect", "quality-assurance"].includes(role) || task.stage === "technical-refinement" ? ["structured-output"] : []),
    ...(task.role === "verification" || task.stage === "quality-assurance" ? ["evidence-review"] : []),
    ...(task.ownedPaths?.length > 20 ? ["long-context"] : []),
    ...(Array.isArray(explicit.capabilities) ? explicit.capabilities : []),
  ]);
  return {
    modelClass,
    capabilities,
    reasoningClass: explicit.reasoningClass ?? task.reasoningLevel ?? "medium",
    interactionMode: explicit.interactionMode ?? "subagent",
    binding: "runtime-route",
  };
}

export function assertRouteSatisfiesRequirements(route, requirements, catalog) {
  if (!route?.model) throw new Error("model_route_missing");
  const profile = catalog?.models?.[route.model]?.profile ?? [];
  const missing = (requirements?.capabilities ?? []).filter((capability) => !profile.includes(capability));
  // Catalog profiles are advisory while a single-model override is active. If a
  // profile is present, however, it must not silently contradict the task.
  if (profile.length > 0 && missing.length > 0) throw new Error(`model_route_capability_mismatch:${route.model}:${missing.join(",")}`);
  return route;
}
