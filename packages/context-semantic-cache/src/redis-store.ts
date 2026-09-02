import { createHash } from "node:crypto";
import {
  RedisRespClient,
  RedisResponseError,
  type RedisCommandClient,
  type RedisReply,
} from "./redis-resp";
import type {
  SemanticCacheScope,
  SemanticCandidateQuery,
  SemanticCandidateRecord,
  SemanticCandidateStore,
  SemanticCandidateStoreHealth,
  SemanticCandidateWrite,
} from "./types";

export interface RedisSemanticCandidateStoreOptions {
  url: string;
  embeddingModel: string;
  dimensions: number;
  indexPrefix?: string;
  keyPrefix?: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  maxPayloadBytes?: number;
  client?: RedisCommandClient;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function tag(value: string): string {
  // RediSearch TAG filters have a special-character grammar. A fixed hex digest
  // avoids escaping ambiguity while the readable scope remains in the payload.
  return createHash("sha256").update(value || "unknown").digest("hex");
}

function vectorBuffer(values: number[], dimensions: number): Buffer {
  if (values.length !== dimensions || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`semantic_vector_invalid:${values.length}:${dimensions}`);
  }
  const vector = Float32Array.from(values);
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function asText(value: RedisReply | undefined): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}

function fieldsFromReply(value: RedisReply | undefined): Map<string, RedisReply> {
  const result = new Map<string, RedisReply>();
  if (!Array.isArray(value)) return result;
  for (let index = 0; index + 1 < value.length; index += 2) {
    result.set(asText(value[index]), value[index + 1] ?? null);
  }
  return result;
}

export function parseSemanticSearchReply(value: RedisReply): SemanticCandidateRecord[] {
  if (!Array.isArray(value) || value.length < 1) return [];
  const matches: SemanticCandidateRecord[] = [];
  for (let index = 1; index + 1 < value.length; index += 2) {
    const fields = fieldsFromReply(value[index + 1]);
    const payloadText = asText(fields.get("payload"));
    const distance = Number(asText(fields.get("vector_distance")));
    if (!payloadText || !Number.isFinite(distance)) continue;
    try {
      const payload = JSON.parse(payloadText) as SemanticCandidateRecord["payload"];
      if (payload.version !== 1 || !payload.candidateId) continue;
      matches.push({
        candidateId: payload.candidateId,
        payload,
        distance,
        similarity: Math.max(-1, Math.min(1, 1 - distance)),
      });
    } catch {
      // Malformed candidates are ignored and expire naturally.
    }
  }
  return matches;
}

function scopeFilter(scope: SemanticCacheScope, embeddingModel: string): string {
  return [
    `@project_tag:{${tag(scope.projectId)}}`,
    `@branch_tag:{${tag(scope.branch)}}`,
    `@role_tag:{${tag(scope.role)}}`,
    `@stage_tag:{${tag(scope.stage)}}`,
    `@schema_tag:{${tag(scope.schemaVersion)}}`,
    `@embedding_model_tag:{${tag(embeddingModel)}}`,
    `@expires_at:[${Date.now()} +inf]`,
  ].join(" ");
}

export class RedisSemanticCandidateStore implements SemanticCandidateStore {
  private readonly client: RedisCommandClient;
  private readonly indexName: string;
  private readonly keyPrefix: string;
  private readonly maxPayloadBytes: number;
  private indexPromise: Promise<void> | undefined;
  private readonly ownsClient: boolean;

  constructor(private readonly options: RedisSemanticCandidateStoreOptions) {
    if (!options.url && !options.client) throw new Error("semantic_redis_url_required");
    if (!options.embeddingModel) throw new Error("semantic_redis_embedding_model_required");
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) {
      throw new Error("semantic_redis_dimensions_required");
    }
    const suffix = `${options.dimensions}:${shortHash(options.embeddingModel)}`;
    const prefix = options.indexPrefix ?? "agent:harness:context:semantic";
    this.indexName = `${prefix}:index:v2:${suffix}`;
    this.keyPrefix = options.keyPrefix ?? `${prefix}:candidate:v2:${suffix}:`;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 2 * 1024 * 1024;
    this.ownsClient = options.client === undefined;
    this.client = options.client ?? new RedisRespClient({
      url: options.url,
      ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
      ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
    });
  }

  private async ensureIndex(): Promise<void> {
    if (!this.indexPromise) {
      this.indexPromise = this.createIndex().catch((error) => {
        this.indexPromise = undefined;
        throw error;
      });
    }
    await this.indexPromise;
  }

  private async createIndex(): Promise<void> {
    try {
      await this.client.command([
        "FT.CREATE", this.indexName,
        "ON", "HASH",
        "PREFIX", "1", this.keyPrefix,
        "SCHEMA",
        "project_tag", "TAG",
        "branch_tag", "TAG",
        "role_tag", "TAG",
        "stage_tag", "TAG",
        "schema_tag", "TAG",
        "embedding_model_tag", "TAG",
        "expires_at", "NUMERIC", "SORTABLE",
        "embedding", "VECTOR", "HNSW", "10",
        "TYPE", "FLOAT32",
        "DIM", String(this.options.dimensions),
        "DISTANCE_METRIC", "COSINE",
        "M", "16",
        "EF_CONSTRUCTION", "200",
      ]);
    } catch (error) {
      if (error instanceof RedisResponseError && /index already exists/i.test(error.message)) return;
      throw error;
    }
  }

  async query(input: SemanticCandidateQuery): Promise<SemanticCandidateRecord[]> {
    if (input.embeddingModel !== this.options.embeddingModel) {
      throw new Error(`semantic_embedding_model_mismatch:${input.embeddingModel}:${this.options.embeddingModel}`);
    }
    await this.ensureIndex();
    const topK = Math.max(1, Math.min(50, Math.trunc(input.topK)));
    const reply = await this.client.command([
      "FT.SEARCH", this.indexName,
      `(${scopeFilter(input.scope, input.embeddingModel)})=>[KNN ${topK} @embedding $query_vector AS vector_distance]`,
      "PARAMS", "2", "query_vector", vectorBuffer(input.embedding, this.options.dimensions),
      "SORTBY", "vector_distance",
      "RETURN", "2", "payload", "vector_distance",
      "LIMIT", "0", String(topK),
      "DIALECT", "2",
    ]);
    return parseSemanticSearchReply(reply);
  }

  async put(input: SemanticCandidateWrite): Promise<void> {
    if (input.embeddingModel !== this.options.embeddingModel) {
      throw new Error(`semantic_embedding_model_mismatch:${input.embeddingModel}:${this.options.embeddingModel}`);
    }
    await this.ensureIndex();
    const payload = JSON.stringify(input.payload);
    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes > this.maxPayloadBytes) {
      throw new Error(`semantic_candidate_payload_too_large:${payloadBytes}:${this.maxPayloadBytes}`);
    }
    const expiresAt = Date.now() + input.ttlMs;
    const key = `${this.keyPrefix}${input.payload.candidateId}`;
    await this.client.command([
      "HSET", key,
      "candidate_id", input.payload.candidateId,
      "project_tag", tag(input.payload.scope.projectId),
      "branch_tag", tag(input.payload.scope.branch),
      "role_tag", tag(input.payload.scope.role),
      "stage_tag", tag(input.payload.scope.stage),
      "schema_tag", tag(input.payload.scope.schemaVersion),
      "embedding_model_tag", tag(input.embeddingModel),
      "expires_at", String(expiresAt),
      "payload", payload,
      "embedding", vectorBuffer(input.embedding, this.options.dimensions),
    ]);
    await this.client.command(["PEXPIRE", key, String(input.ttlMs)]);
  }

  async health(): Promise<SemanticCandidateStoreHealth> {
    const startedAt = Date.now();
    try {
      await this.ensureIndex();
      const pong = await this.client.command(["PING"]);
      if (asText(pong).toUpperCase() !== "PONG") throw new Error("semantic_redis_ping_invalid");
      return {
        status: "up",
        latencyMs: Date.now() - startedAt,
        details: {
          url: this.client.redactedUrl(),
          index: this.indexName,
          keyPrefix: this.keyPrefix,
          dimensions: this.options.dimensions,
          embeddingModel: this.options.embeddingModel,
        },
      };
    } catch (error) {
      return {
        status: "down",
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        details: { url: this.client.redactedUrl(), index: this.indexName },
      };
    }
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.client.close();
  }
}
