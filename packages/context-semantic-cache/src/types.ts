export type SemanticCacheMode = "off" | "observe" | "enforce";
export type SemanticCacheFailureMode = "open" | "closed";
export type SemanticComponentSource = "memory-decisions" | "cbm-symbols";

export interface SemanticCacheConfig {
  mode: SemanticCacheMode;
  failureMode: SemanticCacheFailureMode;
  minSimilarity: number;
  topK: number;
  ttlMs: number;
  failureCooldownMs: number;
  projectId: string;
  branch: string;
  schemaVersion: string;
  cwd: string;
}

export interface SemanticCacheScope {
  projectId: string;
  branch: string;
  role: string;
  stage: string;
  schemaVersion: string;
}

export interface SemanticTaskDescriptor {
  text: string;
  fingerprint: string;
  intent: string;
  canonicalQuery: string;
  domains: string[];
  files: string[];
  symbols: string[];
  language: string;
}

export interface SemanticSourceRevisions {
  memory: string;
  cbm: string;
  artifacts: string;
}

export interface SemanticFileDependency {
  path: string;
  hash: string;
}

export interface SemanticComponentSnapshot {
  source: SemanticComponentSource;
  sourceRevision: string;
  value: unknown;
  tokenCost: number;
  fileDependencies: SemanticFileDependency[];
}

export interface SemanticCandidatePayload {
  version: 1;
  candidateId: string;
  createdAt: string;
  sourcePackKey: string;
  task: SemanticTaskDescriptor;
  scope: SemanticCacheScope;
  sourceRevisions: SemanticSourceRevisions;
  components: Partial<Record<SemanticComponentSource, SemanticComponentSnapshot>>;
  relevantPaths: string[];
}

export interface SemanticCandidateRecord {
  candidateId: string;
  payload: SemanticCandidatePayload;
  distance: number;
  similarity: number;
}

export interface SemanticCandidateQuery {
  scope: SemanticCacheScope;
  embeddingModel: string;
  embedding: number[];
  topK: number;
}

export interface SemanticCandidateWrite {
  payload: SemanticCandidatePayload;
  embeddingModel: string;
  embedding: number[];
  ttlMs: number;
}

export interface SemanticCandidateStoreHealth {
  status: "up" | "down";
  latencyMs?: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface EmbeddingProviderHealth {
  status: "up" | "down";
  latencyMs?: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface SemanticCandidateStore {
  query(input: SemanticCandidateQuery): Promise<SemanticCandidateRecord[]>;
  put(input: SemanticCandidateWrite): Promise<void>;
  health(): Promise<SemanticCandidateStoreHealth>;
  close(): Promise<void>;
}

export interface SemanticEmbeddingProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly revision: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  health(): Promise<EmbeddingProviderHealth>;
}

export interface SemanticCacheLookupInput {
  task: SemanticTaskDescriptor;
  scope: SemanticCacheScope;
  sourceRevisions: SemanticSourceRevisions;
}

export interface SemanticCacheLookupResult {
  mode: SemanticCacheMode;
  status: "disabled" | "unavailable" | "miss" | "candidate-hit";
  candidateHit: boolean;
  candidates: SemanticCandidateRecord[];
  candidatesConsidered: number;
  lookupMs: number;
  embeddingMs: number;
  warnings: string[];
  queryEmbedding?: number[];
}

export interface SemanticCacheStoreInput {
  task: SemanticTaskDescriptor;
  embedding?: number[];
  scope: SemanticCacheScope;
  sourceRevisions: SemanticSourceRevisions;
  sourcePackKey: string;
  components: Partial<Record<SemanticComponentSource, SemanticComponentSnapshot>>;
  relevantPaths: string[];
}

export interface SemanticCacheWriteResult {
  status: "disabled" | "stored" | "failed";
  candidateId?: string;
  writeMs: number;
  embeddingMs: number;
  warning?: string;
}

export interface SemanticReuseOutcome {
  candidateHit: boolean;
  candidateAccepted: boolean;
  componentsConsidered: number;
  componentsReusable: number;
  componentsReused: number;
  componentsRefreshed: number;
  componentsStale: number;
  tokensAvoidedEstimate: number;
  retrievalCallsAvoided: number;
}

export interface SemanticCacheIncidentStats {
  dependency: "redis" | "embedding" | "unknown" | null;
  error_code: string | null;
  cause_code: string | null;
  message: string | null;
  unavailable_until: string | null;
}

export interface SemanticCacheStats {
  stats_contract_version: "semantic-cache-stats/v2";
  incident: SemanticCacheIncidentStats;
  enabled: boolean;
  mode: SemanticCacheMode;
  provider: string;
  model: string;
  revision: string;
  dimensions: number;
  lookups: number;
  candidate_hits: number;
  misses: number;
  store_attempts: number;
  stores: number;
  errors: number;
  cooldown_skips: number;
  last_unavailable_dependency: "redis" | "embedding" | "unknown" | null;
  last_error_code: string | null;
  last_cause_code: string | null;
  last_error_message: string | null;
  unavailable_until: string | null;
  embedding_calls: number;
  accepted_candidates: number;
  rejected_candidates: number;
  candidate_hit_rate: number;
  candidate_acceptance_rate: number;
  semantic_reuse_potential_rate: number;
  semantic_reuse_rate: number;
  false_semantic_hit_rate: number;
  components_considered: number;
  components_reusable: number;
  components_reused: number;
  components_refreshed: number;
  components_stale: number;
  retrieval_calls_avoided: number;
  tokens_avoided_estimate: number;
  total_lookup_latency_ms: number;
  average_lookup_latency_ms: number;
  total_embedding_latency_ms: number;
  average_embedding_latency_ms: number;
  total_write_latency_ms: number;
  average_write_latency_ms: number;
}

export interface SemanticCacheHealth {
  status: "disabled" | "up" | "down";
  mode: SemanticCacheMode;
  failureMode: SemanticCacheFailureMode;
  redis: SemanticCandidateStoreHealth;
  embedding: EmbeddingProviderHealth;
}
