import {
  RedisRespClient,
  type RedisCommandClient,
  type RedisReply,
  type RedisRespClientOptions,
} from "@agent-harness/context-semantic-cache";

export type { RedisCommandClient } from "@agent-harness/context-semantic-cache";

export interface ContextRedisMemberAvailability {
  isUnavailable(now?: number): boolean;
  markUnavailable(cooldownMs?: number): void;
  markHealthy(): void;
  snapshot(): {
    unavailableUntil: number;
    lastFailureAt: number | null;
    lastSuccessAt: number | null;
  };
}

export interface ContextRedisMember {
  label: string;
  url: string;
  client: RedisCommandClient;
  availability?: ContextRedisMemberAvailability;
}

export interface ContextRedisPoolOptions {
  urls: string[];
  labels?: string[];
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  failureCooldownMs?: number;
}

function normalizedUrls(values: string[]): string[] {
  const normalized = values
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return [...new Set(normalized)];
}

class RedisMemberAvailability implements ContextRedisMemberAvailability {
  private unavailableUntil = 0;
  private lastFailureAt: number | null = null;
  private lastSuccessAt: number | null = null;

  constructor(private readonly defaultCooldownMs: number) {}

  isUnavailable(now = Date.now()): boolean {
    return now < this.unavailableUntil;
  }

  markUnavailable(cooldownMs = this.defaultCooldownMs): void {
    const now = Date.now();
    this.lastFailureAt = now;
    this.unavailableUntil = Math.max(this.unavailableUntil, now + Math.max(1, Math.trunc(cooldownMs)));
  }

  markHealthy(): void {
    this.lastSuccessAt = Date.now();
    this.unavailableUntil = 0;
  }

  snapshot(): {
    unavailableUntil: number;
    lastFailureAt: number | null;
    lastSuccessAt: number | null;
  } {
    return {
      unavailableUntil: this.unavailableUntil,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
    };
  }
}

class ObservedRedisCommandClient implements RedisCommandClient {
  constructor(
    private readonly delegate: RedisCommandClient,
    private readonly availability: ContextRedisMemberAvailability,
    private readonly failureCooldownMs: number,
  ) {}

  async command(parts: Array<string | Buffer>): Promise<RedisReply> {
    try {
      const result = await this.delegate.command(parts);
      this.availability.markHealthy();
      return result;
    } catch (error) {
      this.availability.markUnavailable(this.failureCooldownMs);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.delegate.close();
  }

  redactedUrl(): string {
    return this.delegate.redactedUrl();
  }
}

export class ContextRedisPool {
  readonly members: ContextRedisMember[];

  constructor(options: ContextRedisPoolOptions) {
    const urls = normalizedUrls(options.urls);
    if (urls.length === 0) throw new Error("context_redis_pool_members_required");
    const failureCooldownMs = options.failureCooldownMs ?? 30_000;
    if (!Number.isFinite(failureCooldownMs) || !Number.isInteger(failureCooldownMs) || failureCooldownMs < 1) {
      throw new Error(`context_redis_pool_failure_cooldown_invalid:${String(failureCooldownMs)}`);
    }
    this.members = urls.map((url, index) => {
      const clientOptions: RedisRespClientOptions = {
        url,
        ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
        ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
      };
      const availability = new RedisMemberAvailability(failureCooldownMs);
      const baseClient = new RedisRespClient(clientOptions);
      return {
        label: options.labels?.[index]?.trim() || `redis-${index + 1}`,
        url,
        client: new ObservedRedisCommandClient(baseClient, availability, failureCooldownMs),
        availability,
      };
    });
  }

  get size(): number {
    return this.members.length;
  }

  async health(timeoutMs = 1_500): Promise<{
    status: "up" | "down";
    redundancyState: "redundant" | "degraded" | "unavailable";
    healthy: number;
    total: number;
    members: Array<{ label: string; status: "up" | "down"; error?: string }>;
  }> {
    const members = await Promise.all(this.members.map(async (member) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const reply = await Promise.race([
          member.client.command(["PING"]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`context_redis_health_timeout:${timeoutMs}`)), timeoutMs);
          }),
        ]);
        const pong = Buffer.isBuffer(reply) ? reply.toString("utf8") : String(reply ?? "");
        if (pong.toUpperCase() !== "PONG") throw new Error(`context_redis_ping_invalid:${pong}`);
        return { label: member.label, status: "up" as const };
      } catch (error) {
        member.availability?.markUnavailable();
        return {
          label: member.label,
          status: "down" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));
    const healthy = members.filter((member) => member.status === "up").length;
    return {
      status: healthy > 0 ? "up" : "down",
      redundancyState: healthy === 0 ? "unavailable" : healthy === members.length ? "redundant" : "degraded",
      healthy,
      total: members.length,
      members,
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.members.map((member) => member.client.close()));
  }
}
