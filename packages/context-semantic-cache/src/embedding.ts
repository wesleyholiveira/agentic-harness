import { createHash } from "node:crypto";
import { SemanticDependencyUnavailableError, semanticDependencyError } from "./errors";
import type { EmbeddingProviderHealth, SemanticEmbeddingProvider } from "./types";

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashFeature(feature: string): Buffer {
  return createHash("sha256").update(feature).digest();
}

function deterministicVector(text: string, dimensions: number): number[] {
  const vector = new Float32Array(dimensions);
  const tokens = normalizeText(text).split(" ").filter(Boolean);
  const add = (feature: string, weight: number): void => {
    const hash = hashFeature(feature);
    const index = hash.readUInt32BE(0) % dimensions;
    const sign = (hash[4] ?? 0) % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + weight * sign;
  };
  for (const token of tokens) {
    add(`u:${token}`, 1);
    const padded = `^${token}$`;
    for (let index = 0; index <= padded.length - 3; index++) {
      add(`c3:${padded.slice(index, index + 3)}`, 0.3);
    }
  }
  for (let index = 0; index < tokens.length - 1; index++) {
    add(`b:${tokens[index]}_${tokens[index + 1]}`, 0.65);
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index++) vector[index] = (vector[index] ?? 0) / norm;
  }
  return Array.from(vector);
}

/** Test double only. Production wiring uses TEI. */
export class DeterministicSemanticEmbeddingProvider implements SemanticEmbeddingProvider {
  readonly providerId = "deterministic-test-double";
  readonly modelId = "deterministic-hash-v1";
  readonly revision = "test-only";

  constructor(readonly dimensions = 384) {
    if (!Number.isInteger(dimensions) || dimensions < 64 || dimensions > 4096) {
      throw new Error(`semantic_embedding_dimensions_invalid:${dimensions}`);
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => deterministicVector(text, this.dimensions));
  }

  async health(): Promise<EmbeddingProviderHealth> {
    return {
      status: "up",
      latencyMs: 0,
      details: { provider: this.providerId, model: this.modelId, test_double: true },
    };
  }
}

export interface TeiEmbeddingProviderOptions {
  baseUrl: string;
  modelId: string;
  revision: string;
  dimensions: number;
  timeoutMs?: number;
  apiKey?: string;
}

function validVector(value: unknown, dimensions: number): value is number[] {
  return Array.isArray(value)
    && value.length === dimensions
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

export class TeiEmbeddingProvider implements SemanticEmbeddingProvider {
  readonly providerId = "huggingface-tei";
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(readonly options: TeiEmbeddingProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!this.baseUrl) throw new Error("semantic_embedding_base_url_required");
    if (!options.modelId) throw new Error("semantic_embedding_model_required");
    if (!options.revision) throw new Error("semantic_embedding_revision_required");
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) {
      throw new Error("semantic_embedding_dimensions_required");
    }
  }

  get modelId(): string {
    return this.options.modelId;
  }

  get revision(): string {
    return this.options.revision;
  }

  get dimensions(): number {
    return this.options.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/embed`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({ inputs: texts }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`semantic_embedding_http_failed:${response.status}:${body.slice(0, 160)}`);
      }
      const body = await response.json() as unknown;
      const vectors = Array.isArray(body) && body.length > 0 && typeof body[0] === "number" ? [body] : body;
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error(`semantic_embedding_response_count_mismatch:${Array.isArray(vectors) ? vectors.length : 0}:${texts.length}`);
      }
      return vectors.map((vector, index) => {
        if (!validVector(vector, this.dimensions)) {
          throw new Error(`semantic_embedding_dimension_mismatch:${index}:${Array.isArray(vector) ? vector.length : 0}:${this.dimensions}`);
        }
        return vector;
      });
    } catch (error) {
      if (error instanceof SemanticDependencyUnavailableError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new SemanticDependencyUnavailableError(
          "embedding",
          "semantic_embedding_timeout",
          `TEI embedding request exceeded ${this.timeoutMs}ms`,
          { cause: error },
        );
      }
      if (error instanceof TypeError) {
        throw semanticDependencyError("embedding", error, "semantic_embedding_transport_unavailable");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<EmbeddingProviderHealth> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5_000));
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        headers: this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {},
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`semantic_embedding_health_failed:${response.status}`);
      return {
        status: "up",
        latencyMs: Date.now() - startedAt,
        details: {
          provider: this.providerId,
          endpoint: this.baseUrl,
          model: this.modelId,
          revision: this.revision,
          dimensions: this.dimensions,
        },
      };
    } catch (error) {
      const unavailable = error instanceof TypeError
        ? semanticDependencyError("embedding", error, "semantic_embedding_transport_unavailable")
        : error;
      return {
        status: "down",
        latencyMs: Date.now() - startedAt,
        error: unavailable instanceof Error ? unavailable.message : String(unavailable),
        details: {
          provider: this.providerId,
          endpoint: this.baseUrl,
          ...(unavailable instanceof SemanticDependencyUnavailableError ? {
            error_code: unavailable.code,
            cause_code: unavailable.causeCode,
            dependency: unavailable.dependency,
          } : {}),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
