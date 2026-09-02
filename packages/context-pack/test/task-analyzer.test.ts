import { describe, expect, it } from "vitest";
import { analyzeTask } from "../src/task-analyzer";

describe("analyzeTask", () => {
  it("extracts a deterministic canonical signature", () => {
    const result = analyzeTask("refactor the authentication module");

    expect(result.concepts).toEqual(["authentication", "module"]);
    expect(result.signature.intent).toBe("refactor");
    expect(result.signature.canonical_query).toBe("authentication module");
    expect(result.signature.fingerprint).toMatch(/^task-signature:v1:[0-9a-f]{64}$/);
  });

  it("normalizes Portuguese and English aliases into the same component scope", () => {
    const a = analyzeTask("otimizar cache do context engine e compressao com Headroom");
    const b = analyzeTask("optimize caching in the context engine and compression with Headroom");

    expect(a.signature.domains).toEqual(["cache", "compression", "context-engine"]);
    expect(b.signature.domains).toEqual(a.signature.domains);
    expect(b.signature.component_scope).toBe(a.signature.component_scope);
  });

  it("detects external API needed for OAuth keyword", () => {
    const result = analyzeTask("add OAuth authentication to login flow");

    expect(result.external_api_needed).toBe(true);
    expect(result.signature.external_libraries).toContain("oauth");
  });

  it("does not detect external API for rename function", () => {
    const result = analyzeTask("rename function calculate total");

    expect(result.external_api_needed).toBe(false);
  });

  it("detects TypeScript and file paths", () => {
    const result = analyzeTask("fix bug in src/backend/auth.ts");

    expect(result.detected_language).toBe("typescript");
    expect(result.signature.files).toContain("src/backend/auth.ts");
  });

  it("detects Python from .py extension", () => {
    const result = analyzeTask("refactor parser.py");

    expect(result.detected_language).toBe("python");
  });
});
