import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Decision, DecisionQuery, TaskRecord } from "./types";

export interface ProjectMemoryOptions {
  connectionString?: string;
  projectId: string;
  pool?: Pool;
  poolMax?: number;
  migrationRequired?: boolean;
  allowEmptyInstall?: boolean;
}

function normalizedFtsText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Individual unicode61-like tokens persisted in PostgreSQL for the GIN prefilter. */
export function canonicalMemoryTokens(value: string): string[] {
  const tokens = normalizedFtsText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
  return [...new Set(tokens)];
}

/**
 * Preserve the legacy FTS5 query contract: outer tokens shorter than two chars
 * are ignored, hyphen/underscore-containing chunks remain quoted phrases, and
 * those phrases are OR-ed together. The SQL array overlap is only a prefilter;
 * final acceptance is deterministic here.
 */
export function canonicalMemoryQueryPhrases(value: string): string[][] {
  const chunks = normalizedFtsText(value)
    .replaceAll('"', " ")
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  const phrases: string[][] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const phrase = chunk.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (phrase.length === 0) continue;
    const key = phrase.join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
  }
  return phrases;
}

function matchesLegacyFts(value: string, phrases: string[][]): boolean {
  if (phrases.length === 0) return false;
  const tokens = normalizedFtsText(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return phrases.some((phrase) => {
    if (phrase.length === 1) return tokens.includes(phrase[0]!);
    outer: for (let start = 0; start <= tokens.length - phrase.length; start++) {
      for (let offset = 0; offset < phrase.length; offset++) {
        if (tokens[start + offset] !== phrase[offset]) continue outer;
      }
      return true;
    }
    return false;
  });
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface ProjectMemoryRevisionState {
  decisionCount: number;
  decisionLatest: number;
  taskCount: number;
  taskLatest: number;
}

function revisionString(state: ProjectMemoryRevisionState): string {
  return `decisions:${state.decisionCount}:${state.decisionLatest}|tasks:${state.taskCount}:${state.taskLatest}`;
}

function parseRevisionString(value: unknown): ProjectMemoryRevisionState | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^decisions:(\d+):(\d+)\|tasks:(\d+):(\d+)$/.exec(value);
  if (!match) return undefined;
  return {
    decisionCount: Number(match[1]),
    decisionLatest: Number(match[2]),
    taskCount: Number(match[3]),
    taskLatest: Number(match[4]),
  };
}

function revisionStateFromRow(row: Record<string, unknown> | undefined): ProjectMemoryRevisionState | undefined {
  if (!row) return undefined;
  return {
    decisionCount: asNumber(row.decision_count),
    decisionLatest: asNumber(row.decision_latest),
    taskCount: asNumber(row.task_count),
    taskLatest: asNumber(row.task_latest),
  };
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

export class ProjectMemory {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  readonly projectId: string;
  private readonly migrationRequired: boolean;
  private readonly allowEmptyInstall: boolean;
  private readyPromise: Promise<void> | undefined;

  constructor(options: ProjectMemoryOptions) {
    this.projectId = options.projectId.trim();
    this.migrationRequired = options.migrationRequired ?? false;
    this.allowEmptyInstall = options.allowEmptyInstall ?? false;
    if (!this.projectId) throw new Error("project_memory_project_id_required");
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      const connectionString = options.connectionString?.trim();
      if (!connectionString) throw new Error("project_memory_postgres_url_required");
      this.pool = new Pool({ connectionString, max: options.poolMax ?? 4 });
      this.ownsPool = true;
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.migrationRequired) return;
    if (!this.readyPromise) {
      this.readyPromise = this.assertReady({
        migrationRequired: true,
        allowEmptyInstall: this.allowEmptyInstall,
      }).catch((error) => {
        this.readyPromise = undefined;
        throw error;
      });
    }
    await this.readyPromise;
  }

  async storeDecision(dec: Omit<Decision, "id" | "created_at">): Promise<string> {
    await this.ensureReady();
    const id = randomUUID();
    const createdAt = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO context_project_memory_decisions(
           project_id, id, title, content, rationale, files, symbols, commit_sha, created_at, search_tokens
         ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::text[])`,
        [
          this.projectId,
          id,
          dec.title,
          dec.content,
          dec.rationale,
          JSON.stringify(dec.files),
          JSON.stringify(dec.symbols),
          dec.commit,
          createdAt,
          canonicalMemoryTokens(dec.content),
        ],
      );
      await client.query(
        `INSERT INTO context_project_memory_revision(
           project_id, decision_count, decision_latest, task_count, task_latest, updated_at
         ) VALUES($1,1,$2,0,0,now())
         ON CONFLICT(project_id) DO UPDATE SET
           decision_count=context_project_memory_revision.decision_count+1,
           decision_latest=GREATEST(context_project_memory_revision.decision_latest,EXCLUDED.decision_latest),
           updated_at=now()`,
        [this.projectId, createdAt],
      );
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getDecisions(query: DecisionQuery): Promise<Decision[]> {
    await this.ensureReady();
    const phrases = canonicalMemoryQueryPhrases(query.query);
    if (phrases.length === 0) return [];
    const tokens = [...new Set(phrases.flat())];
    const limit = query.limit === undefined ? undefined : Math.max(0, Math.trunc(query.limit));
    if (limit === 0) return [];
    const result = await this.pool.query(
      `SELECT id, title, content, rationale, files, symbols, commit_sha, created_at
       FROM context_project_memory_decisions
       WHERE project_id=$1 AND search_tokens && $2::text[]
       ORDER BY created_at DESC, id ASC`,
      [this.projectId, tokens],
    );
    const rows = result.rows
      .filter((row) => matchesLegacyFts(String(row.content), phrases))
      .map((row) => ({
        id: String(row.id),
        title: String(row.title),
        content: String(row.content),
        rationale: String(row.rationale),
        files: asStringArray(row.files),
        symbols: asStringArray(row.symbols),
        commit: String(row.commit_sha),
        created_at: asNumber(row.created_at),
      }));
    return limit === undefined ? rows : rows.slice(0, limit);
  }

  async storeTaskRecord(rec: Omit<TaskRecord, "id" | "created_at">): Promise<string> {
    await this.ensureReady();
    const id = randomUUID();
    const createdAt = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO context_project_memory_task_history(
           project_id, id, task_desc, context_pack_hash, outcome, files_touched, created_at, search_tokens
         ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::text[])`,
        [
          this.projectId,
          id,
          rec.task_desc,
          rec.context_pack_hash,
          rec.outcome,
          JSON.stringify(rec.files_touched),
          createdAt,
          canonicalMemoryTokens(rec.task_desc),
        ],
      );
      await client.query(
        `INSERT INTO context_project_memory_revision(
           project_id, decision_count, decision_latest, task_count, task_latest, updated_at
         ) VALUES($1,0,0,1,$2,now())
         ON CONFLICT(project_id) DO UPDATE SET
           task_count=context_project_memory_revision.task_count+1,
           task_latest=GREATEST(context_project_memory_revision.task_latest,EXCLUDED.task_latest),
           updated_at=now()`,
        [this.projectId, createdAt],
      );
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getTaskHistory(query: string, limit?: number): Promise<TaskRecord[]> {
    await this.ensureReady();
    const phrases = canonicalMemoryQueryPhrases(query);
    if (phrases.length === 0) return [];
    const tokens = [...new Set(phrases.flat())];
    const normalizedLimit = limit === undefined ? undefined : Math.max(0, Math.trunc(limit));
    if (normalizedLimit === 0) return [];
    const result = await this.pool.query(
      `SELECT id, task_desc, context_pack_hash, outcome, files_touched, created_at
       FROM context_project_memory_task_history
       WHERE project_id=$1 AND search_tokens && $2::text[]
       ORDER BY created_at DESC, id ASC`,
      [this.projectId, tokens],
    );
    const rows = result.rows
      .filter((row) => matchesLegacyFts(String(row.task_desc), phrases))
      .map((row) => ({
        id: String(row.id),
        task_desc: String(row.task_desc),
        context_pack_hash: String(row.context_pack_hash),
        outcome: String(row.outcome),
        files_touched: asStringArray(row.files_touched),
        created_at: asNumber(row.created_at),
      }));
    return normalizedLimit === undefined ? rows : rows.slice(0, normalizedLimit);
  }

  async getRevision(): Promise<string> {
    await this.ensureReady();
    const result = await this.pool.query(
      `SELECT decision_count,decision_latest,task_count,task_latest
       FROM context_project_memory_revision
       WHERE project_id=$1`,
      [this.projectId],
    );
    const state = revisionStateFromRow(result.rows[0]);
    return state ? revisionString(state) : "decisions:0:0|tasks:0:0";
  }

  async migrationStatus(sourceDigest?: string): Promise<{ ready: boolean; sourceDigest?: string }> {
    const result = await this.pool.query(
      `SELECT
         m.source_digest,
         m.source_revision,
         r.decision_count,
         r.decision_latest,
         r.task_count,
         r.task_latest
       FROM context_project_memory_migrations m
       LEFT JOIN context_project_memory_revision r ON r.project_id=m.project_id
       WHERE m.project_id=$1 AND m.schema_version='project-memory/postgres/v1'
       ORDER BY m.imported_at DESC LIMIT 1`,
      [this.projectId],
    );
    const row = result.rows[0];
    const digest = row?.source_digest;
    const baseline = parseRevisionString(row?.source_revision);
    const current = revisionStateFromRow(row);
    const revisionReady = Boolean(
      baseline
      && current
      && current.decisionCount >= baseline.decisionCount
      && current.decisionLatest >= baseline.decisionLatest
      && current.taskCount >= baseline.taskCount
      && current.taskLatest >= baseline.taskLatest
    );
    const ready = typeof digest === "string"
      && (!sourceDigest || digest === sourceDigest)
      && revisionReady;
    return { ready, ...(typeof digest === "string" ? { sourceDigest: digest } : {}) };
  }

  async assertReady(options: { migrationRequired: boolean; allowEmptyInstall: boolean }): Promise<void> {
    if (!options.migrationRequired) return;
    const migration = await this.migrationStatus();
    if (migration.ready) return;
    if (options.allowEmptyInstall) {
      const counts = await this.pool.query(
        `SELECT
          (SELECT COUNT(*) FROM context_project_memory_decisions WHERE project_id=$1) AS decisions,
          (SELECT COUNT(*) FROM context_project_memory_task_history WHERE project_id=$1) AS tasks`,
        [this.projectId],
      );
      const row = counts.rows[0] ?? {};
      if (asNumber(row.decisions) === 0 && asNumber(row.tasks) === 0) return;
    }
    throw new Error("project_memory_migration_required");
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
