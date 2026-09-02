import { describe, expect, it } from "vitest";
import { loadAgentCatalog } from "./agent-catalog.mjs";
import { loadSchemas } from "./schema-validator.mjs";
import { createLLMReasoner, invokeReasoning, resolveLLMConfig, resolveLLMProvider } from "./llm-reasoner.mjs";

const repositoryRoot = process.cwd();

async function runtime() {
  const registry = await loadAgentCatalog(repositoryRoot);
  const schemas = await loadSchemas(repositoryRoot);
  return { registry, schemas };
}

describe("llm-reasoner", () => {
  it("defaults to heuristic when no provider is configured", async () => {
    const reasoner = createLLMReasoner({ provider: null });
    expect(reasoner.config.provider).toBe("heuristic");
  });

  it("uses command provider when reasoning command is configured", async () => {
    const reasoner = createLLMReasoner({ provider: null, command: "echo" });
    expect(reasoner.config.provider).toBe("command");
  });

  it("rejects an invalid provider", () => {
    expect(() => resolveLLMProvider("unknown")).toThrow("invalid_llm_provider:unknown");
  });

  it("rejects an invalid explicit reasoning level", () => {
    expect(() => resolveLLMConfig({ forcedLevel: "medum" })).toThrow("invalid_reasoning_level:medum");
  });

  it("treats empty reasoning level as null", () => {
    const config = resolveLLMConfig({ forcedLevel: "" });
    expect(config.forcedLevel).toBeNull();
  });

  it("returns fixed explicit reasoning when forcedLevel is valid", async () => {
    const { registry, schemas } = await runtime();
    const reasoner = createLLMReasoner({ provider: "heuristic", forcedLevel: "high" });
    const result = await reasoner.invoke({ repositoryRoot, registry, request: "Atualizar um componente React", schemas });
    expect(result.source).toBe("explicit");
    expect(result.initialLevel).toBe("high");
    expect(result.confidence).toBe(1);
    expect(result.llmProvider).toBe("heuristic");
  });

  it("heuristic provider returns source heuristic", async () => {
    const { registry, schemas } = await runtime();
    const reasoner = createLLMReasoner({ provider: "heuristic" });
    const result = await reasoner.invoke({ repositoryRoot, registry, request: "Atualizar um componente React", schemas });
    expect(result.source).toBe("heuristic");
    expect(result.recommendedAgents).toContain("web-experience");
    expect(result.llmProvider).toBe("heuristic");
  });

  it("produces a valid reasoning assessment with hybrid fallback for low confidence", async () => {
    const { registry, schemas } = await runtime();
    const mockAssessment = {
      schemaVersion: 1,
      complexity: "low",
      reasoningLevel: "low",
      confidence: 0.2,
      ambiguity: 0.2,
      estimatedFiles: 1,
      estimatedDomains: 1,
      recommendedAgents: ["web-experience"],
      requiresArchitecture: false,
      riskFactors: [],
      rationale: "Mock low confidence",
    };
    const reasoner = {
      invoke: () => mockAssessment,
      config: { provider: "mock" },
    };
    const result = await invokeReasoning({ repositoryRoot, registry, request: "Test", schemas, llmReasoner: reasoner });
    expect(result.source).toBe("hybrid");
    expect(result.llmProvider).toBe("mock");
  });

  it("falls back to heuristic when LLM provider throws", async () => {
    const { registry, schemas } = await runtime();
    const reasoner = {
      invoke: () => { throw new Error("mock_provider_error"); },
      config: { provider: "mock" },
    };
    const result = await invokeReasoning({ repositoryRoot, registry, request: "Test", schemas, llmReasoner: reasoner });
    expect(result.source).toBe("heuristic");
    expect(result.llmProvider).toBe("mock");
    expect(result.llmError).toContain("mock_provider_error");
  });
});
