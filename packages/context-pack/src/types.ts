import type { CacheTier } from "@agent-harness/context-cache";

export interface TaskSignature {
  version: 1;
  intent: string;
  domains: string[];
  files: string[];
  symbols: string[];
  external_libraries: string[];
  language: string;
  canonical_query: string;
  fingerprint: string;
  component_scope: string;
}

export interface TaskAnalysis {
  concepts: string[];
  external_api_needed: boolean;
  detected_language: string;
  signature: TaskSignature;
}

export interface ContextPackItem {
  source: string;
  relevance_score: number;
  freshness: number;
  token_cost: number;
  content: unknown;
}

export interface FileDependency {
  path: string;
  hash: string;
}

export type StaticArtifactKind =
  | "adr"
  | "prd"
  | "evaluation"
  | "icr"
  | "task-brief"
  | "tech-brief"
  | "design";

export interface StaticArtifact {
  path: string;
  kind: StaticArtifactKind;
  title: string;
  content_hash: string;
  token_cost: number;
  relevance_score: number;
  content: string;
}

export interface StaticArtifactSearchResult {
  artifacts: StaticArtifact[];
  catalog_revision: string;
  discovered_count: number;
  cache_hits: number;
  cache_misses: number;
}

export interface ComponentCacheMetadata {
  hits: number;
  misses: number;
  hit_sources: string[];
  miss_sources: string[];
}

export interface SemanticCacheMetadata {
  enabled: boolean;
  mode: "off" | "observe" | "enforce";
  status:
    | "disabled"
    | "exact-hit-skipped"
    | "unavailable"
    | "miss"
    | "candidate-rejected"
    | "candidate-observed"
    | "candidate-reused";
  scope?: {
    projectId: string;
    branch: string;
    role: string;
    stage: string;
    schemaVersion: string;
  };
  provider?: string;
  model?: string;
  model_revision?: string;
  candidate_hit: boolean;
  candidate_id?: string;
  source_pack_key?: string;
  similarity?: number;
  candidates_considered: number;
  components_considered: number;
  components_reusable: string[];
  would_reuse_components: string[];
  components_reused: string[];
  components_refreshed: string[];
  stale_components: string[];
  stale_component_reasons?: Record<string, string[]>;
  relevant_paths: string[];
  tokens_avoided_estimate: number;
  retrieval_calls_avoided: number;
  lookup_ms: number;
  embedding_ms: number;
  store_status: "not-attempted" | "disabled" | "stored" | "failed";
  store_candidate_id?: string;
  store_ms: number;
  warning?: string;
}

export interface ContextPack {
  task_analysis: TaskAnalysis;
  previous_decisions: unknown[];
  symbols: unknown[];
  architecture: string;
  static_artifacts: StaticArtifact[];
  summaries: unknown[];
  dependencies: {
    callers: unknown[];
    callees: unknown[];
    tests: unknown[];
  };
  external_docs: unknown[];
  metadata: {
    total_tokens: number;
    budget: number;
    sources_queried: string[];
    cache_hit: boolean;
    cache_tier?: CacheTier;
    raw_pack_cache_key?: string;
    component_cache?: ComponentCacheMetadata;
    semantic_cache?: SemanticCacheMetadata;
    source_revisions?: Record<string, string>;
    generated_at: string;
    served_at?: string;
    warnings: string[];
  };
}

export interface ContextReference {
  ref: string;
  source: string;
  token_cost: number;
  item_count?: number;
  preview?: string;
}

export interface StoredContextReference {
  ref: string;
  source: string;
  content: unknown;
  created_at: string;
  file_dependencies?: FileDependency[];
}

export interface CompactContextPack {
  pack_id: string;
  task_analysis: TaskAnalysis;
  focus: {
    decisions: unknown[];
    symbols: unknown[];
    static_artifacts: Array<{
      ref: string;
      path: string;
      kind: StaticArtifactKind;
      title: string;
      content_hash: string;
      token_cost: number;
      relevance_score: number;
    }>;
    architecture_preview?: string;
    external_docs: unknown[];
  };
  references: ContextReference[];
  metadata: ContextPack["metadata"] & {
    delivery_mode: "compact";
    full_tokens: number;
    delivered_tokens: number;
    delivery_tokens_saved: number;
    delivery_savings_percent: number;
  };
}
