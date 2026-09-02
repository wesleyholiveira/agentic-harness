import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { assertSchema } from "./schema-validator.mjs";
import { runProcess } from "./process.mjs";
import { exists, newId, readJson, writeJson } from "./utils.mjs";
import { inferBootstrapReviewDependencies, mergeBootstrapReviewDependencies, normalizeBootstrapReviewDependencies } from "./bootstrap-review-dependencies.mjs";
import {
  capabilityCatalogFromRegistry,
  inferBootstrapFactRequirements,
  legacyEdgesToFactRequirements,
  normalizeBootstrapFactRequirements,
} from "./bootstrap-capabilities.mjs";

export const reasoningLevels = ["low", "medium", "high", "max"];

const fallbackKeywords = {
  "architecture-governance": ["architecture", "adr", "governance", "ownership", "design", "contract", "boundary"],
  "backend-specialist": ["backend", "api", "server", "endpoint", "http", "service", "gateway"],
  "frontend-specialist": ["frontend", "react", "vue", "angular", "web", "component", "client"],
  "ux-design": ["ux", "ui", "design system", "accessibility", "wcag", "wireframe", "interaction design"],
  "database-administration": ["database", "postgres", "sql", "schema", "migration", "index", "transaction"],
  "async-control-plane": ["rabbitmq", "sqs", "kafka", "queue", "worker", "retry", "dlq", "outbox", "inbox", "async", "concurrency"],
  "ai-llmops": ["llm", "llmops", "mlops", "prompt", "model", "embedding", "rerank", "dataset", "evaluation", "training", "inference", "token"],
  "devops-engineering": ["devops", "terraform", "cloud", "kubernetes", "observability", "slo", "rpo", "rto", "capacity"],
  "platform-release": ["docker", "compose", "release", "build", "ci", "cd", "packaging"],
  "security-reviewer": ["security", "auth", "authorization", "secret", "threat", "vulnerability", "encryption"],
  "systems-performance": ["performance", "latency", "throughput", "contention", "cache", "hot path", "profiling"],
  "structural-modernization": ["refactor", "modularize", "decompose", "modernization", "legacy"],
  "verification-evidence": ["test", "verification", "validate", "quality", "regression", "evidence", "benchmark"],
};

function normalize(value) {
  return String(value ?? "").toLocaleLowerCase("pt-BR");
}

function commandFromTemplate(template, values) {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`reasoning_template_unknown_placeholder:${key}`);
    return JSON.stringify(String(values[key]));
  });
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function factRequirementsFromAssessment(assessment, registry, provenance) {
  const catalog = capabilityCatalogFromRegistry(registry);
  if (Array.isArray(assessment?.bootstrapFactRequirements)) {
    return normalizeBootstrapFactRequirements(assessment.bootstrapFactRequirements, { catalog, provenance });
  }
  if (Array.isArray(assessment?.bootstrapReviewDependencies)) {
    return legacyEdgesToFactRequirements(assessment.bootstrapReviewDependencies, { catalog, provenance });
  }
  return null;
}

export function normalizeReasoningLevel(level, fallback = "medium") {
  return reasoningLevels.includes(level) ? level : fallback;
}

export function promoteReasoningLevel(level, steps = 1) {
  const current = reasoningLevels.indexOf(normalizeReasoningLevel(level));
  return reasoningLevels[Math.min(reasoningLevels.length - 1, current + Math.max(0, steps))];
}

export function maxReasoningLevel(...levels) {
  return levels.map((level) => normalizeReasoningLevel(level, "low"))
    .reduce((highest, level) => reasoningLevels.indexOf(level) > reasoningLevels.indexOf(highest) ? level : highest, "low");
}

export function scoreAgentFallback(agent, request) {
  const routing = agent.routing ?? {};
  const keywords = [...(routing.keywords ?? []), ...(fallbackKeywords[agent.id] ?? [])];
  const normalized = normalize(request);
  let score = 0;
  const matched = [];
  for (const keyword of new Set(keywords.map(normalize))) {
    if (normalized.includes(keyword)) {
      score += keyword.includes(" ") ? 3 : 2;
      matched.push(keyword);
    }
  }
  for (const hint of routing.pathHints ?? agent.primaryPaths ?? []) {
    const compact = normalize(String(hint).replaceAll("/**", "").replaceAll("/", " "));
    if (compact && normalized.includes(compact)) {
      score += 4;
      matched.push(hint);
    }
  }
  return { score, matched };
}

export function heuristicReasoningAssessment({ registry, request, explicitAgents = [], fallbackReason = "reasoner_unavailable" }) {
  const scored = registry.agents
    .filter((agent) => agent.id !== registry.orchestrator)
    .map((agent) => ({ agentId: agent.id, ...scoreAgentFallback(agent, request) }))
    .filter((item) => item.score > 0 || explicitAgents.includes(item.agentId))
    .sort((left, right) => right.score - left.score || left.agentId.localeCompare(right.agentId));
  const domainAgents = scored.filter((item) => !["architecture-governance", "verification-evidence"].includes(item.agentId));
  const structural = /\b(refactor|architecture|multi-agent|multiagente|migration|migra[cç][aã]o|schema|contract|contrato|persist[eê]ncia)\b/i.test(request);
  const explicitPaths = unique(request.match(/(?:^|\s)(?:\.?\/?[\w.-]+\/)+[\w.*-]+/g)?.map((value) => value.trim()) ?? []);
  const estimatedFiles = Math.max(explicitPaths.length, domainAgents.length === 0 ? 1 : domainAgents.length * (structural ? 4 : 2));
  const estimatedDomains = Math.max(1, domainAgents.length || explicitAgents.length);
  let reasoningLevel = "low";
  if (structural || estimatedDomains > 1 || estimatedFiles >= 6) reasoningLevel = "medium";
  if (estimatedDomains >= 3 || estimatedFiles >= 15) reasoningLevel = "high";
  if (estimatedDomains >= 5 || estimatedFiles >= 30) reasoningLevel = "max";
  const shortOrVague = request.trim().length < 45 || /\b(isso|aquilo|coisa|ajustar|melhorar|resolver)\b/i.test(request);
  const ambiguity = shortOrVague ? 0.65 : structural ? 0.35 : 0.2;
  const recommendedAgents = unique([...explicitAgents, ...scored.map((item) => item.agentId)]);
  if (recommendedAgents.length === 0) recommendedAgents.push("architecture-governance");
  return {
    mode: "adaptive",
    source: "heuristic",
    initialLevel: reasoningLevel,
    confidence: 0.35,
    rationale: `Fallback determinístico acionado: ${fallbackReason}.`,
    fallbackReason,
    recommendedAgents,
    requiresArchitecture: structural || estimatedDomains > 1,
    signals: {
      complexity: reasoningLevel === "max" ? "critical" : reasoningLevel,
      ambiguity,
      estimatedFiles,
      estimatedDomains,
      riskFactors: unique([
        structural ? "structural-change" : null,
        estimatedDomains > 1 ? "cross-domain" : null,
        ambiguity >= 0.6 ? "ambiguous-request" : null,
      ]),
    },
    routingEvidence: scored,
    assessmentPath: null,
    bootstrapFactRequirements: inferBootstrapFactRequirements({ request, catalog: capabilityCatalogFromRegistry(registry) }),
    bootstrapReviewDependencies: inferBootstrapReviewDependencies({ request }),
  };
}

function validateRecommendedAgents(registry, assessment) {
  const allowed = new Set(registry.agents.filter((agent) => agent.id !== registry.orchestrator).map((agent) => agent.id));
  const unknown = assessment.recommendedAgents.filter((agentId) => !allowed.has(agentId));
  if (unknown.length > 0) throw new Error(`reasoning_assessment_unknown_agents:${unknown.join(",")}`);
}

function semanticInput({ request, registry, explicitAgents }) {
  return {
    schemaVersion: 1,
    instruction: [
      "Interprete semanticamente a solicitação de engenharia; não faça simples detecção de palavras-chave.",
      "Escolha o menor conjunto coerente de agentes capaz de atender ao trabalho.",
      "Estime complexidade, ambiguidade, quantidade de arquivos e domínios, riscos e nível de raciocínio.",
      "Use low para trabalho local e claro; medium para mudança moderada; high para trabalho transversal, ambíguo ou de alto risco; max apenas quando investigação ou integração profunda justificar o custo.",
      "Modele o bootstrap por capabilities e facts, não por uma ordem fixa. Preencha bootstrapFactRequirements: cada item declara factId, consumerCapabilityId, resolution, source, evidence e rationale; use providerCapabilityId quando resolution=review. Use resolution=authoritative-context quando Product Discovery, ADR congelado, Project Memory ou contexto autoritativo do repositório já fornece o fact. Um array vazio prova fan-out seguro. Não crie self-edge nem ciclo; o provider deve anunciar o fact no capability catalog.",
      "Retorne somente um objeto JSON compatível com reasoning-assessment.schema.json.",
    ].join(" "),
    request,
    explicitAgents,
    agents: registry.agents
      .filter((agent) => agent.id !== registry.orchestrator)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        kind: agent.kind,
        primaryPaths: agent.primaryPaths ?? [],
        sharedPaths: agent.sharedPaths ?? [],
        requiredDocs: agent.requiredDocs ?? [],
      })),
  };
}

function mergeLowConfidenceAssessment({ semantic, heuristic, fallbackReason, registry }) {
  return {
    mode: "adaptive",
    source: "hybrid",
    initialLevel: maxReasoningLevel(semantic.reasoningLevel, heuristic.initialLevel),
    confidence: semantic.confidence,
    rationale: `${semantic.rationale} Avaliação semântica insuficiente (${fallbackReason}); fallback heurístico aplicado como proteção.`,
    fallbackReason,
    recommendedAgents: unique([...semantic.recommendedAgents, ...heuristic.recommendedAgents]),
    requiresArchitecture: semantic.requiresArchitecture || heuristic.requiresArchitecture,
    signals: {
      complexity: semantic.complexity,
      ambiguity: Math.max(semantic.ambiguity, heuristic.signals.ambiguity),
      estimatedFiles: Math.max(semantic.estimatedFiles, heuristic.signals.estimatedFiles),
      estimatedDomains: Math.max(semantic.estimatedDomains, heuristic.signals.estimatedDomains),
      riskFactors: unique([...semantic.riskFactors, ...heuristic.signals.riskFactors]),
    },
    routingEvidence: heuristic.routingEvidence,
    assessmentPath: heuristic.assessmentPath,
    bootstrapFactRequirements: normalizeBootstrapFactRequirements([
      ...(factRequirementsFromAssessment(semantic, registry, "reasoning:llm-low-confidence") ?? []),
      ...(heuristic.bootstrapFactRequirements ?? []),
    ], { catalog: capabilityCatalogFromRegistry(registry), provenance: "reasoning:hybrid" }),
    bootstrapReviewDependencies: mergeBootstrapReviewDependencies(
      Array.isArray(semantic.bootstrapReviewDependencies)
        ? normalizeBootstrapReviewDependencies(semantic.bootstrapReviewDependencies, { provenance: "reasoning:llm-low-confidence" })
        : [],
      heuristic.bootstrapReviewDependencies ?? [],
    ),
  };
}

export async function assessReasoning({
  repositoryRoot,
  registry,
  schemas,
  request,
  explicitAgents = [],
  command = null,
  mode = "adaptive",
  forcedLevel = null,
  minimumConfidence = 0.55,
  timeoutMs = 120_000,
}) {
  if (mode === "fixed" || forcedLevel) {
    const fallback = heuristicReasoningAssessment({ registry, request, explicitAgents, fallbackReason: "manual_fixed_mode" });
    return {
      ...fallback,
      mode: "fixed",
      source: "explicit",
      initialLevel: normalizeReasoningLevel(forcedLevel, "medium"),
      confidence: 1,
      rationale: "Nível de raciocínio fixado explicitamente pelo operador.",
      fallbackReason: null,
    };
  }
  if (!command) return heuristicReasoningAssessment({ registry, request, explicitAgents, fallbackReason: "reasoning_command_not_configured" });

  const assessmentId = newId("reasoning");
  const directory = join(repositoryRoot, ".runtime", "agents", "reasoning", assessmentId);
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "output.json");
  const logPath = join(directory, "reasoner.log");
  await mkdir(directory, { recursive: true });
  await writeJson(inputPath, semanticInput({ request, registry, explicitAgents }));
  const rendered = commandFromTemplate(command, {
    input: inputPath,
    output: outputPath,
    repository: repositoryRoot,
    request,
  });
  const result = await runProcess(rendered, [], {
    cwd: repositoryRoot,
    shell: true,
    timeoutMs,
    env: {
      ...process.env,
      AGENT_HARNESS_AGENT_REASONING_INPUT: inputPath,
      AGENT_HARNESS_AGENT_REASONING_OUTPUT: outputPath,
      AGENT_HARNESS_REPOSITORY_ROOT: repositoryRoot,
    },
  });
  await writeFile(logPath, `${result.stdout}\n--- STDERR ---\n${result.stderr}`, "utf8");

  try {
    if (result.status !== 0) throw new Error(result.timedOut ? "reasoning_command_timeout" : `reasoning_command_failed:${result.status}`);
    let semantic;
    if (await exists(outputPath)) semantic = await readJson(outputPath);
    else if (result.stdout.trim()) {
      semantic = JSON.parse(result.stdout.trim());
      await writeJson(outputPath, semantic);
    } else throw new Error("reasoning_output_missing");
    assertSchema(semantic, schemas.reasoningAssessment, "reasoningAssessment");
    validateRecommendedAgents(registry, semantic);
    const relativeOutput = relative(repositoryRoot, outputPath).replaceAll("\\", "/");
    const heuristic = heuristicReasoningAssessment({ registry, request, explicitAgents, fallbackReason: "semantic_assessment_low_confidence" });
    heuristic.assessmentPath = relativeOutput;
    if (semantic.confidence < minimumConfidence || semantic.recommendedAgents.length === 0) {
      return mergeLowConfidenceAssessment({
        semantic,
        heuristic,
        fallbackReason: semantic.recommendedAgents.length === 0 ? "no_recommended_agents" : `confidence_below_${minimumConfidence}`,
        registry,
      });
    }
    return {
      mode: "adaptive",
      source: "llm",
      initialLevel: semantic.reasoningLevel,
      confidence: semantic.confidence,
      rationale: semantic.rationale,
      fallbackReason: null,
      recommendedAgents: unique([...explicitAgents, ...semantic.recommendedAgents]),
      requiresArchitecture: semantic.requiresArchitecture,
      signals: {
        complexity: semantic.complexity,
        ambiguity: semantic.ambiguity,
        estimatedFiles: semantic.estimatedFiles,
        estimatedDomains: semantic.estimatedDomains,
        riskFactors: semantic.riskFactors,
      },
      routingEvidence: [],
      assessmentPath: relativeOutput,
      ...(factRequirementsFromAssessment(semantic, registry, "reasoning:llm") !== null
        ? { bootstrapFactRequirements: factRequirementsFromAssessment(semantic, registry, "reasoning:llm") }
        : {}),
      ...(Array.isArray(semantic.bootstrapReviewDependencies)
        ? { bootstrapReviewDependencies: normalizeBootstrapReviewDependencies(semantic.bootstrapReviewDependencies, { provenance: "reasoning:llm" }) }
        : {}),
    };
  } catch (error) {
    return heuristicReasoningAssessment({
      registry,
      request,
      explicitAgents,
      fallbackReason: error.message,
    });
  }
}

async function upstreamScopeSignals(store, taskRow) {
  const dependencies = JSON.parse(taskRow.dependencies_json ?? "[]");
  let changedFiles = 0;
  let contractChanges = 0;
  for (const dependency of dependencies) {
    const upstream = await store.getTask(dependency);
    if (!upstream?.handoff_path || !(await exists(upstream.handoff_path))) continue;
    try {
      const handoff = await readJson(upstream.handoff_path);
      changedFiles += Array.isArray(handoff.changedPaths) ? handoff.changedPaths.length : 0;
      contractChanges += Array.isArray(handoff.contractChanges) ? handoff.contractChanges.length : 0;
    } catch {
      // A malformed handoff is handled by the executor. It must not break the policy evaluator.
    }
  }
  return { changedFiles, contractChanges };
}

export function contextBudgetForReasoning(baseBudgetBytes, level) {
  const multiplier = { low: 0.65, medium: 1, high: 1.5, max: 2 }[normalizeReasoningLevel(level)] ?? 1;
  return Math.min(2_000_000, Math.max(10_000, Math.round(baseBudgetBytes * multiplier)));
}

export async function resolveTaskReasoning({ plan, taskPlan, taskRow, store, baseContextBudgetBytes, attemptOverride = null }) {
  const baseLevel = normalizeReasoningLevel(taskPlan.reasoningLevel ?? plan.reasoning?.initialLevel, "medium");
  const mode = plan.reasoning?.mode ?? "adaptive";
  const reasons = [];
  let promotionSteps = 0;
  const currentAttempt = Number(taskRow.attempt ?? 0);
  const requestedAttempt = Number(attemptOverride);
  const replacementExecution = attemptOverride != null && Number.isInteger(requestedAttempt) && requestedAttempt >= 1;
  const attempt = replacementExecution ? requestedAttempt : currentAttempt + 1;
  if (replacementExecution && attempt !== currentAttempt) {
    throw new Error(`replacement_task_attempt_mismatch:${currentAttempt}:${attempt}`);
  }
  const upstream = await upstreamScopeSignals(store, taskRow);
  const conflicts = (await store.listConflicts(plan.runId)).length;

  if (mode === "adaptive") {
    if (attempt >= 2) {
      promotionSteps += 1;
      reasons.push("repeated-attempt");
    }
    if (attempt >= 3) {
      promotionSteps += 1;
      reasons.push("failure-budget-pressure");
    }
    if (upstream.changedFiles >= 8) {
      promotionSteps += 1;
      reasons.push("upstream-file-expansion");
    }
    if (upstream.changedFiles >= 20) {
      promotionSteps += 1;
      reasons.push("large-upstream-scope");
    }
    if (upstream.contractChanges >= 3) {
      promotionSteps += 1;
      reasons.push("contract-expansion");
    }
    if (conflicts > 0) {
      promotionSteps += 1;
      reasons.push("integration-conflict");
    }
  }

  const level = promoteReasoningLevel(baseLevel, promotionSteps);
  return {
    mode,
    level,
    baseLevel,
    source: level === baseLevel ? (plan.reasoning?.source ?? "legacy-default") : "adaptive-promotion",
    reasons,
    attempt,
    priorFailureCode: taskRow.error_code ?? null,
    priorFailureMessage: taskRow.error_message ?? null,
    signals: { upstreamChangedFiles: upstream.changedFiles, upstreamContractChanges: upstream.contractChanges, conflicts },
    contextBudgetBytes: contextBudgetForReasoning(baseContextBudgetBytes, level),
    replacementExecution,
  };
}
