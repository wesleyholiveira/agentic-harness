import { runOpenCodeStructuredOutput } from "./opencode-structured-output.mjs";
import { auxiliaryInvocationFromStructuredResult } from "./auxiliary-telemetry.mjs";

function clone(value) { return JSON.parse(JSON.stringify(value)); }

export function blockingCriteria(taskBrief) {
  return (taskBrief.acceptanceCriteria ?? []).filter((criterion) => criterion.blocking !== false);
}

export function missingCompletionCriterionIds(taskBrief, handoff) {
  const present = new Set((handoff.criterionResults ?? []).map((item) => item.criterionId));
  return blockingCriteria(taskBrief).map((criterion) => criterion.id).filter((id) => !present.has(id));
}

export function buildCompletionEvidenceSchema({ missingCriteria }) {
  const ids = missingCriteria.map((criterion) => criterion.id);
  return {
    type: "object",
    additionalProperties: false,
    required: ["criterionResults"],
    properties: {
      criterionResults: {
        type: "array",
        minItems: ids.length,
        maxItems: ids.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterionId", "result", "evidence"],
          properties: {
            criterionId: { type: "string", enum: ids },
            result: { enum: ["passed", "failed", "blocked", "not_applicable"] },
            evidence: { type: "string", minLength: 1 },
          },
        },
      },
    },
  };
}

export function buildCompletionEvidencePrompt({ brief, handoff, missingCriteria }) {
  const input = {
    objective: brief.objective,
    stage: brief.sdd?.stage ?? "implementation",
    missingCriteria: missingCriteria.map((criterion) => ({
      id: criterion.id,
      statement: criterion.statement,
      verification: criterion.verification,
      blocking: criterion.blocking !== false,
    })),
    existingCriterionResults: handoff.criterionResults ?? [],
    existingHandoffEvidence: {
      status: handoff.status,
      assumptions: handoff.assumptions ?? [],
      changedPaths: handoff.changedPaths ?? [],
      reusedPaths: handoff.reusedPaths ?? [],
      contractChanges: handoff.contractChanges ?? [],
      validation: handoff.validation ?? [],
      findings: handoff.findings ?? [],
      residualRisks: handoff.residualRisks ?? [],
      followUps: handoff.followUps ?? [],
      sddReview: handoff.sddReview ?? null,
    },
  };
  return `Repair only the missing criterionResults entries in an already-produced Agentic Harness handoff.

This is an EVIDENCE-STRUCTURING pass, not a new implementation/review pass. Do not edit repository files. Use only the evidence already present in INPUT. Do not invent evidence and do not reinterpret the criterion IDs.

For every item in missingCriteria, return exactly one criterionResults entry with the exact criterionId.
- result=passed only when existingHandoffEvidence explicitly proves the statement/verification.
- otherwise return failed, blocked, or not_applicable with a precise evidence explanation.
- never omit a requested criterion.
- never return criterion IDs outside missingCriteria.

INPUT:\n${JSON.stringify(input, null, 2)}`;
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

function validateRepairResults(results, missingCriteria) {
  const expected = missingCriteria.map((criterion) => criterion.id).sort();
  const actual = results.map((item) => item.criterionId).sort();
  if (new Set(actual).size !== actual.length) throw new Error("completion_evidence_synthesis_duplicate_criterion");
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`completion_evidence_synthesis_criterion_set_mismatch:expected=${expected.join(",")}:actual=${actual.join(",")}`);
  }
}

export async function synthesizeMissingCriterionResults({
  workspace,
  brief,
  handoff,
  structuredRunner = runOpenCodeStructuredOutput,
  models = null,
}) {
  const missingIds = missingCompletionCriterionIds(brief, handoff);
  if (missingIds.length === 0) return { handoff, attempted: false, missingIds: [] };
  const requiredById = new Map(blockingCriteria(brief).map((criterion) => [criterion.id, criterion]));
  const missingCriteria = missingIds.map((id) => requiredById.get(id));
  const schema = buildCompletionEvidenceSchema({ missingCriteria });
  const prompt = buildCompletionEvidencePrompt({ brief, handoff, missingCriteria });
  const candidates = models ?? String(process.env.AGENT_HARNESS_COMPLETION_EVIDENCE_SYNTHESIS_MODELS ?? "openai/gpt-5.6-luna")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (candidates.length === 0) candidates.push("openai/gpt-5.6-luna");
  const failures = [];
  for (const model of candidates) {
    try {
      const result = await structuredRunner({
        workspace,
        model,
        agentId: brief.agentId,
        schema,
        prompt,
        title: `${brief.taskId} completion evidence synthesis`,
      });
      const repaired = result.value?.criterionResults ?? [];
      validateRepairResults(repaired, missingCriteria);
      const usage = synthesisUsage(result.info);
      const nextHandoff = clone(handoff);
      // Preserve the original evidence set exactly and append only the missing
      // criterion IDs. Duplicate/conflicting model evidence is intentionally not
      // collapsed here; the completion gate must detect and reject it.
      nextHandoff.criterionResults = [...(nextHandoff.criterionResults ?? []), ...repaired];
      nextHandoff.findings = [
        ...(nextHandoff.findings ?? []),
        {
          type: "completion_evidence_synthesis",
          status: "succeeded",
          reason: "blocking_criterion_result_missing",
          criterionIds: missingIds,
          modelId: model,
          sessionId: result.sessionId ?? null,
        },
      ];
      nextHandoff.auxiliaryInvocations = [
        ...(handoff.auxiliaryInvocations ?? []),
        auxiliaryInvocationFromStructuredResult({ purpose: "completion-evidence-synthesis", model, result }),
      ];
      nextHandoff.metrics = {
        ...(nextHandoff.metrics ?? {}),
        inputTokens: Number(nextHandoff.metrics?.inputTokens ?? 0) + usage.inputTokens,
        outputTokens: Number(nextHandoff.metrics?.outputTokens ?? 0) + usage.outputTokens,
        cachedInputTokens: Number(nextHandoff.metrics?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
        costUsd: Number(nextHandoff.metrics?.costUsd ?? 0) + usage.costUsd,
      };
      return { handoff: nextHandoff, attempted: true, missingIds, model, usage, failures };
    } catch (error) {
      failures.push({ model, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const error = new Error(`completion_evidence_synthesis_failed:${failures.map((item) => `${item.model}:${item.error}`).join(" | ")}`);
  error.failures = failures;
  throw error;
}
