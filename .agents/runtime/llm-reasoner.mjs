import { runProcess } from "./process.mjs";
import { heuristicReasoningAssessment } from "./reasoning.mjs";
import { assertSchema } from "./schema-validator.mjs";
import { newId } from "./utils.mjs";
import { mergeBootstrapReviewDependencies, normalizeBootstrapReviewDependencies } from "./bootstrap-review-dependencies.mjs";
import {
  capabilityCatalogFromRegistry,
  legacyEdgesToFactRequirements,
  normalizeBootstrapFactRequirements,
} from "./bootstrap-capabilities.mjs";

const SUPPORTED_PROVIDERS = new Set(["heuristic", "command", "openai", "anthropic", "ollama"]);

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

export function resolveLLMProvider(value = process.env.AGENT_HARNESS_AGENT_LLM_PROVIDER ?? null, command = process.env.AGENT_HARNESS_AGENT_REASONING_COMMAND ?? null) {
  const configured = String(value ?? "").trim();
  if (!configured) {
    // Default: use external command if configured, otherwise heuristic.
    if (command) return "command";
    if (process.env.AGENT_HARNESS_AGENT_REASONING_COMMAND) return "command";
    return "heuristic";
  }
  const provider = configured.toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`invalid_llm_provider:${provider}`);
  }
  return provider;
}

export function resolveLLMConfig(args = {}) {
  const provider = resolveLLMProvider(args.provider, args.command);
  const rawLevel = args.forcedLevel ?? process.env.AGENT_HARNESS_AGENT_REASONING_LEVEL ?? null;
  const forcedLevel = typeof rawLevel === "string" && rawLevel.trim() === "" ? null : rawLevel;
  if (forcedLevel !== null && !["low", "medium", "high", "max"].includes(forcedLevel)) {
    throw new Error(`invalid_reasoning_level:${forcedLevel}`);
  }
  return {
    provider,
    model: args.model ?? process.env.AGENT_HARNESS_AGENT_LLM_MODEL ?? defaultModelFor(provider),
    apiKey: args.apiKey ?? process.env.AGENT_HARNESS_AGENT_LLM_API_KEY ?? null,
    baseUrl: args.baseUrl ?? process.env.AGENT_HARNESS_AGENT_LLM_BASE_URL ?? null,
    temperature: Number(args.temperature ?? process.env.AGENT_HARNESS_AGENT_LLM_TEMPERATURE ?? 0),
    timeoutMs: Number(args.timeoutMs ?? process.env.AGENT_HARNESS_AGENT_LLM_TIMEOUT_MS ?? 120_000),
    command: args.command ?? process.env.AGENT_HARNESS_AGENT_REASONING_COMMAND ?? null,
    forcedLevel: forcedLevel ?? null,
  };
}

function defaultModelFor(provider) {
  switch (provider) {
    case "openai": return "gpt-4o-mini";
    case "anthropic": return "claude-3-5-haiku-latest";
    case "ollama": return "llama3.1";
    default: return null;
  }
}

export function buildReasoningPrompt({ request, registry, explicitAgents }) {
  const agents = registry.agents
    .filter((agent) => agent.id !== registry.orchestrator)
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      primaryPaths: agent.primaryPaths ?? [],
      sharedPaths: agent.sharedPaths ?? [],
      requiredDocs: agent.requiredDocs ?? [],
      routingKeywords: agent.routing?.keywords ?? [],
    }));

  return [
    "You are a routing and planning assistant for a software engineering multi-agent system.",
    "Interpret the request semantically. Do not rely on keyword matching alone.",
    "Select the smallest coherent set of specialist agents that can satisfy the request.",
    "Estimate complexity, ambiguity, number of files, number of domains, risk factors and reasoning level.",
    "For bootstrap governance, reason in capabilities and facts. Populate bootstrapFactRequirements. Each item must declare factId, consumerCapabilityId, resolution, source, evidence and rationale; include providerCapabilityId when resolution=review. Use authoritative-context when Product Discovery, a frozen ADR, Project Memory or authoritative repository context already supplies the fact. An empty array proves safe fan-out. Never emit self-edges or cycles, and the provider capability must advertise the fact.",
    "Use 'low' for local, clear work; 'medium' for moderate changes; 'high' for cross-domain, ambiguous or high-risk work; 'max' only for deep investigation or integration.",
    "Return ONLY a JSON object compatible with the reasoning-assessment schema.",
    "Do not include explanations, markdown, or code blocks outside the JSON.",
    "",
    "Available agents:",
    JSON.stringify(agents, null, 2),
    "",
    `Explicitly requested agents: ${JSON.stringify(explicitAgents)}`,
    "",
    `Request: ${request}`,
  ].join("\n");
}

function sanitizeForLog(reasoning) {
  if (!reasoning) return reasoning;
  const copy = { ...reasoning };
  // Avoid logging the full rationale if it is extremely long; the rationale itself is not sensitive,
  // but we keep provenance compact.
  if (typeof copy.rationale === "string" && copy.rationale.length > 500) {
    copy.rationale = `${copy.rationale.slice(0, 500)}...`;
  }
  return copy;
}

async function callOpenAI({ prompt, model, apiKey, baseUrl, temperature, timeoutMs }) {
  const { ChatOpenAI } = await import("@langchain/openai");
  const llm = new ChatOpenAI({
    modelName: model,
    apiKey,
    configuration: baseUrl ? { baseURL: baseUrl } : undefined,
    temperature,
    timeout: timeoutMs,
  });
  const result = await llm.invoke([{ role: "user", content: prompt }]);
  return parseModelContent(result?.content);
}

async function callAnthropic({ prompt, model, apiKey, baseUrl, temperature, timeoutMs }) {
  const { ChatAnthropic } = await import("@langchain/anthropic");
  const llm = new ChatAnthropic({
    modelName: model,
    apiKey,
    anthropicApiUrl: baseUrl,
    temperature,
    timeout: timeoutMs,
  });
  const result = await llm.invoke([{ role: "user", content: prompt }]);
  return parseModelContent(result?.content);
}

async function callOllama({ prompt, model, baseUrl, temperature, timeoutMs }) {
  const url = baseUrl ? `${baseUrl.replace(/\/$/, "")}/api/generate` : "http://localhost:11434/api/generate";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`ollama_request_failed:${response.status}`);
  }
  const data = await response.json();
  return parseModelContent(data.response);
}

async function callCommand({ command, prompt, repositoryRoot, timeoutMs }) {
  const assessmentId = newId("reasoning");
  const directory = `${repositoryRoot}/.runtime/agents/reasoning/${assessmentId}`;
  const fs = await import("node:fs/promises");
  const { writeJson, readJson } = await import("./utils.mjs");
  await fs.mkdir(directory, { recursive: true });
  const inputPath = `${directory}/input.json`;
  const outputPath = `${directory}/output.json`;
  await writeJson(inputPath, { schemaVersion: 1, request: prompt, agents: [], explicitAgents: [] });
  const rendered = command
    .replace(/\{input\}/g, JSON.stringify(inputPath))
    .replace(/\{output\}/g, JSON.stringify(outputPath))
    .replace(/\{repository\}/g, JSON.stringify(repositoryRoot))
    .replace(/\{request\}/g, JSON.stringify(prompt));
  const result = await runProcess(rendered, [], {
    cwd: repositoryRoot,
    shell: true,
    timeoutMs,
    env: { ...process.env, AGENT_HARNESS_AGENT_REASONING_INPUT: inputPath, AGENT_HARNESS_AGENT_REASONING_OUTPUT: outputPath },
  });
  if (result.status !== 0) throw new Error(result.timedOut ? "reasoning_command_timeout" : `reasoning_command_failed:${result.status}`);
  if (await readJson(outputPath)) return readJson(outputPath);
  if (result.stdout.trim()) return JSON.parse(result.stdout.trim());
  throw new Error("reasoning_output_missing");
}

function parseModelContent(content) {
  if (!content) throw new Error("reasoning_model_empty_response");
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract the first JSON object from the text.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("reasoning_model_invalid_json");
  }
}

function validateRecommendedAgents(registry, assessment) {
  const allowed = new Set(registry.agents.filter((agent) => agent.id !== registry.orchestrator).map((agent) => agent.id));
  const unknown = (assessment.recommendedAgents ?? []).filter((agentId) => !allowed.has(agentId));
  if (unknown.length > 0) throw new Error(`reasoning_assessment_unknown_agents:${unknown.join(",")}`);
}

export async function invokeReasoning({
  repositoryRoot,
  registry,
  request,
  explicitAgents = [],
  schemas,
  llmReasoner = null,
  config = null,
  fallbackReason = null,
}) {
  const reasoner = llmReasoner ?? (config ? { invoke: () => null, config } : null);
  const resolved = reasoner?.config ?? config ?? resolveLLMConfig();

  if (resolved.forcedLevel) {
    const fallback = heuristicReasoningAssessment({ registry, request, explicitAgents, fallbackReason: fallbackReason ?? "manual_fixed_mode" });
    return {
      ...fallback,
      mode: "fixed",
      source: "explicit",
      initialLevel: resolved.forcedLevel,
      confidence: 1,
      rationale: "Nível de raciocínio fixado explicitamente pelo operador.",
      fallbackReason: null,
      llmProvider: resolved.provider,
    };
  }

  const prompt = buildReasoningPrompt({ request, registry, explicitAgents });

  if (resolved.provider === "heuristic") {
    return {
      ...heuristicReasoningAssessment({ registry, request, explicitAgents, fallbackReason: fallbackReason ?? "provider_heuristic" }),
      llmProvider: resolved.provider,
    };
  }

  let rawAssessment;
  let providerError;
  try {
    if (reasoner && typeof reasoner.invoke === "function") {
      rawAssessment = await reasoner.invoke({ repositoryRoot, registry, request, explicitAgents, schemas });
    } else {
      switch (resolved.provider) {
        case "openai":
          rawAssessment = await callOpenAI({ prompt, ...resolved });
          break;
        case "anthropic":
          rawAssessment = await callAnthropic({ prompt, ...resolved });
          break;
        case "ollama":
          rawAssessment = await callOllama({ prompt, ...resolved });
          break;
        case "command":
          if (!resolved.command) throw new Error("reasoning_command_missing");
          rawAssessment = await callCommand({ command: resolved.command, prompt, repositoryRoot, timeoutMs: resolved.timeoutMs });
          break;
        default:
          throw new Error(`unsupported_provider:${resolved.provider}`);
      }
    }
    assertSchema(rawAssessment, schemas.reasoningAssessment, "reasoningAssessment");
    validateRecommendedAgents(registry, rawAssessment);
  } catch (error) {
    providerError = error.message;
    rawAssessment = null;
  }

  if (!rawAssessment) {
    return {
      ...heuristicReasoningAssessment({
        registry,
        request,
        explicitAgents,
        fallbackReason: fallbackReason ?? `llm_provider_error:${providerError}`,
      }),
      llmProvider: resolved.provider,
      llmError: providerError,
    };
  }

  const minimumConfidence = Number(process.env.AGENT_HARNESS_AGENT_REASONING_MIN_CONFIDENCE ?? 0.55);
  if (rawAssessment.confidence < minimumConfidence || rawAssessment.recommendedAgents.length === 0) {
    const heuristic = heuristicReasoningAssessment({
      registry,
      request,
      explicitAgents,
      fallbackReason: fallbackReason ?? (rawAssessment.recommendedAgents.length === 0 ? "no_recommended_agents" : `confidence_below_${minimumConfidence}`),
    });
    return {
      mode: "adaptive",
      source: "hybrid",
      initialLevel: rawAssessment.reasoningLevel,
      confidence: rawAssessment.confidence,
      rationale: `${rawAssessment.rationale} Avaliação semântica insuficiente; fallback heurístico aplicado como proteção.`,
      fallbackReason: rawAssessment.recommendedAgents.length === 0 ? "no_recommended_agents" : `confidence_below_${minimumConfidence}`,
      recommendedAgents: [...new Set([...explicitAgents, ...(rawAssessment.recommendedAgents ?? []), ...(heuristic.recommendedAgents ?? [])])],
      requiresArchitecture: rawAssessment.requiresArchitecture || heuristic.requiresArchitecture,
      signals: {
        complexity: rawAssessment.complexity,
        ambiguity: Math.max(rawAssessment.ambiguity, heuristic.signals.ambiguity),
        estimatedFiles: Math.max(rawAssessment.estimatedFiles, heuristic.signals.estimatedFiles),
        estimatedDomains: Math.max(rawAssessment.estimatedDomains, heuristic.signals.estimatedDomains),
        riskFactors: [...new Set([...(rawAssessment.riskFactors ?? []), ...(heuristic.signals.riskFactors ?? [])])],
      },
      bootstrapFactRequirements: normalizeBootstrapFactRequirements([
        ...(factRequirementsFromAssessment(rawAssessment, registry, "reasoning:llm-low-confidence") ?? []),
        ...(heuristic.bootstrapFactRequirements ?? []),
      ], { catalog: capabilityCatalogFromRegistry(registry), provenance: "reasoning:hybrid" }),
      bootstrapReviewDependencies: mergeBootstrapReviewDependencies(
        Array.isArray(rawAssessment.bootstrapReviewDependencies)
          ? normalizeBootstrapReviewDependencies(rawAssessment.bootstrapReviewDependencies, { provenance: "reasoning:llm-low-confidence" })
          : [],
        heuristic.bootstrapReviewDependencies ?? [],
      ),
      routingEvidence: heuristic.routingEvidence,
      assessmentPath: null,
      llmProvider: resolved.provider,
      llmAssessment: sanitizeForLog(rawAssessment),
    };
  }

  return {
    mode: "adaptive",
    source: "llm",
    initialLevel: rawAssessment.reasoningLevel,
    confidence: rawAssessment.confidence,
    rationale: rawAssessment.rationale,
    fallbackReason: null,
    recommendedAgents: [...new Set([...explicitAgents, ...(rawAssessment.recommendedAgents ?? [])])],
    requiresArchitecture: rawAssessment.requiresArchitecture,
    signals: {
      complexity: rawAssessment.complexity,
      ambiguity: rawAssessment.ambiguity,
      estimatedFiles: rawAssessment.estimatedFiles,
      estimatedDomains: rawAssessment.estimatedDomains,
      riskFactors: rawAssessment.riskFactors ?? [],
    },
    ...(factRequirementsFromAssessment(rawAssessment, registry, "reasoning:llm") !== null
      ? { bootstrapFactRequirements: factRequirementsFromAssessment(rawAssessment, registry, "reasoning:llm") }
      : {}),
    ...(Array.isArray(rawAssessment.bootstrapReviewDependencies)
      ? { bootstrapReviewDependencies: normalizeBootstrapReviewDependencies(rawAssessment.bootstrapReviewDependencies, { provenance: "reasoning:llm" }) }
      : {}),
    routingEvidence: [],
    assessmentPath: null,
    llmProvider: resolved.provider,
    llmAssessment: sanitizeForLog(rawAssessment),
  };
}

export function createLLMReasoner(config = {}) {
  return {
    invoke: (params) => invokeReasoning({ ...params, config: resolveLLMConfig(config) }),
    config: resolveLLMConfig(config),
  };
}
