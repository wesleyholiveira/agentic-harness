import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { assertSchema, validateAgainstSchema } from "./schema-validator.mjs";
import { exists } from "./utils.mjs";
import { loadAgentCatalog } from "./agent-catalog.mjs";
import { runOpenCodeStructuredOutput } from "./opencode-structured-output.mjs";
import { auxiliaryInvocationFromStructuredResult } from "./auxiliary-telemetry.mjs";
import { implementationProofCriteria } from "./acceptance-criteria.mjs";
import {
  implementationValidationDirectiveFromRequest,
  VALIDATION_COMMAND_PATTERN_SOURCE,
  invalidValidationCommands,
} from "./validation-command.mjs";
import { collectImplementationPlanValidationIssues } from "./dag-compiler.mjs";

const IMPLEMENTATION_EXECUTION_ROLES = new Set(["implementation", "platform"]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function normalizePath(value) { return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, ""); }

function implementerAgentIds(registry) {
  return (registry.agents ?? [])
    .filter((agent) => IMPLEMENTATION_EXECUTION_ROLES.has(agent.executionRole))
    .map((agent) => agent.id)
    .sort();
}

export function buildTechnicalPlanStructuredSchema({ implementationPlanSchema, requiredAcceptanceCriteria, registry }) {
  const schema = clone(implementationPlanSchema);
  schema.properties.acceptanceCriteria = {
    description: "Product acceptance criteria copied byte-for-byte from the Product Owner. Do not add, remove, rename, weaken, or rewrite them.",
    const: clone(requiredAcceptanceCriteria),
  };
  const ownerSchema = schema.properties?.workItems?.items?.properties?.ownerAgentId;
  if (ownerSchema) {
    ownerSchema.description = "One implementation-capable agent ID from the repository registry.";
    ownerSchema.enum = implementerAgentIds(registry);
  }
  const workItem = schema.properties?.workItems?.items;
  if (workItem?.properties) {
    workItem.properties.objective.description = "Bounded implementation objective. Do not use vague placeholders such as implement the slice.";
    workItem.properties.ownedPaths.description = "Exact repository-relative paths or owned patterns required by this work item.";
    const implementationIds = implementationProofCriteria(requiredAcceptanceCriteria).map((criterion) => criterion.id);
    workItem.properties.acceptanceCriteria.description = "Implementation-proof acceptance criterion IDs proven by this work item. Downstream QA/Product Acceptance criteria must not be assigned to implementation work.";
    if (workItem.properties.acceptanceCriteria?.items && implementationIds.length > 0) workItem.properties.acceptanceCriteria.items.enum = implementationIds;
    workItem.properties.validation.description = "Executable shell commands only. Never put prose, evidence descriptions, or runtime-owned diff-isolation statements here. Commands must prove this work item; compilation-only checks are insufficient when behavioral tests exist. Implementation validation must be runnable from the isolated task workspace; host/TUI qualification belongs downstream.";
    if (workItem.properties.validationExecutionScope) {
      workItem.properties.validationExecutionScope.description = "Use workspace for implementation. Do not place authoritative-host or live validation inside an implementation work item; decompose that proof into downstream readiness/live gates.";
      workItem.properties.validationExecutionScope.const = "workspace";
    }
    if (workItem.properties.validation?.items) workItem.properties.validation.items.pattern = VALIDATION_COMMAND_PATTERN_SOURCE;
    workItem.properties.dependencies.description = "IDs of other implementation work items that must integrate first. Use an empty array when independent.";
  }
  return schema;
}

function registrySummary(registry) {
  return (registry.agents ?? [])
    .filter((agent) => IMPLEMENTATION_EXECUTION_ROLES.has(agent.executionRole))
    .map((agent) => ({
      id: agent.id,
      role: agent.role,
      executionRole: agent.executionRole,
      primaryPaths: agent.primaryPaths ?? [],
      sharedPaths: agent.sharedPaths ?? [],
      collaborativePaths: agent.collaborativePaths ?? [],
    }));
}

async function planningEvidence({ workspace, handoff, maxBytes = 80_000 }) {
  const paths = [...new Set([...(handoff.changedPaths ?? []), ...(handoff.reusedPaths ?? [])].map(normalizePath))]
    .filter((path) => /^(docs\/(plans|specs|architecture)\/|\.agent\/)/.test(path));
  const evidence = [];
  let used = 0;
  for (const path of paths) {
    const absolute = resolve(workspace, path);
    const rel = relative(workspace, absolute);
    if (!rel || rel.startsWith("..") || (rel.includes(`..${sep}`))) continue;
    if (!(await exists(absolute))) continue;
    if (![".md", ".json", ".yaml", ".yml", ".txt"].includes(extname(path).toLowerCase())) continue;
    let content;
    try { content = await readFile(absolute, "utf8"); } catch { continue; }
    const remaining = maxBytes - used;
    if (remaining <= 0) break;
    const clipped = Buffer.byteLength(content) > remaining ? Buffer.from(content).subarray(0, remaining).toString("utf8") : content;
    used += Buffer.byteLength(clipped);
    evidence.push({ path, content: clipped, truncated: clipped.length < content.length });
  }
  return evidence;
}

export function buildTechnicalPlanSynthesisPrompt({ brief, handoff, registry, evidence, deterministicValidationIssues = [], repairPass = 1 }) {
  const implementationValidationDirective = implementationValidationDirectiveFromRequest(brief.objective);
  const input = {
    objective: brief.objective,
    processCriteria: brief.acceptanceCriteria,
    productAcceptanceCriteria: brief.upstreamAcceptanceCriteria ?? [],
    ownedPathsForTechnicalLead: brief.ownedPaths ?? [],
    readOnlyContextPaths: brief.readOnlyContextPaths ?? [],
    originalTechnicalLeadHandoff: {
      status: handoff.status,
      assumptions: handoff.assumptions ?? [],
      contractChanges: handoff.contractChanges ?? [],
      residualRisks: handoff.residualRisks ?? [],
      followUps: handoff.followUps ?? [],
      findings: handoff.findings ?? [],
      sddReview: handoff.sddReview ?? null,
      changedPaths: handoff.changedPaths ?? [],
      reusedPaths: handoff.reusedPaths ?? [],
      implementationPlan: handoff.implementationPlan ?? null,
    },
    implementationAgentOwnership: registrySummary(registry),
    deterministicValidationIssues: [...deterministicValidationIssues],
    implementationValidationDirective,
    repairPass,
    technicalArtifacts: evidence,
  };
  return `Synthesize the machine-readable Agentic Harness implementationPlan from the already-completed Technical Lead analysis below.

This is a STRUCTURING pass, not a new architecture/design pass. Do not edit the repository and do not return prose. The JSON schema supplied by the caller is authoritative.

Hard requirements:
- productAcceptanceCriteria are immutable and must appear exactly as supplied.
- workItems contain implementation work only; the runtime adds independent QA, operational-readiness and Product Acceptance tasks.
- every blocking product criterion whose proofStage resolves to implementation must be covered by at least one work item.
- product criteria with proofStage quality-assurance or product-acceptance are downstream runtime gates and MUST NOT be assigned to implementation workItems.
- every work item must name exactly one implementation-capable owner whose registry ownership covers every ownedPath. Treat implementationAgentOwnership as exact runtime authority: never infer a neighboring path, package path, test path, or similarly named file that is absent from that owner's primary/shared/collaborative patterns.
- primaryPaths are the domain-authority preference when more than one implementation-capable agent can touch the same path through shared/collaborative boundaries. Do not route a no-impact Runtime marker to an unrelated specialist merely because that specialist has a broad collaborative docs pattern.
- dependencies must refer only to work item IDs and must form an acyclic graph.
- validation must contain executable shell commands that prove the work item and assigned acceptance criteria. Never place prose/evidence descriptions in validation. The runtime executes each string via the shell. Runtime-owned diff-isolation evidence belongs in criteria/findings, not in workItems[*].validation.
- if an implementation product criterion uses an executable shell command in its verification field, every work item that claims that criterion must preserve that exact command in validation rather than replacing it with an ad-hoc equivalent.
- if implementationValidationDirective.mode=focused, its commands are byte-exact and EXCLUSIVE implementation validation authority: include every listed command and do not add substitute or extra work-item validation commands. Downstream QA/readiness may still add their own independent evidence.
- validation is WORK-ITEM scoped. Do not copy an agent's registry-level default validationCommands into a narrow work item. Repository-wide docs/typecheck/full-suite commands belong here only when the assigned criterion explicitly requires repository-wide health or the ownedPaths/contract change genuinely spans that surface.
- every implementation work item uses validationExecutionScope=workspace. Never place runtime:agent-authoritative:readiness, runtime:agent-harness:validate -- --mode authoritative, live-projector probes, opencode attach, or host-local continuation probes in implementation validation. Those are outer readiness/live gates, not implementation completion authority.
- executionMode defaults to agent. deterministic-reuse is a Runtime fast path only for pure verification/reuse of exact already-materialized files: contractChange=false, migration=false, wildcard-free ownedPaths, and every blocking implementation criterion must have an executable verification command included byte-for-byte in validation. Never use deterministic-reuse for authoring, code edits, migrations, contract changes, prose-only criteria, or uncertain reuse.
- for an isolated canary or similarly bounded artifact, prefer the exact targeted test/check commands from the Product Owner criteria; downstream QA and outer runbook gates own broader repository regression checks.
- work items must be bounded enough that an implementation agent can finish without inventing missing requirements.
- do not use contract/verification agents as implementation owners.
- deterministicValidationIssues is the complete fail-closed compiler preflight from the previous plan. Fix EVERY listed issue in this single structuring pass; do not repair only the first item. If an issue says a path is outside ownership, move that path to an owner whose exact registry patterns cover it or decompose the work item accordingly; never weaken ownership.
- repairPass is bounded runtime metadata. Structural plan repair is an auxiliary pass and must not be confused with a new implementation/task attempt.

INPUT:
${JSON.stringify(input, null, 2)}`;
}

function criteriaEqual(left, right) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

export function technicalPlanRepairIssues({ implementationPlan, implementationPlanSchema, requiredAcceptanceCriteria, registry, request = "" }) {
  if (!implementationPlan) return ["original_handoff_missing_implementation_plan"];
  const baseValidation = validateAgainstSchema(implementationPlan, implementationPlanSchema, "implementationPlan");
  if (!baseValidation.valid) {
    return baseValidation.errors.map((error) => `schema:${error}`);
  }

  const issues = [];
  if (!criteriaEqual(implementationPlan.acceptanceCriteria, requiredAcceptanceCriteria)) {
    issues.push("product_criteria_mutated");
  }

  const implementers = new Set(implementerAgentIds(registry));
  for (const item of implementationPlan.workItems ?? []) {
    if (!implementers.has(item.ownerAgentId)) issues.push(`non_implementer_owner:${item.ownerAgentId}`);
    for (const invalid of invalidValidationCommands(item.validation ?? [])) {
      issues.push(`validation_command_not_executable:${item.id}:${invalid.index}:${String(invalid.command ?? "")}`);
    }
  }

  // Validate work-item semantics against canonical Product Owner criteria so a
  // mutated duplicate criterion catalog does not hide independent ownership,
  // dependency, coverage, or cycle failures. The caller still receives an
  // explicit product_criteria_mutated issue above.
  const canonicalPlan = clone(implementationPlan);
  canonicalPlan.acceptanceCriteria = clone(requiredAcceptanceCriteria ?? []);
  const validationDirective = implementationValidationDirectiveFromRequest(request);
  issues.push(...collectImplementationPlanValidationIssues(canonicalPlan, registry, { validationDirective }));
  return [...new Set(issues)];
}

export function technicalPlanRepairReason(input) {
  const issues = technicalPlanRepairIssues(input);
  if (issues.length === 0) return null;
  return `original_handoff_invalid_implementation_plan:${issues.join(" | ")}`;
}

function synthesisUsage(info) {
  const tokens = info?.tokens ?? info?.usage?.tokens ?? null;
  return {
    inputTokens: Number(tokens?.input ?? info?.usage?.inputTokens ?? 0),
    outputTokens: Number(tokens?.output ?? info?.usage?.outputTokens ?? 0),
    cachedInputTokens: Number(tokens?.cache?.read ?? info?.usage?.cachedInputTokens ?? 0),
    costUsd: Number(info?.cost ?? info?.usage?.costUsd ?? 0),
  };
}

export async function synthesizeMissingImplementationPlan({
  workspace,
  brief,
  handoff,
  implementationPlanSchema,
  registry = null,
  structuredRunner = runOpenCodeStructuredOutput,
  models = null,
  maxRepairPasses = null,
}) {
  if (brief.sdd?.stage !== "technical-refinement" || handoff.status !== "complete") return { handoff, attempted: false };
  const requiredAcceptanceCriteria = brief.upstreamAcceptanceCriteria ?? [];
  if (requiredAcceptanceCriteria.length === 0) throw new Error("technical_plan_synthesis_product_criteria_missing");
  const resolvedRegistry = registry ?? await loadAgentCatalog(process.env.AGENT_HARNESS_ROOT ?? workspace);
  let validationIssues = technicalPlanRepairIssues({
    implementationPlan: handoff.implementationPlan,
    implementationPlanSchema,
    requiredAcceptanceCriteria,
    registry: resolvedRegistry,
    request: brief.objective,
  });
  if (validationIssues.length === 0) return { handoff, attempted: false };

  const schema = buildTechnicalPlanStructuredSchema({ implementationPlanSchema, requiredAcceptanceCriteria, registry: resolvedRegistry });
  const evidence = await planningEvidence({ workspace, handoff, maxBytes: Number(process.env.AGENT_HARNESS_TECHNICAL_PLAN_SYNTHESIS_EVIDENCE_BYTES ?? 80_000) });
  const candidates = models ?? String(process.env.AGENT_HARNESS_TECHNICAL_PLAN_SYNTHESIS_MODELS ?? "openai/gpt-5.6-luna")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (candidates.length === 0) candidates.push("openai/gpt-5.6-luna");
  const configuredPasses = maxRepairPasses ?? Number(process.env.AGENT_HARNESS_TECHNICAL_PLAN_REPAIR_PASSES ?? 2);
  const repairPassLimit = Math.max(1, Math.min(3, Number.isFinite(configuredPasses) ? Math.trunc(configuredPasses) : 2));
  const failures = [];
  let currentHandoff = clone(handoff);
  let aggregateUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };
  let lastModel = null;
  const initialIssues = [...validationIssues];

  for (let repairPass = 1; repairPass <= repairPassLimit; repairPass += 1) {
    let producedPlan = false;
    for (const model of candidates) {
      try {
        const prompt = buildTechnicalPlanSynthesisPrompt({
          brief,
          handoff: currentHandoff,
          registry: resolvedRegistry,
          evidence,
          deterministicValidationIssues: validationIssues,
          repairPass,
        });
        const result = await structuredRunner({
          workspace,
          model,
          agentId: brief.agentId,
          schema,
          prompt,
          title: `${brief.taskId} implementation plan repair ${repairPass}/${repairPassLimit}`,
        });
        const plan = result.value;
        assertSchema(plan, implementationPlanSchema, "implementationPlanSynthesis");
        const usage = synthesisUsage(result.info);
        aggregateUsage = {
          inputTokens: aggregateUsage.inputTokens + usage.inputTokens,
          outputTokens: aggregateUsage.outputTokens + usage.outputTokens,
          cachedInputTokens: aggregateUsage.cachedInputTokens + usage.cachedInputTokens,
          costUsd: aggregateUsage.costUsd + usage.costUsd,
        };
        lastModel = model;
        producedPlan = true;
        currentHandoff.implementationPlan = plan;
        currentHandoff.auxiliaryInvocations = [
          ...(currentHandoff.auxiliaryInvocations ?? []),
          auxiliaryInvocationFromStructuredResult({ purpose: "technical-plan-repair", model, result }),
        ];
        validationIssues = technicalPlanRepairIssues({
          implementationPlan: plan,
          implementationPlanSchema,
          requiredAcceptanceCriteria,
          registry: resolvedRegistry,
          request: brief.objective,
        });
        if (validationIssues.length === 0) {
          const nextHandoff = clone(currentHandoff);
          nextHandoff.findings = [
            ...(nextHandoff.findings ?? []),
            {
              type: "technical_plan_synthesis",
              status: "succeeded",
              reason: `deterministic_preflight:${initialIssues.join(" | ")}`,
              repairPasses: repairPass,
              maxRepairPasses: repairPassLimit,
              modelId: model,
              sessionId: result.sessionId ?? null,
              evidencePaths: evidence.map((item) => item.path),
            },
          ];
          nextHandoff.metrics = {
            ...(nextHandoff.metrics ?? {}),
            inputTokens: Number(nextHandoff.metrics?.inputTokens ?? 0) + aggregateUsage.inputTokens,
            outputTokens: Number(nextHandoff.metrics?.outputTokens ?? 0) + aggregateUsage.outputTokens,
            cachedInputTokens: Number(nextHandoff.metrics?.cachedInputTokens ?? 0) + aggregateUsage.cachedInputTokens,
            costUsd: Number(nextHandoff.metrics?.costUsd ?? 0) + aggregateUsage.costUsd,
          };
          return {
            handoff: nextHandoff,
            attempted: true,
            model,
            usage: aggregateUsage,
            failures,
            repairPasses: repairPass,
            initialIssues,
          };
        }
        failures.push({
          model,
          repairPass,
          error: `technical_plan_repair_incomplete:${validationIssues.join(" | ")}`,
        });
        // Feed the complete remaining issue vector into the next formatter
        // candidate immediately. If no fallback model exists, the outer bounded
        // repair pass repeats with the same model. Neither path consumes a new
        // Runtime task attempt.
        continue;
      } catch (error) {
        failures.push({ model, repairPass, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!producedPlan) break;
  }

  const error = new Error(`technical_plan_synthesis_failed:remaining=${validationIssues.join(" | ")}:failures=${failures.map((item) => `${item.model}@repair-${item.repairPass}:${item.error}`).join(" || ")}`);
  error.failures = failures;
  error.validationIssues = validationIssues;
  error.repairPasses = repairPassLimit;
  error.lastModel = lastModel;
  throw error;
}


export function buildTechnicalReviewRepairPrompt({ brief, handoff, registry, evidence, requiredDeltas, repairPass, sourceRevision }) {
  const implementationValidationDirective = implementationValidationDirectiveFromRequest(brief.objective);
  const input = {
    objective: brief.objective,
    productAcceptanceCriteria: brief.upstreamAcceptanceCriteria ?? [],
    currentImplementationPlan: handoff.implementationPlan,
    requiredDeltas: [...requiredDeltas],
    repairPass,
    sourceRevision,
    implementationAgentOwnership: registrySummary(registry),
    implementationValidationDirective,
    technicalArtifacts: evidence,
  };
  return `Repair ONLY the machine-readable Agentic Harness implementationPlan in response to an SDD Technical Refinement review that returned changes_requested.

This is a bounded SAME-TASK-ATTEMPT semantic repair, not a new Technical Lead task attempt and not a new architecture discovery pass. Return ONLY the implementationPlan JSON matching the supplied schema. Do not execute tools or edit repository files.

Hard requirements:
- Fix every requiredDelta in one pass without inventing new product requirements.
- productAcceptanceCriteria are immutable and must remain byte-for-byte identical.
- Preserve valid work that is unrelated to requiredDeltas; make the smallest sufficient plan change.
- Increment revision exactly once from sourceRevision.
- workItems remain implementation-only and model-agnostic.
- ownerAgentId and ownedPaths must remain valid under implementationAgentOwnership.
- implementation validation remains workspace scoped; host/live/readiness commands are forbidden in implementation workItems.
- preserve executable criterion verification commands exactly. If implementationValidationDirective.mode=focused, include every listed command byte-for-byte and remove every substitute/extra implementation validation command.
- dependencies must remain acyclic and refer only to work item IDs.
- Do not downgrade or remove blocking acceptance criteria to satisfy the review.

INPUT:
${JSON.stringify(input, null, 2)}`;
}

export async function repairImplementationPlanFromReview({
  workspace,
  brief,
  handoff,
  implementationPlanSchema,
  registry = null,
  model = null,
  structuredRunner = runOpenCodeStructuredOutput,
  repairPass = 1,
}) {
  if (brief.sdd?.stage !== "technical-refinement" || handoff?.status !== "complete") return { handoff, attempted: false };
  if (handoff?.sddReview?.decision !== "changes_requested") return { handoff, attempted: false };
  const requiredDeltas = (handoff.sddReview.requiredDeltas ?? []).filter((value) => typeof value === "string" && value.trim());
  if (requiredDeltas.length === 0) throw new Error("technical_review_repair_required_deltas_missing");
  const sourcePlan = handoff.implementationPlan;
  if (!sourcePlan || typeof sourcePlan !== "object" || Array.isArray(sourcePlan)) throw new Error("technical_review_repair_source_plan_missing");
  const sourceRevision = Number(sourcePlan.revision);
  if (!Number.isInteger(sourceRevision) || sourceRevision < 1) throw new Error("technical_review_repair_source_revision_invalid");

  const requiredAcceptanceCriteria = brief.upstreamAcceptanceCriteria ?? [];
  if (requiredAcceptanceCriteria.length === 0) throw new Error("technical_review_repair_product_criteria_missing");
  const resolvedRegistry = registry ?? await loadAgentCatalog(process.env.AGENT_HARNESS_ROOT ?? workspace);
  const schema = buildTechnicalPlanStructuredSchema({ implementationPlanSchema, requiredAcceptanceCriteria, registry: resolvedRegistry });
  schema.properties.revision = { const: sourceRevision + 1 };
  const evidence = await planningEvidence({ workspace, handoff, maxBytes: Number(process.env.AGENT_HARNESS_TECHNICAL_PLAN_SYNTHESIS_EVIDENCE_BYTES ?? 80_000) });
  const selectedModel = model ?? String(process.env.AGENT_HARNESS_TECHNICAL_REVIEW_REPAIR_MODEL ?? "openai/gpt-5.6-luna");
  const result = await structuredRunner({
    workspace,
    model: selectedModel,
    agentId: brief.agentId,
    schema,
    prompt: buildTechnicalReviewRepairPrompt({ brief, handoff, registry: resolvedRegistry, evidence, requiredDeltas, repairPass, sourceRevision }),
    title: `${brief.taskId} review repair ${repairPass}`,
  });
  const repairedPlan = result.value;
  assertSchema(repairedPlan, schema, "technicalReviewRepair");
  const validationIssues = technicalPlanRepairIssues({
    implementationPlan: repairedPlan,
    implementationPlanSchema,
    requiredAcceptanceCriteria,
    registry: resolvedRegistry,
    request: brief.objective,
  });
  if (validationIssues.length > 0) throw new Error(`technical_review_repair_invalid:${validationIssues.join(" | ")}`);

  const usage = synthesisUsage(result.info);
  const next = clone(handoff);
  next.implementationPlan = repairedPlan;
  delete next.sddReview;
  next.findings = [
    ...(next.findings ?? []),
    {
      type: "runtime_repair",
      repairKind: "technical-review-semantic",
      status: "candidate",
      repairPass,
      sourceRevision,
      repairedRevision: repairedPlan.revision,
      requiredDeltas,
      sameTaskAttempt: true,
      taskAttempt: Number(brief.modelRouting?.attempt ?? 1),
      modelId: selectedModel,
      sessionId: result.sessionId ?? null,
    },
  ];
  next.auxiliaryInvocations = [
    ...(next.auxiliaryInvocations ?? []),
    auxiliaryInvocationFromStructuredResult({ purpose: "technical-plan-synthesis", model: selectedModel, result }),
  ];
  next.metrics = {
    ...(next.metrics ?? {}),
    inputTokens: Number(next.metrics?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: Number(next.metrics?.outputTokens ?? 0) + usage.outputTokens,
    cachedInputTokens: Number(next.metrics?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
    costUsd: Number(next.metrics?.costUsd ?? 0) + usage.costUsd,
  };
  return {
    handoff: next,
    attempted: true,
    model: selectedModel,
    sessionId: result.sessionId ?? null,
    usage,
    repairPass,
    sourceRevision,
    repairedRevision: repairedPlan.revision,
    requiredDeltas,
  };
}
