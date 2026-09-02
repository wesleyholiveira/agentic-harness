import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { CBMAdapter } from "@agent-harness/cbm-adapter";
import {
  createCacheKey,
  type CacheTier,
  type TieredContextCache,
} from "@agent-harness/context-cache";
import type { Context7Adapter } from "@agent-harness/context7-adapter";
import type { Decision, ProjectMemory } from "@agent-harness/project-memory";
import type { SummaryManager } from "@agent-harness/summary-manager";
import type {
  SemanticCacheScope,
  SemanticComponentSnapshot,
  SemanticComponentSource,
  SemanticContextCache,
} from "@agent-harness/context-semantic-cache";
import { analyzeTask } from "./task-analyzer";
import { estimateTokens, optimize } from "./budget-optimizer";
import { StaticArtifactCache } from "./static-artifact-cache";
import {
  semanticRelevantPaths,
  toSemanticSourceRevisions,
  toSemanticTaskDescriptor,
  type ContextPackBuildContext,
} from "./semantic-candidate";
import type {
  ComponentCacheMetadata,
  ContextPack,
  FileDependency,
  SemanticCacheMetadata,
  StaticArtifact,
  TaskAnalysis,
} from "./types";

interface CachedValue<T> {
  value: T;
  file_dependencies: FileDependency[];
}

interface SourceRevisions {
  memory: string;
  cbm: string;
  artifacts: string;
}

export interface ContextPackBuilderOptions {
  cache?: TieredContextCache;
  rawPackTtlMs?: number;
  componentTtlMs?: number;
  cbmRevisionTtlMs?: number;
  externalDocsTtlMs?: number;
  staticArtifactTtlMs?: number;
  staticArtifactLimit?: number;
  staticArtifacts?: StaticArtifactCache | false;
  semanticCache?: SemanticContextCache;
  semanticScopeDefaults?: Partial<SemanticCacheScope>;
  cwd?: string;
}

export interface ContextPackBuildResult {
  pack: ContextPack;
  rawPack: ContextPack;
}

interface BuildCacheState {
  hits: number;
  misses: number;
  hitSources: string[];
  missSources: string[];
}

interface SemanticReuseState {
  metadata: SemanticCacheMetadata;
  queryEmbedding?: number[];
  memoryDecisions?: SemanticComponentSnapshot;
  symbols?: SemanticComponentSnapshot;
}

const DEFAULT_RAW_PACK_TTL_MS = 60 * 60 * 1000;
const DEFAULT_COMPONENT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CBM_REVISION_TTL_MS = 10_000;
const DEFAULT_EXTERNAL_DOCS_TTL_MS = 24 * 60 * 60 * 1000;
const CONTEXT_PACK_SCHEMA_VERSION = "context-semantic-candidate/v1";

export class ContextPackBuilder {
  private cache: TieredContextCache | undefined;
  private rawPackTtlMs: number;
  private componentTtlMs: number;
  private cbmRevisionTtlMs: number;
  private externalDocsTtlMs: number;
  private cwd: string;
  private staticArtifacts: StaticArtifactCache | undefined;
  private semanticCache: SemanticContextCache | undefined;
  private semanticScopeDefaults: Partial<SemanticCacheScope>;

  constructor(
    private cbm: CBMAdapter,
    private memory: ProjectMemory,
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: reserved DI seam; V1 leaves summaries empty
    private summaryManager: SummaryManager,
    private context7?: Context7Adapter,
    options: ContextPackBuilderOptions = {},
  ) {
    this.cache = options.cache;
    this.rawPackTtlMs = options.rawPackTtlMs ?? DEFAULT_RAW_PACK_TTL_MS;
    this.componentTtlMs = options.componentTtlMs ?? DEFAULT_COMPONENT_TTL_MS;
    this.cbmRevisionTtlMs = options.cbmRevisionTtlMs ?? DEFAULT_CBM_REVISION_TTL_MS;
    this.externalDocsTtlMs = options.externalDocsTtlMs ?? DEFAULT_EXTERNAL_DOCS_TTL_MS;
    this.cwd = options.cwd ?? process.cwd();
    this.semanticCache = options.semanticCache;
    this.semanticScopeDefaults = options.semanticScopeDefaults ?? {};
    this.staticArtifacts =
      options.staticArtifacts === false
        ? undefined
        : (options.staticArtifacts ??
          new StaticArtifactCache({
            cwd: this.cwd,
            ...(this.cache === undefined ? {} : { cache: this.cache }),
            ...(options.staticArtifactTtlMs === undefined ? {} : { ttlMs: options.staticArtifactTtlMs }),
            ...(options.staticArtifactLimit === undefined ? {} : { resultLimit: options.staticArtifactLimit }),
          }));
  }

  async build(task: string, budget = 18000, context: ContextPackBuildContext = {}): Promise<ContextPack> {
    return (await this.buildWithRaw(task, budget, context)).pack;
  }

  async buildWithRaw(
    task: string,
    budget = 18000,
    context: ContextPackBuildContext = {},
  ): Promise<ContextPackBuildResult> {
    const taskAnalysis = analyzeTask(task);
    const cacheState: BuildCacheState = { hits: 0, misses: 0, hitSources: [], missSources: [] };
    const sourceRevisions = await this.resolveSourceRevisions(taskAnalysis, cacheState);
    const rawPackKey = createCacheKey("context-pack:raw:v2", {
      task_signature: taskAnalysis.signature.fingerprint,
      source_revisions: sourceRevisions,
    });

    const rawHit = await this.getCached<ContextPack>(rawPackKey);
    if (rawHit) {
      const details = {
        cacheHit: true,
        cacheTier: rawHit.tier,
        rawPackKey,
        cacheState,
        sourceRevisions,
        semanticMetadata: this.semanticMetadata("exact-hit-skipped"),
      };
      return {
        pack: this.prepareForDelivery(rawHit.value, budget, details),
        rawPack: this.prepareRawPack(rawHit.value, budget, details),
      };
    }

    const semanticState = await this.resolveSemanticReuse(task, taskAnalysis, sourceRevisions, context);
    const rawPack = await this.buildRawPack(
      task,
      taskAnalysis,
      sourceRevisions,
      cacheState,
      semanticState,
    );
    await this.storeSemanticCandidate(task, rawPackKey, sourceRevisions, rawPack, semanticState);
    if (this.rawPackIsCacheable(rawPack)) {
      const fileDependencies = this.capturePackDependencies(rawPack);
      await this.setCached(rawPackKey, rawPack, fileDependencies, this.rawPackTtlMs);
    }
    const details = {
      cacheHit: false,
      rawPackKey,
      cacheState,
      sourceRevisions,
      semanticMetadata: semanticState.metadata,
    };

    return {
      pack: this.prepareForDelivery(rawPack, budget, details),
      rawPack: this.prepareRawPack(rawPack, budget, details),
    };
  }

  private async buildRawPack(
    task: string,
    taskAnalysis: TaskAnalysis,
    sourceRevisions: SourceRevisions,
    cacheState: BuildCacheState,
    semanticState: SemanticReuseState,
  ): Promise<ContextPack> {
    const warnings: string[] = [];
    const sourcesQueried: string[] = [];
    if (semanticState.metadata.status === "candidate-reused") sourcesQueried.push("semantic-cache");
    if (semanticState.metadata.status === "unavailable") warnings.push("semantic_cache_unavailable");

    const previousDecisions = await this.resolveMemoryDecisions(
      taskAnalysis,
      sourceRevisions,
      warnings,
      sourcesQueried,
      cacheState,
      semanticState.memoryDecisions,
    );
    const symbols = await this.resolveSymbols(
      taskAnalysis,
      sourceRevisions,
      warnings,
      sourcesQueried,
      cacheState,
      semanticState.symbols,
    );
    const architecture = await this.resolveArchitecture(
      sourceRevisions,
      warnings,
      sourcesQueried,
      cacheState,
    );
    const staticArtifacts = await this.resolveStaticArtifacts(
      taskAnalysis,
      warnings,
      sourcesQueried,
      cacheState,
    );
    const externalDocs = await this.resolveExternalDocs(
      task,
      taskAnalysis,
      warnings,
      sourcesQueried,
      cacheState,
    );

    return {
      task_analysis: taskAnalysis,
      previous_decisions: previousDecisions,
      symbols,
      architecture,
      static_artifacts: staticArtifacts,
      summaries: [],
      dependencies: { callers: [], callees: [], tests: [] },
      external_docs: externalDocs,
      metadata: {
        total_tokens: 0,
        budget: 18000,
        sources_queried: sourcesQueried,
        cache_hit: false,
        component_cache: this.toComponentCacheMetadata(cacheState),
        semantic_cache: structuredClone(semanticState.metadata),
        source_revisions: { ...sourceRevisions },
        generated_at: new Date().toISOString(),
        warnings,
      },
    };
  }

  private async resolveMemoryDecisions(
    taskAnalysis: TaskAnalysis,
    sourceRevisions: SourceRevisions,
    warnings: string[],
    sourcesQueried: string[],
    cacheState: BuildCacheState,
    semantic?: SemanticComponentSnapshot,
  ): Promise<Decision[]> {
    const key = createCacheKey("context-component:memory-decisions:v2", {
      query: taskAnalysis.signature.canonical_query,
      revision: sourceRevisions.memory,
    });
    const cached = await this.getCached<Decision[]>(key);
    if (cached) {
      this.recordComponentHit(cacheState, "memory");
      return cached.value;
    }

    this.recordComponentMiss(cacheState, "memory");
    if (semantic) {
      const value = structuredClone(semantic.value) as Decision[];
      await this.setCached(key, value, []);
      return value;
    }
    try {
      const query = taskAnalysis.signature.canonical_query || taskAnalysis.concepts.join(" ");
      const decisions = query ? await this.memory.getDecisions({ query, limit: 5 }) : [];
      sourcesQueried.push("memory");
      await this.setCached(
        key,
        decisions,
        [],
      );
      return decisions;
    } catch {
      warnings.push("memory_unavailable");
      return [];
    }
  }

  private async resolveSymbols(
    taskAnalysis: TaskAnalysis,
    sourceRevisions: SourceRevisions,
    warnings: string[],
    sourcesQueried: string[],
    cacheState: BuildCacheState,
    semantic?: SemanticComponentSnapshot,
  ): Promise<unknown[]> {
    const searchTerm = this.symbolSearchTerm(taskAnalysis);
    const key = createCacheKey("context-component:cbm-symbols:v2", {
      query: searchTerm,
      component_scope: taskAnalysis.signature.component_scope,
      revision: sourceRevisions.cbm,
    });
    const cached = await this.getCached<unknown[]>(key);
    if (cached) {
      this.recordComponentHit(cacheState, "cbm-symbols");
      return cached.value;
    }

    this.recordComponentMiss(cacheState, "cbm-symbols");
    if (semantic) {
      const value = structuredClone(semantic.value) as unknown[];
      await this.setCached(key, value, semantic.fileDependencies);
      return value;
    }
    try {
      const symbols = await this.cbm.searchSymbols(`.*${this.escapeRegex(searchTerm)}.*`);
      sourcesQueried.push("cbm");
      const filePaths = symbols
        .map((symbol) => symbol.file)
        .filter((path): path is string => typeof path === "string");
      await this.setCached(key, symbols, this.captureFileDependencies(filePaths));
      return symbols;
    } catch {
      warnings.push("cbm_unavailable");
      return [];
    }
  }

  private async resolveArchitecture(
    sourceRevisions: SourceRevisions,
    warnings: string[],
    sourcesQueried: string[],
    cacheState: BuildCacheState,
  ): Promise<string> {
    const key = createCacheKey("context-component:cbm-architecture:v2", { revision: sourceRevisions.cbm });
    const cached = await this.getCached<string>(key);
    if (cached) {
      this.recordComponentHit(cacheState, "architecture");
      return cached.value;
    }

    this.recordComponentMiss(cacheState, "architecture");
    try {
      const architecture = await this.cbm.getArchitecture();
      sourcesQueried.push("architecture");
      await this.setCached(key, architecture, [], this.componentTtlMs);
      return architecture;
    } catch {
      warnings.push("architecture_unavailable");
      return "";
    }
  }

  private async resolveExternalDocs(
    task: string,
    taskAnalysis: TaskAnalysis,
    warnings: string[],
    sourcesQueried: string[],
    cacheState: BuildCacheState,
  ): Promise<unknown[]> {
    if (!taskAnalysis.external_api_needed || !this.context7) return [];

    const library = taskAnalysis.signature.external_libraries[0] ?? taskAnalysis.concepts[0] ?? "unknown";
    const key = createCacheKey("context-component:context7:v2", {
      library,
      query: taskAnalysis.signature.canonical_query,
    });
    const cached = await this.getCached<unknown[]>(key);
    if (cached) {
      this.recordComponentHit(cacheState, "context7");
      return cached.value;
    }

    this.recordComponentMiss(cacheState, "context7");
    try {
      const docs = await this.context7.getDocsByName(library, task);
      sourcesQueried.push("context7");
      await this.setCached(key, docs, [], this.externalDocsTtlMs);
      return docs;
    } catch {
      warnings.push("context7_unavailable");
      return [];
    }
  }

  private async resolveSourceRevisions(
    taskAnalysis: TaskAnalysis,
    cacheState: BuildCacheState,
  ): Promise<SourceRevisions> {
    let memoryRevision = "memory:unversioned";
    try {
      const getRevision = (this.memory as ProjectMemory & { getRevision?: () => Promise<string> }).getRevision;
      if (typeof getRevision === "function") {
        memoryRevision = await getRevision.call(this.memory);
      }
    } catch {
      memoryRevision = "memory:unavailable";
    }

    const cbmKey = createCacheKey("context-component:cbm-index-status:v2", { project: "default" });
    const cached = await this.getCached<string>(cbmKey);
    if (cached) {
      this.recordComponentHit(cacheState, "cbm-index-status");
      return {
        memory: memoryRevision,
        cbm: cached.value,
        artifacts: this.staticArtifacts?.getTaskRevision(taskAnalysis) ?? "artifacts:disabled",
      };
    }

    this.recordComponentMiss(cacheState, "cbm-index-status");
    let cbmRevision = "cbm:unversioned";
    try {
      const getIndexStatus = (this.cbm as CBMAdapter & { getIndexStatus?: CBMAdapter["getIndexStatus"] })
        .getIndexStatus;
      if (typeof getIndexStatus === "function") {
        const status = await getIndexStatus.call(this.cbm);
        cbmRevision = createCacheKey("cbm-index-revision:v1", status);
      }
    } catch {
      cbmRevision = "cbm:unavailable";
    }
    if (cbmRevision !== "cbm:unavailable") {
      await this.setCached(cbmKey, cbmRevision, [], this.cbmRevisionTtlMs);
    }
    return {
      memory: memoryRevision,
      cbm: cbmRevision,
      artifacts: this.staticArtifacts?.getTaskRevision(taskAnalysis) ?? "artifacts:disabled",
    };
  }

  private async resolveStaticArtifacts(
    taskAnalysis: TaskAnalysis,
    warnings: string[],
    sourcesQueried: string[],
    cacheState: BuildCacheState,
  ): Promise<StaticArtifact[]> {
    if (!this.staticArtifacts) return [];


    try {
      const result = await this.staticArtifacts.search(taskAnalysis);
      if (result.artifacts.length > 0) sourcesQueried.push("static-artifacts");
      if (result.cache_hits > 0) this.recordComponentHit(cacheState, "static-artifacts");
      if (result.cache_misses > 0) this.recordComponentMiss(cacheState, "static-artifacts");
      return result.artifacts;
    } catch {
      warnings.push("static_artifacts_unavailable");
      return [];
    }
  }

  private prepareForDelivery(
    rawPack: ContextPack,
    budget: number,
    details: {
      cacheHit: boolean;
      cacheTier?: CacheTier;
      rawPackKey: string;
      cacheState: BuildCacheState;
      sourceRevisions: SourceRevisions;
      semanticMetadata: SemanticCacheMetadata;
    },
  ): ContextPack {
    return optimize(this.prepareRawPack(rawPack, budget, details), budget);
  }

  private prepareRawPack(
    rawPack: ContextPack,
    budget: number,
    details: {
      cacheHit: boolean;
      cacheTier?: CacheTier;
      rawPackKey: string;
      cacheState: BuildCacheState;
      sourceRevisions: SourceRevisions;
      semanticMetadata: SemanticCacheMetadata;
    },
  ): ContextPack {
    const copy = structuredClone(rawPack);
    copy.metadata = {
      ...copy.metadata,
      budget,
      total_tokens: 0,
      cache_hit: details.cacheHit,
      raw_pack_cache_key: details.rawPackKey,
      component_cache: this.toComponentCacheMetadata(details.cacheState),
      semantic_cache: structuredClone(details.semanticMetadata),
      source_revisions: { ...details.sourceRevisions },
      served_at: new Date().toISOString(),
    };
    if (details.cacheTier) {
      copy.metadata.cache_tier = details.cacheTier;
    } else {
      delete copy.metadata.cache_tier;
    }
    copy.metadata.total_tokens = estimateTokens(copy);
    return copy;
  }

  private semanticMetadata(status: SemanticCacheMetadata["status"]): SemanticCacheMetadata {
    const cache = this.semanticCache;
    return {
      enabled: cache !== undefined && cache.config.mode !== "off",
      mode: cache?.config.mode ?? "off",
      status: cache ? status : "disabled",
      candidate_hit: false,
      ...(cache ? {
        provider: cache.embeddings.providerId,
        model: cache.embeddings.modelId,
        model_revision: cache.embeddings.revision,
      } : {}),
      candidates_considered: 0,
      components_considered: 0,
      components_reusable: [],
      would_reuse_components: [],
      components_reused: [],
      components_refreshed: [],
      stale_components: [],
      stale_component_reasons: {},
      relevant_paths: [],
      tokens_avoided_estimate: 0,
      retrieval_calls_avoided: 0,
      lookup_ms: 0,
      embedding_ms: 0,
      store_status: cache ? "not-attempted" : "disabled",
      store_ms: 0,
    };
  }

  private semanticScope(context: ContextPackBuildContext): SemanticCacheScope {
    const requested = context.semanticScope ?? {};
    const configured = this.semanticCache?.config;
    return {
      projectId:
        requested.projectId
        ?? this.semanticScopeDefaults.projectId
        ?? configured?.projectId
        ?? "unknown-project",
      branch:
        requested.branch
        ?? this.semanticScopeDefaults.branch
        ?? configured?.branch
        ?? "unknown-branch",
      role: requested.role ?? this.semanticScopeDefaults.role ?? "generic",
      stage: requested.stage ?? this.semanticScopeDefaults.stage ?? "generic",
      schemaVersion:
        requested.schemaVersion
        ?? this.semanticScopeDefaults.schemaVersion
        ?? configured?.schemaVersion
        ?? CONTEXT_PACK_SCHEMA_VERSION,
    };
  }

  private async resolveSemanticReuse(
    task: string,
    taskAnalysis: TaskAnalysis,
    sourceRevisions: SourceRevisions,
    context: ContextPackBuildContext,
  ): Promise<SemanticReuseState> {
    const cache = this.semanticCache;
    if (!cache || cache.config.mode === "off") {
      return { metadata: this.semanticMetadata("disabled") };
    }

    const scope = this.semanticScope(context);
    const lookup = await cache.lookup({
      task: toSemanticTaskDescriptor(task, taskAnalysis),
      scope,
      sourceRevisions: toSemanticSourceRevisions(sourceRevisions),
    });
    const baseMetadata: SemanticCacheMetadata = {
      ...this.semanticMetadata(
        lookup.status === "unavailable" ? "unavailable" : lookup.candidateHit ? "candidate-rejected" : "miss",
      ),
      scope,
      candidate_hit: lookup.candidateHit,
      candidates_considered: lookup.candidatesConsidered,
      lookup_ms: lookup.lookupMs,
      embedding_ms: lookup.embeddingMs,
      ...(lookup.warnings[0] ? { warning: lookup.warnings.join(";") } : {}),
    };

    if (!lookup.candidateHit) {
      cache.recordOutcome({
        candidateHit: false,
        candidateAccepted: false,
        componentsConsidered: 0,
        componentsReusable: 0,
        componentsReused: 0,
        componentsRefreshed: 0,
        componentsStale: 0,
        tokensAvoidedEstimate: 0,
        retrievalCallsAvoided: 0,
      });
      return {
        metadata: baseMetadata,
        ...(lookup.queryEmbedding ? { queryEmbedding: lookup.queryEmbedding } : {}),
      };
    }

    const expectations: Record<SemanticComponentSource, string> = {
      "memory-decisions": sourceRevisions.memory,
      "cbm-symbols": sourceRevisions.cbm,
    };
    let rejectedMetadata = baseMetadata;

    for (const candidate of lookup.candidates) {
      if (
        candidate.payload.version !== 1
        || candidate.payload.scope.projectId !== scope.projectId
        || candidate.payload.scope.branch !== scope.branch
        || candidate.payload.scope.role !== scope.role
        || candidate.payload.scope.stage !== scope.stage
        || candidate.payload.scope.schemaVersion !== scope.schemaVersion
      ) {
        continue;
      }

      const reusable = new Map<SemanticComponentSource, SemanticComponentSnapshot>();
      const considered = Object.keys(candidate.payload.components) as SemanticComponentSource[];
      const refreshed: string[] = [];
      const stale: string[] = [];
      const staleReasons: Record<string, string[]> = {};

      for (const source of considered) {
        const component = candidate.payload.components[source];
        const expectedRevision = expectations[source];
        const rejectionReasons = this.semanticComponentRejectionReasons(component, source, expectedRevision);
        if (rejectionReasons.length === 0 && component) {
          reusable.set(source, component);
        } else {
          refreshed.push(source);
          stale.push(source);
          staleReasons[source] = rejectionReasons;
        }
      }

      const reusableNames = [...reusable.keys()];
      const tokensAvoided = reusableNames.reduce(
        (total, source) => total + (reusable.get(source)?.tokenCost ?? 0),
        0,
      );
      const observedOnly = cache.config.mode === "observe";
      const actualReused = observedOnly ? [] : reusableNames;
      const accepted = reusableNames.length > 0;
      const metadata: SemanticCacheMetadata = {
        ...baseMetadata,
        status: accepted ? (observedOnly ? "candidate-observed" : "candidate-reused") : "candidate-rejected",
        candidate_id: candidate.candidateId,
        source_pack_key: candidate.payload.sourcePackKey,
        similarity: candidate.similarity,
        components_considered: considered.length,
        components_reusable: reusableNames,
        would_reuse_components: observedOnly ? reusableNames : [],
        components_reused: actualReused,
        components_refreshed: observedOnly ? considered : refreshed,
        stale_components: stale,
        stale_component_reasons: staleReasons,
        relevant_paths: [...candidate.payload.relevantPaths],
        tokens_avoided_estimate: observedOnly ? 0 : tokensAvoided,
        retrieval_calls_avoided: observedOnly ? 0 : actualReused.length,
      };

      if (!accepted) {
        // Aggregate one rejected outcome per lookup, after every top-k candidate
        // has been checked. Counting here and again after the loop would inflate
        // false_semantic_hit_rate for a single semantic lookup.
        rejectedMetadata = metadata;
        continue;
      }

      cache.recordOutcome({
        candidateHit: true,
        candidateAccepted: true,
        componentsConsidered: considered.length,
        componentsReusable: reusableNames.length,
        componentsReused: actualReused.length,
        componentsRefreshed: metadata.components_refreshed.length,
        componentsStale: stale.length,
        tokensAvoidedEstimate: metadata.tokens_avoided_estimate,
        retrievalCallsAvoided: metadata.retrieval_calls_avoided,
      });
      const result: SemanticReuseState = {
        metadata,
        ...(lookup.queryEmbedding ? { queryEmbedding: lookup.queryEmbedding } : {}),
      };
      if (!observedOnly) {
        const memoryDecisions = reusable.get("memory-decisions");
        const symbols = reusable.get("cbm-symbols");
        if (memoryDecisions) result.memoryDecisions = memoryDecisions;
        if (symbols) result.symbols = symbols;
      }
      return result;
    }

    cache.recordOutcome({
      candidateHit: true,
      candidateAccepted: false,
      componentsConsidered: rejectedMetadata.components_considered,
      componentsReusable: 0,
      componentsReused: 0,
      componentsRefreshed: rejectedMetadata.components_refreshed.length,
      componentsStale: rejectedMetadata.stale_components.length,
      tokensAvoidedEstimate: 0,
      retrievalCallsAvoided: 0,
    });
    return {
      metadata: rejectedMetadata,
      ...(lookup.queryEmbedding ? { queryEmbedding: lookup.queryEmbedding } : {}),
    };
  }

  private semanticComponentRejectionReasons(
    component: SemanticComponentSnapshot | undefined,
    source: SemanticComponentSource,
    expectedRevision: string,
  ): string[] {
    if (!component) return ["component-missing"];
    if (component.source !== source) return ["component-source-mismatch"];
    if (!this.revisionIsAuthoritative(expectedRevision)) return ["source-revision-unavailable"];
    if (component.sourceRevision !== expectedRevision) return ["source-revision-mismatch"];

    // PostgreSQL Project Memory is the authoritative source for decisions and
    // advances a transactional revision ledger on supported writes. The
    // Decision.files field is provenance/relevance metadata, not an input from
    // which the decision snapshot is computed. Requiring those historical paths
    // to still exist made valid memory snapshots permanently stale after a file
    // was renamed/deleted, despite an unchanged authoritative memory revision.
    if (source === "memory-decisions") return [];

    const reasons: string[] = [];
    if (!this.semanticComponentDependencyCoverageComplete(component, source)) {
      reasons.push("dependency-coverage-incomplete");
    }
    if (!this.fileDependenciesFresh(component.fileDependencies)) {
      reasons.push("dependency-hash-mismatch");
    }
    return reasons;
  }

  private semanticComponentDependencyCoverageComplete(
    component: SemanticComponentSnapshot,
    source: SemanticComponentSource,
  ): boolean {
    if (source !== "cbm-symbols") return true;
    const expectedPaths = new Set<string>();
    if (Array.isArray(component.value)) {
      for (const item of component.value) {
        if (!item || typeof item !== "object") continue;
        if ("file" in item && typeof item.file === "string") {
          const normalized = this.repositoryRelativePath(item.file);
          if (!normalized) return false;
          expectedPaths.add(normalized);
        }
      }
    }
    if (expectedPaths.size === 0) return true;
    const captured = new Set(
      component.fileDependencies
        .map((dependency) => this.repositoryRelativePath(dependency.path))
        .filter((path): path is string => Boolean(path)),
    );
    return [...expectedPaths].every((path) => captured.has(path));
  }

  private revisionIsAuthoritative(revision: string): boolean {
    return !/(?:unavailable|unversioned)$/i.test(revision);
  }

  private async storeSemanticCandidate(
    task: string,
    rawPackKey: string,
    sourceRevisions: SourceRevisions,
    rawPack: ContextPack,
    semanticState: SemanticReuseState,
  ): Promise<void> {
    const cache = this.semanticCache;
    if (!cache || cache.config.mode === "off" || !this.rawPackIsCacheable(rawPack)) return;
    const scope = semanticState.metadata.scope ?? this.semanticScope({});
    const symbolDependencies = this.captureFileDependencies(
      rawPack.symbols.flatMap((item) => {
        if (item && typeof item === "object" && "file" in item && typeof item.file === "string") {
          return [item.file];
        }
        return [];
      }),
    );
    const write = await cache.put({
      task: toSemanticTaskDescriptor(task, rawPack.task_analysis),
      ...(semanticState.queryEmbedding ? { embedding: semanticState.queryEmbedding } : {}),
      scope,
      sourceRevisions: toSemanticSourceRevisions(sourceRevisions),
      sourcePackKey: rawPackKey,
      components: {
        "memory-decisions": {
          source: "memory-decisions",
          sourceRevision: sourceRevisions.memory,
          value: structuredClone(rawPack.previous_decisions),
          tokenCost: estimateTokens(rawPack.previous_decisions),
          fileDependencies: [],
        },
        "cbm-symbols": {
          source: "cbm-symbols",
          sourceRevision: sourceRevisions.cbm,
          value: structuredClone(rawPack.symbols),
          tokenCost: estimateTokens(rawPack.symbols),
          fileDependencies: symbolDependencies,
        },
      },
      relevantPaths: semanticRelevantPaths(rawPack),
    });
    semanticState.metadata.store_status = write.status === "stored"
      ? "stored"
      : write.status === "failed" ? "failed" : "disabled";
    semanticState.metadata.store_ms = write.writeMs;
    if (write.candidateId) semanticState.metadata.store_candidate_id = write.candidateId;
    if (write.warning) semanticState.metadata.warning = [semanticState.metadata.warning, write.warning]
      .filter(Boolean)
      .join(";");
    if (write.status === "failed" && !rawPack.metadata.warnings.includes("semantic_cache_store_failed")) {
      rawPack.metadata.warnings.push("semantic_cache_store_failed");
    }
    rawPack.metadata.semantic_cache = structuredClone(semanticState.metadata);
  }

  private async getCached<T>(key: string): Promise<{ value: T; tier: CacheTier } | undefined> {
    if (!this.cache) return undefined;
    try {
      const hit = await this.cache.get<CachedValue<T>>(key);
      if (!hit) return undefined;
      if (!this.fileDependenciesFresh(hit.value.file_dependencies)) {
        await this.cache.delete(key);
        return undefined;
      }
      return { value: structuredClone(hit.value.value), tier: hit.tier };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "context_semantic_dependency_unavailable") throw error;
      return undefined;
    }
  }

  private async setCached<T>(key: string, value: T, fileDependencies: FileDependency[], ttlMs = this.componentTtlMs): Promise<void> {
    if (!this.cache) return;
    try {
      for (const dependency of fileDependencies) {
        await this.cache.recordFileHash(dependency.path, dependency.hash);
      }
      const deps = fileDependencies.map((dependency) => dependency.hash);
      await this.cache.set(
        key,
        { value: structuredClone(value), file_dependencies: fileDependencies } satisfies CachedValue<T>,
        deps,
        ttlMs,
      );
    } catch {
      // Cache is reconstructible and must never block the caller.
    }
  }

  private rawPackIsCacheable(pack: ContextPack): boolean {
    const transientWarnings = new Set([
      "memory_unavailable",
      "cbm_unavailable",
      "architecture_unavailable",
      "context7_unavailable",
      "static_artifacts_unavailable",
    ]);
    return !pack.metadata.warnings.some((warning) => transientWarnings.has(warning));
  }

  private capturePackDependencies(pack: ContextPack): FileDependency[] {
    const symbolFiles = pack.symbols.flatMap((item) => {
      if (item && typeof item === "object" && "file" in item && typeof item.file === "string") return [item.file];
      return [];
    });
    const artifactFiles = pack.static_artifacts.map((artifact) => artifact.path);
    return this.captureFileDependencies([...symbolFiles, ...artifactFiles]);
  }

  private repositoryRelativePath(filePath: string): string | undefined {
    const normalized = filePath.replaceAll("\\", "/").replace(/^\.\/+/, "").trim();
    if (!normalized || normalized.includes("\0")) return undefined;
    const root = resolve(this.cwd);
    const absolute = resolve(root, normalized);
    if (absolute === root || !absolute.startsWith(`${root}${sep}`)) return undefined;
    return normalized;
  }

  private captureFileDependencies(filePaths: string[]): FileDependency[] {
    const dependencies = new Map<string, FileDependency>();
    for (const filePath of filePaths) {
      const relative = this.repositoryRelativePath(filePath);
      if (!relative) continue;
      const absolute = resolve(this.cwd, relative);
      if (!existsSync(absolute)) continue;
      try {
        const hash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
        dependencies.set(relative, { path: relative, hash });
      } catch {
        // A file can disappear between discovery and hashing; omit it so semantic reuse fails coverage.
      }
    }
    return [...dependencies.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private fileDependenciesFresh(dependencies: FileDependency[]): boolean {
    for (const dependency of dependencies) {
      const relative = this.repositoryRelativePath(dependency.path);
      if (!relative) return false;
      const absolute = resolve(this.cwd, relative);
      if (!existsSync(absolute)) return false;
      try {
        const current = createHash("sha256").update(readFileSync(absolute)).digest("hex");
        if (current !== dependency.hash) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private symbolSearchTerm(taskAnalysis: TaskAnalysis): string {
    const external = taskAnalysis.signature.external_libraries[0];
    if (external) return external;
    const domain = taskAnalysis.signature.domains[0];
    if (domain) return domain.split("-")[0] ?? domain;
    return taskAnalysis.concepts.find((concept) => !concept.includes(".")) ?? ".*";
  }

  private escapeRegex(value: string): string {
    if (value === ".*") return value;
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private recordComponentHit(state: BuildCacheState, source: string): void {
    state.hits++;
    if (!state.hitSources.includes(source)) state.hitSources.push(source);
  }

  private recordComponentMiss(state: BuildCacheState, source: string): void {
    state.misses++;
    if (!state.missSources.includes(source)) state.missSources.push(source);
  }

  private toComponentCacheMetadata(state: BuildCacheState): ComponentCacheMetadata {
    return {
      hits: state.hits,
      misses: state.misses,
      hit_sources: [...state.hitSources],
      miss_sources: [...state.missSources],
    };
  }
}
