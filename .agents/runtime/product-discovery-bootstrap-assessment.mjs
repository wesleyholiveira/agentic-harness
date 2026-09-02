import { validateAgainstSchema } from './schema-validator.mjs';
import { capabilityCatalogFromRegistry, normalizeBootstrapFactRequirements } from './bootstrap-capabilities.mjs';
import { normalizeProductDiscoveryReviewAssessment } from './bootstrap-topology-refiner.mjs';
import { runOpenCodeStructuredOutput } from './opencode-structured-output.mjs';
import { auxiliaryInvocationFromStructuredResult } from './auxiliary-telemetry.mjs';

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function usageFromInfo(info) {
  const tokens = info?.tokens ?? info?.usage?.tokens ?? null;
  return {
    inputTokens: Number(tokens?.input ?? info?.usage?.inputTokens ?? 0),
    outputTokens: Number(tokens?.output ?? info?.usage?.outputTokens ?? 0),
    cachedInputTokens: Number(tokens?.cache?.read ?? info?.usage?.cachedInputTokens ?? 0),
    costUsd: Number(info?.cost ?? info?.usage?.costUsd ?? 0),
  };
}

export function buildProductDiscoveryAssessmentProjectionSchema({ handoffSchema, registry }) {
  const source = handoffSchema?.properties?.bootstrapReviewAssessment;
  if (!source || typeof source !== 'object') throw new Error('product_discovery_bootstrap_assessment_schema_missing');
  const schema = clone(source);
  const catalog = capabilityCatalogFromRegistry(registry);
  const capabilityIds = catalog.capabilities.map((entry) => entry.capabilityId);
  schema.properties.requiredCapabilities.items = { enum: capabilityIds };
  const item = schema.properties.factRequirements?.items;
  if (!item?.properties) throw new Error('product_discovery_bootstrap_fact_requirement_schema_missing');
  item.properties.consumerCapabilityId = { enum: capabilityIds };
  item.properties.providerCapabilityId = { anyOf: [{ enum: capabilityIds }, { type: 'null' }] };
  item.properties.source = { enum: [...catalog.authoritativeSources] };
  return schema;
}

function assessmentStructurallyValid({ handoff, handoffSchema }) {
  const assessment = handoff?.bootstrapReviewAssessment;
  const schema = handoffSchema?.properties?.bootstrapReviewAssessment;
  if (!assessment || !schema) return false;
  return validateAgainstSchema(assessment, schema, 'bootstrapReviewAssessment').valid;
}

function assessmentSemanticallyValid({ handoff, registry }) {
  try {
    return Boolean(normalizeProductDiscoveryReviewAssessment(handoff, registry));
  } catch {
    return false;
  }
}

function normalizeRepositoryEvidencePath(value) {
  return String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/#.*$/, '');
}

function authorizedRepositoryEvidencePaths({ contextPacket = null } = {}) {
  const paths = new Set();
  for (const reference of contextPacket?.references ?? []) {
    if (reference?.included === false || !reference?.path) continue;
    const path = normalizeRepositoryEvidencePath(reference.path);
    if (path) paths.add(path);
  }
  return paths;
}

function canonicalizeAuthorizedRepositorySources(assessment, catalog, authorizedPaths) {
  const next = clone(assessment);
  let changed = false;
  for (const requirement of next.factRequirements ?? []) {
    if (requirement?.resolution !== 'authoritative-context') continue;
    const source = String(requirement.source ?? '').trim();
    if (catalog.authoritativeSources.has(source)) continue;
    const repositoryPath = normalizeRepositoryEvidencePath(source);
    if (!repositoryPath || !authorizedPaths.has(repositoryPath)) continue;
    requirement.source = 'repository-context';
    changed = true;
  }
  return { assessment: next, changed };
}

export function reconcileProductDiscoveryBootstrapAssessmentEnvelope(assessment, registry, { authorizedRepositoryPaths = new Set() } = {}) {
  if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) {
    throw new Error('product_discovery_bootstrap_review_assessment_invalid');
  }
  if (!Array.isArray(assessment.requiredCapabilities)) {
    throw new Error('product_discovery_bootstrap_required_capabilities_missing');
  }
  if (!Array.isArray(assessment.factRequirements)) {
    throw new Error('product_discovery_bootstrap_fact_requirements_missing');
  }
  const catalog = capabilityCatalogFromRegistry(registry);
  const sourceReconciled = canonicalizeAuthorizedRepositorySources(assessment, catalog, authorizedRepositoryPaths);
  const reconciledAssessment = sourceReconciled.assessment;
  const declared = new Set(reconciledAssessment.requiredCapabilities.map((value) => String(value ?? '').trim()).filter(Boolean));
  for (const capabilityId of declared) {
    if (!catalog.byId.has(capabilityId)) throw new Error(`product_discovery_bootstrap_capability_unknown:${capabilityId}`);
  }
  // Normalize only to validate fact semantics and discover the provider that the
  // canonical topology would resolve when a unique provider is omitted. The
  // authored factRequirements remain byte-for-byte otherwise; this repair only
  // reconciles the redundant requiredCapabilities envelope.
  const normalizedRequirements = normalizeBootstrapFactRequirements(reconciledAssessment.factRequirements, {
    catalog,
    provenance: 'product-discovery',
  });
  for (const requirement of normalizedRequirements) {
    declared.add(requirement.consumerCapabilityId);
    if (requirement.providerCapabilityId) declared.add(requirement.providerCapabilityId);
  }
  const requiredCapabilities = catalog.capabilities
    .map((entry) => entry.capabilityId)
    .filter((capabilityId) => declared.has(capabilityId));
  return {
    ...reconciledAssessment,
    requiredCapabilities,
  };
}

function reconcileExistingAssessment({ handoff, handoffSchema, registry, authorizedRepositoryPaths }) {
  if (!handoff?.bootstrapReviewAssessment) return null;
  try {
    const assessment = reconcileProductDiscoveryBootstrapAssessmentEnvelope(handoff.bootstrapReviewAssessment, registry, { authorizedRepositoryPaths });
    const next = clone(handoff);
    next.bootstrapReviewAssessment = assessment;
    if (handoffSchema && !assessmentStructurallyValid({ handoff: next, handoffSchema })) return null;
    normalizeProductDiscoveryReviewAssessment(next, registry);
    return next;
  } catch {
    return null;
  }
}

export function requiresProductDiscoveryBootstrapAssessmentProjection({ brief, handoff, handoffSchema = null, registry }) {
  if (brief?.sdd?.stage !== 'product-discovery' || handoff?.status !== 'complete') return false;
  if (!handoff?.bootstrapReviewAssessment) return true;
  if (handoffSchema && !assessmentStructurallyValid({ handoff, handoffSchema })) return true;
  return !assessmentSemanticallyValid({ handoff, registry });
}

function compactContextEvidence(contextPacket) {
  return {
    references: (contextPacket?.references ?? [])
      .filter((item) => item?.included !== false)
      .slice(0, 32)
      .map((item) => ({ path: item.path ?? null, title: item.title ?? null, kind: item.kind ?? null })),
    upstreamArtifacts: (contextPacket?.upstreamArtifacts ?? []).slice(0, 16).map((item) => ({
      producer: item.producer ?? null,
      kind: item.kind ?? null,
      changedPaths: item.content?.changedPaths ?? [],
      reusedPaths: item.content?.reusedPaths ?? [],
    })),
  };
}

export function buildProductDiscoveryAssessmentProjectionPrompt({ brief, contextPacket, handoff, registry }) {
  const catalog = capabilityCatalogFromRegistry(registry);
  const payload = {
    objective: brief?.objective ?? null,
    blockingCriteria: (brief?.acceptanceCriteria ?? []).filter((criterion) => criterion?.blocking !== false),
    expectedEvidence: brief?.expectedEvidence ?? [],
    reviewCapabilities: catalog.capabilities.map((entry) => ({
      capabilityId: entry.capabilityId,
      stage: entry.stage,
      agentId: entry.agentId,
      providesFacts: entry.providesFacts,
    })),
    authoritativeFactSources: [...catalog.authoritativeSources],
    sourceHandoff: handoff,
    contextEvidence: compactContextEvidence(contextPacket),
  };
  return `Project ONLY the missing or invalid Product Discovery bootstrapReviewAssessment for an already-produced Agentic Harness Handoff Result v2.

This is a bounded same-attempt semantic projection. Do not call tools, edit files, rewrite the PRD, rewrite acceptanceCriteria, change status, change sddReview, or invent repository evidence. Return ONLY the bootstrapReviewAssessment object requested by the supplied JSON schema.

Rules:
- contractVersion is bootstrap-review-assessment/v1.
- requiredCapabilities contains only review capabilities genuinely needed by this scoped increment.
- Every consumerCapabilityId and every review providerCapabilityId named by factRequirements MUST also appear in requiredCapabilities. The Runtime will deterministically reconcile this redundant envelope, but the projection should emit it correctly on the first pass.
- factRequirements must be explicit, including [] when safe fan-out is proven.
- An authoritative-context fact source MUST be exactly one label from supplied authoritativeFactSources. Repository filenames/anchors belong in evidence, never in source. The Runtime may canonicalize a repository filename to repository-context only when that exact file is already an authorized Context Packet reference.
- An authoritative-context fact may use only the supplied authoritativeFactSources and must cite concrete evidence already present in sourceHandoff/contextEvidence.
- A review-provided fact must identify exactly one providerCapabilityId that advertises that fact.
- Never create an edge merely because two reviews are both selected.
- If evidence is insufficient to classify a required fact without invention, the projection must fail rather than fabricate authority.

INPUT:
${JSON.stringify(payload, null, 2)}`;
}

export async function projectMissingProductDiscoveryBootstrapAssessment({
  workspace,
  model,
  brief,
  contextPacket,
  handoff,
  handoffSchema,
  registry,
  structuredRunner = runOpenCodeStructuredOutput,
}) {
  if (!requiresProductDiscoveryBootstrapAssessmentProjection({ brief, handoff, handoffSchema, registry })) {
    return { handoff, attempted: false, model: null, sessionId: null };
  }
  const authorizedRepositoryPaths = authorizedRepositoryEvidencePaths({ contextPacket });
  const reconciledExisting = reconcileExistingAssessment({ handoff, handoffSchema, registry, authorizedRepositoryPaths });
  if (reconciledExisting) {
    const changed = JSON.stringify(reconciledExisting.bootstrapReviewAssessment) !== JSON.stringify(handoff.bootstrapReviewAssessment);
    if (changed) {
      reconciledExisting.findings = [
        ...(Array.isArray(reconciledExisting.findings) ? reconciledExisting.findings : []),
        {
          type: 'product_discovery_bootstrap_assessment_reconciliation',
          status: 'succeeded',
          authority: 'deterministic-required-capability-envelope',
        },
      ];
    }
    return { handoff: reconciledExisting, attempted: false, deterministicRepaired: changed, model: null, sessionId: null };
  }
  const schema = buildProductDiscoveryAssessmentProjectionSchema({ handoffSchema, registry });
  const result = await structuredRunner({
    workspace,
    model,
    agentId: brief.agentId,
    schema,
    prompt: buildProductDiscoveryAssessmentProjectionPrompt({ brief, contextPacket, handoff, registry }),
    title: `${brief.taskId} bootstrap assessment projection`,
  });
  const projected = reconcileProductDiscoveryBootstrapAssessmentEnvelope(clone(result.value), registry, { authorizedRepositoryPaths });
  const structural = validateAgainstSchema(projected, schema, 'bootstrapReviewAssessmentProjection');
  if (!structural.valid) throw new Error(`product_discovery_bootstrap_assessment_projection_invalid:${structural.errors.join('; ')}`);
  const next = clone(handoff);
  next.bootstrapReviewAssessment = projected;
  // Semantic normalization is the same authority consumed by topology refinement.
  normalizeProductDiscoveryReviewAssessment(next, registry);

  const usage = usageFromInfo(result.info);
  next.findings = [
    ...(Array.isArray(next.findings) ? next.findings : []),
    {
      type: 'product_discovery_bootstrap_assessment_projection',
      status: 'succeeded',
      authority: 'bounded-product-discovery-assessment-projection',
      modelId: model,
      sessionId: result.sessionId ?? null,
      attempts: Number(result.attempts ?? 1),
    },
  ];
  next.auxiliaryInvocations = [
    ...(next.auxiliaryInvocations ?? []),
    auxiliaryInvocationFromStructuredResult({ purpose: 'product-discovery-bootstrap-assessment', model, result }),
  ];
  next.metrics = {
    ...(next.metrics ?? {}),
    inputTokens: Number(next.metrics?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: Number(next.metrics?.outputTokens ?? 0) + usage.outputTokens,
    cachedInputTokens: Number(next.metrics?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
    costUsd: Number(next.metrics?.costUsd ?? 0) + usage.costUsd,
  };
  return { handoff: next, attempted: true, model, sessionId: result.sessionId ?? null, usage };
}
