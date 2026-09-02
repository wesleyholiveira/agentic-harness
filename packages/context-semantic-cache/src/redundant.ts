import {
  SemanticDependencyUnavailableError,
  type SemanticDependency,
} from "./errors";
import type {
  EmbeddingProviderHealth,
  SemanticCandidateQuery,
  SemanticCandidateRecord,
  SemanticCandidateStore,
  SemanticCandidateStoreHealth,
  SemanticCandidateWrite,
  SemanticEmbeddingProvider,
} from "./types";

interface PoolMember<T> {
  label: string;
  value: T;
}

interface RedundantPoolOptions {
  healthTimeoutMs?: number;
  memberOperationTimeoutMs?: number;
  minHealthy?: number;
}

const DEFAULT_MEMBER_HEALTH_TIMEOUT_MS = 1_500;
const DEFAULT_MEMBER_OPERATION_TIMEOUT_MS = 1_500;

function normalizedMembers<T>(values: T[], labels: string[] | undefined, code: string): Array<PoolMember<T>> {
  if (values.length === 0) throw new Error(`${code}_members_required`);
  return values.map((value, index) => ({
    value,
    label: labels?.[index]?.trim() || `member-${index + 1}`,
  }));
}

function aggregateFirstError(error: unknown): unknown {
  if (error instanceof AggregateError && error.errors.length > 0) return error.errors[0];
  return error;
}

function poolUnavailable(
  dependency: SemanticDependency,
  causeCode: string,
  label: string,
  error: unknown,
): SemanticDependencyUnavailableError {
  const first = aggregateFirstError(error);
  if (first instanceof SemanticDependencyUnavailableError) return first;
  const message = first instanceof Error ? first.message : String(first);
  return new SemanticDependencyUnavailableError(
    dependency,
    causeCode,
    `${label}:${message}`,
    { ...(first instanceof Error ? { cause: first } : {}) },
  );
}

async function withHealthDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutValue: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function poolState(healthy: number, total: number): "redundant" | "degraded" | "unavailable" {
  if (healthy === 0) return "unavailable";
  return healthy === total ? "redundant" : "degraded";
}

async function withOperationDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`semantic_pool_member_operation_timeout:${label}:${timeoutMs}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createdAtMs(candidate: SemanticCandidateRecord): number {
  const value = Date.parse(candidate.payload.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function mergeCandidateResults(
  results: SemanticCandidateRecord[][],
  topK: number,
): SemanticCandidateRecord[] {
  const byId = new Map<string, SemanticCandidateRecord>();
  for (const candidates of results) {
    for (const candidate of candidates) {
      const current = byId.get(candidate.candidateId);
      if (!current) {
        byId.set(candidate.candidateId, candidate);
        continue;
      }
      // Mirrors can temporarily diverge after a fault or an in-flight write.
      // For the same semantic candidate identity, prefer the newest payload so
      // a recovered stale mirror cannot mask a just-written fresh revision.
      const candidateCreatedAt = createdAtMs(candidate);
      const currentCreatedAt = createdAtMs(current);
      if (candidateCreatedAt > currentCreatedAt
        || (candidateCreatedAt === currentCreatedAt && candidate.distance < current.distance)) {
        byId.set(candidate.candidateId, candidate);
      }
    }
  }
  return [...byId.values()]
    .sort((left, right) => left.distance - right.distance
      || createdAtMs(right) - createdAtMs(left)
      || left.candidateId.localeCompare(right.candidateId))
    .slice(0, Math.max(1, Math.trunc(topK)));
}

/**
 * Active-active pool for the reconstructible Redis semantic candidate cache.
 *
 * A query or write is available when any member succeeds. Member operations
 * are bounded; reads merge successful mirrors and writes wait for bounded mirror
 * settlement so a fast stale/empty peer cannot suppress a fresh candidate.
 * Divergence remains correctness-safe because every reused component is still
 * revision/hash revalidated by Context Pack Builder.
 */
export class RedundantSemanticCandidateStore implements SemanticCandidateStore {
  private readonly members: Array<PoolMember<SemanticCandidateStore>>;
  private readonly healthTimeoutMs: number;
  private readonly memberOperationTimeoutMs: number;
  private readonly minHealthy: number;

  constructor(
    stores: SemanticCandidateStore[],
    labels?: string[],
    options: RedundantPoolOptions = {},
  ) {
    this.members = normalizedMembers(stores, labels, "semantic_redis_pool");
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_MEMBER_HEALTH_TIMEOUT_MS;
    this.memberOperationTimeoutMs = options.memberOperationTimeoutMs ?? DEFAULT_MEMBER_OPERATION_TIMEOUT_MS;
    this.minHealthy = options.minHealthy ?? 1;
    if (!Number.isInteger(this.minHealthy) || this.minHealthy < 1 || this.minHealthy > this.members.length) {
      throw new Error(`semantic_redis_pool_min_healthy_invalid:${this.minHealthy}:${this.members.length}`);
    }
  }

  async query(input: SemanticCandidateQuery): Promise<SemanticCandidateRecord[]> {
    const settled = await Promise.allSettled(this.members.map(({ label, value }) =>
      withOperationDeadline(value.query(input), this.memberOperationTimeoutMs, label)));
    const successful = settled
      .filter((result): result is PromiseFulfilledResult<SemanticCandidateRecord[]> => result.status === "fulfilled")
      .map((result) => result.value);
    if (successful.length === 0) {
      const failures = settled
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      throw poolUnavailable(
        "redis",
        "semantic_redis_unavailable",
        "semantic_redis_pool_unavailable",
        new AggregateError(failures, "semantic Redis query failed on every member"),
      );
    }

    // A fast empty/stale mirror must not mask a reusable candidate that exists
    // on another healthy member. Merge all bounded successful reads and let the
    // Context Pack Builder perform the authoritative revision/hash validation.
    return mergeCandidateResults(successful, input.topK);
  }

  async put(input: SemanticCandidateWrite): Promise<void> {
    const settled = await Promise.allSettled(this.members.map(({ label, value }) =>
      withOperationDeadline(value.put(input), this.memberOperationTimeoutMs, label)));
    if (settled.some((result) => result.status === "fulfilled")) return;

    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    throw poolUnavailable(
      "redis",
      "semantic_redis_unavailable",
      "semantic_redis_pool_unavailable",
      new AggregateError(failures, "semantic Redis write failed on every member"),
    );
  }

  async health(): Promise<SemanticCandidateStoreHealth> {
    const startedAt = Date.now();
    const members = await Promise.all(this.members.map(async ({ label, value }) => {
      try {
        const health = await withHealthDeadline(
          value.health(),
          this.healthTimeoutMs,
          () => ({
            status: "down" as const,
            error: `semantic_redis_pool_member_health_timeout:${label}:${this.healthTimeoutMs}`,
            details: { member: label, timeout_ms: this.healthTimeoutMs },
          }),
        );
        return { label, ...health };
      } catch (error) {
        return {
          label,
          status: "down" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    const healthy = members.filter((member) => member.status === "up").length;
    const available = healthy >= this.minHealthy;
    const state = poolState(healthy, members.length);
    return {
      status: available ? "up" : "down",
      latencyMs: Date.now() - startedAt,
      ...(available ? {} : { error: `semantic_redis_pool_unavailable:${healthy}/${members.length}` }),
      details: {
        dependency: "redis",
        error_code: available ? null : "context_semantic_dependency_unavailable",
        cause_code: available ? null : "semantic_redis_unavailable",
        topology: "active-active-reconstructible-cache",
        redundancy_state: state,
        pool_size: members.length,
        healthy_endpoints: healthy,
        required_healthy: this.minHealthy,
        members,
      },
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.members.map(({ value }) => value.close()));
  }
}

/** Stateless TEI pool. Every member must be configured with the exact same model identity. */
export class RedundantSemanticEmbeddingProvider implements SemanticEmbeddingProvider {
  private readonly members: Array<PoolMember<SemanticEmbeddingProvider>>;
  private readonly healthTimeoutMs: number;
  private readonly minHealthy: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly revision: string;
  readonly dimensions: number;

  constructor(
    providers: SemanticEmbeddingProvider[],
    labels?: string[],
    options: RedundantPoolOptions = {},
  ) {
    this.members = normalizedMembers(providers, labels, "semantic_embedding_pool");
    const canonical = this.members[0]?.value;
    if (!canonical) throw new Error("semantic_embedding_pool_members_required");
    this.providerId = canonical.providerId;
    this.modelId = canonical.modelId;
    this.revision = canonical.revision;
    this.dimensions = canonical.dimensions;
    for (const member of this.members.slice(1)) {
      const candidate = member.value;
      if (
        candidate.providerId !== this.providerId
        || candidate.modelId !== this.modelId
        || candidate.revision !== this.revision
        || candidate.dimensions !== this.dimensions
      ) {
        throw new Error(`semantic_embedding_pool_identity_mismatch:${member.label}`);
      }
    }
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_MEMBER_HEALTH_TIMEOUT_MS;
    this.minHealthy = options.minHealthy ?? 1;
    if (!Number.isInteger(this.minHealthy) || this.minHealthy < 1 || this.minHealthy > this.members.length) {
      throw new Error(`semantic_embedding_pool_min_healthy_invalid:${this.minHealthy}:${this.members.length}`);
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
      return await Promise.any(this.members.map(({ value }) => value.embed(texts)));
    } catch (error) {
      throw poolUnavailable(
        "embedding",
        "semantic_embedding_transport_unavailable",
        "semantic_embedding_pool_unavailable",
        error,
      );
    }
  }

  async health(): Promise<EmbeddingProviderHealth> {
    const startedAt = Date.now();
    const members = await Promise.all(this.members.map(async ({ label, value }) => {
      try {
        const health = await withHealthDeadline(
          value.health(),
          this.healthTimeoutMs,
          () => ({
            status: "down" as const,
            error: `semantic_embedding_pool_member_health_timeout:${label}:${this.healthTimeoutMs}`,
            details: { member: label, timeout_ms: this.healthTimeoutMs },
          }),
        );
        return { label, ...health };
      } catch (error) {
        return {
          label,
          status: "down" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    const healthy = members.filter((member) => member.status === "up").length;
    const available = healthy >= this.minHealthy;
    const state = poolState(healthy, members.length);
    return {
      status: available ? "up" : "down",
      latencyMs: Date.now() - startedAt,
      ...(available ? {} : { error: `semantic_embedding_pool_unavailable:${healthy}/${members.length}` }),
      details: {
        dependency: "embedding",
        error_code: available ? null : "context_semantic_dependency_unavailable",
        cause_code: available ? null : "semantic_embedding_transport_unavailable",
        topology: "stateless-active-active",
        redundancy_state: state,
        pool_size: members.length,
        healthy_endpoints: healthy,
        required_healthy: this.minHealthy,
        provider: this.providerId,
        model: this.modelId,
        revision: this.revision,
        dimensions: this.dimensions,
        members,
      },
    };
  }
}
