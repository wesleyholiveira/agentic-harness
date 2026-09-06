import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { assertSchema } from "./schema-validator.mjs";
import { estimateTokens, nowIso, readJson, sha256, writeJson } from "./utils.mjs";
import { stableFingerprint } from "./event-driven-contracts.mjs";

export const AGENT_INPUT_MANIFEST_VERSION = "agent-input-manifest/v1";
export const AGENT_INPUT_CATEGORIES = Object.freeze([
  "task_contract", "schemas", "execution_contract", "retrieved_context",
  "upstream_evidence", "governance", "references", "tool_output",
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function contentIdentity(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  return `sha256:${sha256(buffer)}`;
}

export function tokenEstimateFromBytes(bytes) {
  return Math.max(0, Math.ceil(Number(bytes ?? 0) / 4));
}

function normalizedPath(repositoryRoot, path) {
  if (!path) return null;
  const rel = relative(repositoryRoot, path).replaceAll("\\", "/");
  return rel && !rel.startsWith("../") ? rel : String(path).replaceAll("\\", "/");
}

export async function manifestEntryFromFile({ repositoryRoot, category, authorityClass, deliveryMode = "attachment", path, sourceRef = null, attach = deliveryMode === "attachment", rawTokens = null, projectionOf = null, artifactRef = null, lazyPolicy = null, mediaType = null }) {
  const bytesValue = await readFile(path);
  const bytes = bytesValue.byteLength;
  return {
    entryId: `${category}:${contentIdentity(bytesValue).slice(7, 23)}`,
    category,
    authorityClass,
    deliveryMode,
    contentHash: contentIdentity(bytesValue),
    bytes,
    estimatedTokens: tokenEstimateFromBytes(bytes),
    ...(rawTokens === null || rawTokens === undefined ? {} : { rawTokens: Math.max(0, Math.ceil(Number(rawTokens))) }),
    sourceRef: sourceRef ?? normalizedPath(repositoryRoot, path),
    path: normalizedPath(repositoryRoot, path),
    attach: Boolean(attach),
    mediaType: mediaType ?? (extname(path).toLowerCase() === ".json" ? "application/json" : "text/plain"),
    projectionOf,
    artifactRef,
    lazyPolicy,
  };
}

export async function writeContentAddressedArtifact({ repositoryRoot, taskDirectory, value, sourceRef, mediaType = "application/json", maxBytes = 1_000_000 }) {
  const serialized = mediaType === "application/json" ? canonicalJson(value) : String(value);
  const buffer = Buffer.from(serialized, "utf8");
  const contentHash = contentIdentity(buffer);
  const suffix = mediaType === "application/json" ? ".json" : ".txt";
  const directory = join(taskDirectory, "agent-input-artifacts");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${contentHash.slice(7)}${suffix}`);
  await writeFile(path, buffer);
  return {
    artifactRef: `artifact:${contentHash}`,
    contentHash,
    path,
    sourceRef,
    bytes: buffer.byteLength,
    estimatedTokens: tokenEstimateFromBytes(buffer.byteLength),
    mediaType,
    lazyPolicy: { maxBytes, allowedMediaTypes: [mediaType] },
    repositoryPath: normalizedPath(repositoryRoot, path),
  };
}

function compactValidation(validation) {
  return (validation ?? []).filter((entry) => entry?.result === "failed" || entry?.blocking === true && entry?.result !== "passed")
    .map((entry) => ({ command: entry.command ?? null, result: entry.result ?? null, evidence: entry.evidence ?? null }));
}

export function projectHandoffEvidence({ artifact, content, fullArtifact }) {
  const review = content?.sddReview ?? null;
  return {
    artifactId: artifact?.artifactId ?? content?.artifactId ?? null,
    artifactVersion: artifact?.version ?? content?.artifactVersion ?? null,
    producerTaskId: artifact?.producer ?? content?.taskId ?? null,
    agentId: content?.agentId ?? null,
    status: content?.status ?? null,
    decision: review?.decision ?? null,
    reviewedRevision: review?.reviewedRevision ?? null,
    requiredDeltas: review?.requiredDeltas ?? [],
    sddReview: review ? {
      role: review.role ?? null, stage: review.stage ?? null, decision: review.decision ?? null,
      reviewedRevision: review.reviewedRevision ?? null, requiredDeltas: review.requiredDeltas ?? [], nextRole: review.nextRole ?? null,
    } : null,
    implementationPlan: content?.implementationPlan ? { revision: content.implementationPlan.revision ?? null } : null,
    bootstrapReviewAssessment: content?.bootstrapReviewAssessment ?? null,
    acceptanceCriteria: content?.acceptanceCriteria ?? [],
    criterionResults: (content?.criterionResults ?? []).map((item) => ({ id: item.id, result: item.result, evidence: item.evidence ?? null })),
    changedPaths: content?.changedPaths ?? [],
    reusedPaths: content?.reusedPaths ?? [],
    contractChanges: content?.contractChanges ?? [],
    failedValidations: compactValidation(content?.validation),
    residualRisks: content?.residualRisks ?? [],
    fullArtifactRef: fullArtifact?.artifactRef ?? null,
    fullArtifactHash: fullArtifact?.contentHash ?? null,
  };
}

export function projectOwnershipRegistry(registry) {
  const sourceAgents = [...(registry?.agents ?? registry?.document?.agents ?? [])]
    .filter((agent) => agent.executionRole === "implementation");
  const owners = sourceAgents.map((agent) => {
    const matchingRules = [
      ...(agent.primaryPaths ?? []).map((pattern) => ({ pattern, ownershipClass: "primary", provenance: `registry:${agent.id}:primaryPaths` })),
      ...(agent.sharedPaths ?? []).map((pattern) => ({ pattern, ownershipClass: "shared", provenance: `registry:${agent.id}:sharedPaths` })),
      ...(agent.collaborativePaths ?? []).map((pattern) => ({ pattern, ownershipClass: "collaborative", provenance: `registry:${agent.id}:collaborativePaths` })),
    ].sort((left, right) => `${left.ownershipClass}:${left.pattern}`.localeCompare(`${right.ownershipClass}:${right.pattern}`));
    return {
      agentId: agent.id,
      executionRole: agent.executionRole,
      ownershipMode: agent.ownershipMode ?? "explicit-patterns",
      matchingRules,
    };
  }).sort((a, b) => a.agentId.localeCompare(b.agentId));
  return {
    contractVersion: "agent-ownership-projection/v1",
    authority: "planning-view-only",
    compilerAuthority: ".agents/agents/*/agent.json",
    owners,
  };
}

export function buildRuntimeInputAccounting(entries) {
  const categories = {};
  for (const category of AGENT_INPUT_CATEGORIES) categories[category] = { rawTokens: 0, deliveredTokens: 0, savedTokens: 0, wireTokens: 0, duplicateTokens: 0, projectedTokens: 0, lazyAvailableTokens: 0, lazyDeliveryTokens: 0, entries: 0 };
  const delivered = entries.filter((entry) => entry.deliveryMode !== "lazy");
  const rawByHash = new Map();
  const deliveredByHash = new Map();
  for (const entry of entries) {
    const raw = Math.max(entry.estimatedTokens, Number(entry.rawTokens ?? entry.estimatedTokens));
    const deliveredTokens = entry.deliveryMode === "lazy" ? 0 : entry.estimatedTokens;
    const category = categories[entry.category];
    category.rawTokens += raw;
    category.deliveredTokens += deliveredTokens;
    category.savedTokens += Math.max(0, raw - deliveredTokens);
    category.wireTokens += deliveredTokens;
    category.projectedTokens += entry.authorityClass === "deterministic-projection" ? deliveredTokens : 0;
    category.lazyAvailableTokens += entry.deliveryMode === "lazy" ? raw : 0;
    category.entries += 1;
    rawByHash.set(entry.contentHash, Math.max(rawByHash.get(entry.contentHash) ?? 0, raw));
    if (entry.deliveryMode !== "lazy") deliveredByHash.set(entry.contentHash, Math.max(deliveredByHash.get(entry.contentHash) ?? 0, deliveredTokens));
  }
  const occurrences = new Map();
  for (const entry of delivered) occurrences.set(entry.contentHash, (occurrences.get(entry.contentHash) ?? 0) + entry.estimatedTokens);
  for (const entry of delivered) {
    const total = occurrences.get(entry.contentHash) ?? entry.estimatedTokens;
    const unique = deliveredByHash.get(entry.contentHash) ?? entry.estimatedTokens;
    const duplicate = Math.max(0, total - unique);
    if (duplicate > 0) categories[entry.category].duplicateTokens += Math.min(entry.estimatedTokens, duplicate);
  }
  const runtimeOwnedRawTokens = [...rawByHash.values()].reduce((a, b) => a + b, 0);
  const runtimeOwnedDeliveredTokens = [...deliveredByHash.values()].reduce((a, b) => a + b, 0);
  const wireTokens = delivered.reduce((sum, entry) => sum + entry.estimatedTokens, 0);
  const uniqueContentTokens = runtimeOwnedDeliveredTokens;
  const duplicateTokens = Math.max(0, wireTokens - uniqueContentTokens);
  const runtimeOwnedTokensSaved = Math.max(0, runtimeOwnedRawTokens - runtimeOwnedDeliveredTokens);
  return {
    estimator: "bytes-div-4-ceil/v1",
    categories,
    global: {
      runtimeOwnedRawTokens,
      runtimeOwnedDeliveredTokens,
      runtimeOwnedTokensSaved,
      runtimeOwnedSavingsPercent: runtimeOwnedRawTokens > 0 ? runtimeOwnedTokensSaved / runtimeOwnedRawTokens * 100 : 0,
      wireTokens,
      uniqueContentTokens,
      duplicateTokens,
      duplicatePercent: wireTokens > 0 ? duplicateTokens / wireTokens * 100 : 0,
    },
  };
}

export function manifestFingerprint(manifest) {
  const clone = { ...manifest };
  delete clone.manifestFingerprint;
  delete clone.createdAt;
  return stableFingerprint(clone);
}

export async function writeAgentInputManifest({ repositoryRoot, taskDirectory, runId, taskId, agentId, attempt, entries, schema }) {
  const manifest = {
    contractVersion: AGENT_INPUT_MANIFEST_VERSION,
    schemaVersion: 1,
    runId,
    taskId,
    agentId,
    attempt: Number(attempt),
    createdAt: nowIso(),
    entries: [...entries].sort((a, b) => `${a.category}:${a.entryId}`.localeCompare(`${b.category}:${b.entryId}`)),
    accounting: buildRuntimeInputAccounting(entries),
    manifestFingerprint: "sha256:" + "0".repeat(64),
  };
  manifest.manifestFingerprint = manifestFingerprint(manifest);
  if (schema) assertSchema(manifest, schema, "agentInputManifest");
  const path = join(taskDirectory, `agent-input-manifest-attempt-${attempt}.json`);
  await writeJson(path, manifest);
  return { manifest, path };
}

export async function loadAndVerifyAgentInputManifest(path, schema = null) {
  const manifest = await readJson(path);
  if (schema) assertSchema(manifest, schema, "agentInputManifest");
  const expected = manifestFingerprint(manifest);
  if (expected !== manifest.manifestFingerprint) throw new Error(`agent_input_manifest_fingerprint_mismatch:${manifest.manifestFingerprint}:${expected}`);
  for (const entry of manifest.entries ?? []) {
    if (!entry.path || entry.deliveryMode === "lazy") continue;
    const absolute = entry.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entry.path) ? entry.path : join(repositoryRootFromManifestPath(path), entry.path);
    const bytes = await readFile(absolute);
    if (contentIdentity(bytes) !== entry.contentHash) throw new Error(`agent_input_manifest_entry_hash_mismatch:${entry.entryId}`);
  }
  return manifest;
}

function repositoryRootFromManifestPath(path) {
  const marker = `${join(".runtime", "agents", "runs")}`;
  const normalized = String(path).replaceAll("\\", "/");
  const index = normalized.indexOf("/.runtime/agents/runs/");
  return index >= 0 ? normalized.slice(0, index) : process.cwd();
}


export function manifestRepositoryRoot(manifestPath) {
  return repositoryRootFromManifestPath(manifestPath);
}

export function resolveManifestEntryPath(manifestPath, entry) {
  if (!entry?.path) return null;
  if (entry.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entry.path)) return entry.path;
  return join(repositoryRootFromManifestPath(manifestPath), entry.path);
}

export function manifestAttachmentPaths(manifest) {
  return (manifest.entries ?? []).filter((entry) => entry.attach && entry.deliveryMode === "attachment" && entry.path).map((entry) => entry.path);
}

export function findManifestArtifact(manifest, artifactRef) {
  return (manifest.entries ?? []).find((entry) => entry.artifactRef === artifactRef && entry.deliveryMode === "lazy") ?? null;
}
