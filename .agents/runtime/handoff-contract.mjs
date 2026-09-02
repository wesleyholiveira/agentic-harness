const VALIDATION_PHASES = new Set(["red", "implementation", "final"]);
const VALIDATION_RESULTS = new Set(["passed", "failed", "blocked"]);
const SDD_REVIEW_KEYS = new Set(["role", "stage", "decision", "reviewedRevision", "nextRole", "requiredDeltas"]);
const SAFE_EMPTY_ARRAY_FIELDS = [
  "changedPaths", "reusedPaths", "contractChanges", "assumptions", "criterionResults",
  "validation", "residualRisks", "followUps", "usedContextPaths",
];
const PATH_ARRAY_FIELDS = new Set(["changedPaths", "reusedPaths", "usedContextPaths"]);
const TEXT_ARRAY_FIELDS = new Set(["contractChanges", "assumptions", "residualRisks", "followUps"]);
const CRITERION_RESULTS = new Set(["passed", "failed", "blocked", "not_applicable"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalRevision(value) {
  if (Number.isInteger(value) && value >= 1) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  }
  return null;
}

function normalizeSddReview(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return { value: review, remappedFields: [], removedFields: [] };
  }
  const next = { ...review };
  const remappedFields = [];
  if (!Object.hasOwn(next, "reviewedRevision") && Object.hasOwn(next, "consumedRevision")) {
    const revision = canonicalRevision(next.consumedRevision);
    if (revision !== null) {
      next.reviewedRevision = revision;
      remappedFields.push("sddReview.consumedRevision->reviewedRevision");
    }
  }
  if (!Object.hasOwn(next, "nextRole") && Object.hasOwn(next, "returnedTo")) {
    if (next.returnedTo === null || nonEmptyString(next.returnedTo)) {
      next.nextRole = next.returnedTo;
      remappedFields.push("sddReview.returnedTo->nextRole");
    }
  }
  const removedFields = Object.keys(next).filter((key) => !SDD_REVIEW_KEYS.has(key));
  for (const key of removedFields) delete next[key];
  return { value: next, remappedFields, removedFields: removedFields.map((key) => `sddReview.${key}`) };
}


function normalizeReviewProvenance(review, brief) {
  if (!review || typeof review !== "object" || Array.isArray(review) || !brief?.sdd) {
    return { value: review, normalizedFields: [] };
  }
  const next = { ...review };
  const normalizedFields = [];
  const expectedRole = nonEmptyString(brief.sdd.role) ? brief.sdd.role : brief.agentId;
  const expectedStage = nonEmptyString(brief.sdd.stage) ? brief.sdd.stage : null;
  const expectedRevision = canonicalRevision(brief.sdd.reviewedRevision);

  // role/stage/revision are runtime-owned provenance, not semantic review
  // decisions. Missing values and the registry agent-id alias are safe to
  // canonicalize; unrelated non-empty values remain untouched so the review
  // contract can reject genuine provenance mismatches.
  if (!nonEmptyString(next.role) && nonEmptyString(expectedRole)) {
    next.role = expectedRole;
    normalizedFields.push("sddReview.role<-TaskBrief.sdd.role");
  } else if (nonEmptyString(expectedRole) && next.role === brief.agentId && next.role !== expectedRole) {
    next.role = expectedRole;
    normalizedFields.push("sddReview.role:agentId->logicalRole");
  }
  if (!nonEmptyString(next.stage) && expectedStage) {
    next.stage = expectedStage;
    normalizedFields.push("sddReview.stage<-TaskBrief.sdd.stage");
  }
  const actualRevision = canonicalRevision(next.reviewedRevision);
  if (actualRevision === null && expectedRevision !== null) {
    next.reviewedRevision = expectedRevision;
    normalizedFields.push("sddReview.reviewedRevision<-TaskBrief.sdd.reviewedRevision");
  } else if (actualRevision !== null && next.reviewedRevision !== actualRevision) {
    next.reviewedRevision = actualRevision;
    normalizedFields.push("sddReview.reviewedRevision:string->integer");
  }

  const positiveDecision = expectedStage === "product-acceptance" ? "accepted" : "approved";
  if (next.decision === positiveDecision) {
    if (!Object.hasOwn(next, "requiredDeltas")) {
      next.requiredDeltas = [];
      normalizedFields.push("sddReview.requiredDeltas<-[]:positiveDecision");
    }
    if (!Object.hasOwn(next, "nextRole")) {
      next.nextRole = null;
      normalizedFields.push("sddReview.nextRole<-null:positiveDecision");
    }
  }
  return { value: next, normalizedFields };
}


function normalizeStringArray(value, { pathLike = false } = {}) {
  if (!Array.isArray(value)) return { value, changed: false, dropped: [] };
  const next = [];
  const dropped = [];
  for (const [index, item] of value.entries()) {
    if (typeof item === "string" && item.trim()) {
      next.push(item);
      continue;
    }
    if (!pathLike && item != null) {
      const rendered = typeof item === "object" ? JSON.stringify(item) : String(item);
      if (rendered.trim()) {
        next.push(rendered);
        dropped.push({ index, reason: "non_string_canonicalized" });
        continue;
      }
    }
    dropped.push({ index, reason: "invalid_array_entry_dropped" });
  }
  return { value: next, changed: dropped.length > 0, dropped };
}

function normalizeCriterionResults(value) {
  if (!Array.isArray(value)) return { value, changed: false, dropped: [] };
  const next = [];
  const dropped = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      dropped.push({ index, reason: "entry_not_object" });
      continue;
    }
    if (!nonEmptyString(raw.criterionId) || !CRITERION_RESULTS.has(raw.result) || typeof raw.evidence !== "string") {
      dropped.push({ index, reason: "criterion_result_invalid" });
      continue;
    }
    next.push({ criterionId: raw.criterionId, result: raw.result, evidence: raw.evidence });
  }
  return { value: next, changed: dropped.length > 0, dropped };
}

function normalizeValidationEntries(validation) {
  if (!Array.isArray(validation)) return { value: validation, defaultedBlockingIndexes: [], droppedEntries: [] };
  const value = [];
  const defaultedBlockingIndexes = [];
  const droppedEntries = [];
  for (const [index, raw] of validation.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      droppedEntries.push({ index, reason: "entry_not_object" });
      continue;
    }
    const command = raw.command;
    const phase = raw.phase;
    const result = raw.result;
    const evidence = raw.evidence;
    if (typeof command !== "string") {
      droppedEntries.push({ index, reason: "command_invalid" });
      continue;
    }
    if (!VALIDATION_PHASES.has(phase)) {
      droppedEntries.push({ index, reason: "phase_invalid" });
      continue;
    }
    if (!VALIDATION_RESULTS.has(result)) {
      droppedEntries.push({ index, reason: "result_invalid" });
      continue;
    }
    if (typeof evidence !== "string") {
      droppedEntries.push({ index, reason: "evidence_invalid" });
      continue;
    }
    const blocking = typeof raw.blocking === "boolean" ? raw.blocking : true;
    if (typeof raw.blocking !== "boolean") defaultedBlockingIndexes.push(index);
    // Model-authored validation is never authoritative on the first boundary.
    // Runtime receipts appended later are preserved only when they carry the
    // complete runtime receipt shape.
    const runtimeReceipt = raw.authority === "runtime"
      && (Number.isInteger(raw.exitCode) || raw.exitCode === null)
      && typeof raw.timedOut === "boolean"
      && typeof raw.executedAt === "string" && !Number.isNaN(Date.parse(raw.executedAt));
    value.push({
      command, phase, blocking, result, evidence,
      authority: runtimeReceipt ? "runtime" : "model",
      ...(runtimeReceipt ? { exitCode: raw.exitCode, timedOut: raw.timedOut, executedAt: raw.executedAt } : {}),
    });
  }
  return { value, defaultedBlockingIndexes, droppedEntries };
}

/**
 * Normalize only mechanically safe parts of a model-authored Handoff Result.
 * Identity conflicts and semantic evidence are never repaired by assignment.
 * Required list containers may receive an empty structural representation, but
 * criterion/validation, review, workspace and diff gates remain authoritative;
 * this function never invents positive evidence, decisions or validation outcomes.
 */
export function normalizeModelHandoffContract({ handoff, brief, attempt = 1 }) {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) {
    return { handoff, changed: false, remappedFields: [], removedFields: [], defaultedFields: [], droppedValidationEntries: [], identityMismatches: [] };
  }
  const next = clone(handoff);
  const remappedFields = [];
  const removedFields = [];
  const defaultedFields = [];
  const identityMismatches = [];

  if (!Object.hasOwn(next, "schemaVersion")) {
    next.schemaVersion = 2;
    defaultedFields.push("schemaVersion");
  }
  for (const [field, expected] of [["runId", brief.runId], ["taskId", brief.taskId], ["agentId", brief.agentId]]) {
    if (!nonEmptyString(next[field])) {
      next[field] = expected;
      defaultedFields.push(field);
    } else if (next[field] !== expected) {
      identityMismatches.push({ field, expected, actual: next[field] });
    }
  }

  const authoritativeArtifactVersion = String(Math.max(1, Number(attempt) || 1));
  if (next.artifactVersion !== authoritativeArtifactVersion) {
    next.artifactVersion = authoritativeArtifactVersion;
    defaultedFields.push("artifactVersion");
  }

  // Missing required lists have a mechanically safe empty representation. This
  // never proves work: criterion/validation completion gates still require exact
  // positive evidence and workspace inspection remains authoritative for paths.
  for (const field of SAFE_EMPTY_ARRAY_FIELDS) {
    if (!Object.hasOwn(next, field)) {
      next[field] = [];
      defaultedFields.push(field);
    }
  }

  const mechanicallyNormalizedEntries = [];
  for (const field of [...PATH_ARRAY_FIELDS, ...TEXT_ARRAY_FIELDS]) {
    if (!Object.hasOwn(next, field)) continue;
    const normalized = normalizeStringArray(next[field], { pathLike: PATH_ARRAY_FIELDS.has(field) });
    next[field] = normalized.value;
    if (normalized.changed) mechanicallyNormalizedEntries.push(...normalized.dropped.map((entry) => ({ field, ...entry })));
  }
  if (Object.hasOwn(next, "criterionResults")) {
    const normalized = normalizeCriterionResults(next.criterionResults);
    next.criterionResults = normalized.value;
    if (normalized.changed) mechanicallyNormalizedEntries.push(...normalized.dropped.map((entry) => ({ field: "criterionResults", ...entry })));
  }
  if (mechanicallyNormalizedEntries.length > 0) {
    next.findings = [
      ...(Array.isArray(next.findings) ? next.findings : []),
      {
        type: "handoff_mechanical_repair",
        status: "succeeded",
        reason: "mechanically_safe_shape_normalization",
        entries: mechanicallyNormalizedEntries,
      },
    ];
  }

  if (Object.hasOwn(next, "sddReview")) {
    const review = normalizeSddReview(next.sddReview);
    const provenance = normalizeReviewProvenance(review.value, brief);
    next.sddReview = provenance.value;
    remappedFields.push(...review.remappedFields, ...provenance.normalizedFields);
    removedFields.push(...review.removedFields);
  }

  let droppedValidationEntries = [];
  if (Object.hasOwn(next, "validation")) {
    const validation = normalizeValidationEntries(next.validation);
    next.validation = validation.value;
    droppedValidationEntries = validation.droppedEntries;
    if (validation.defaultedBlockingIndexes.length > 0) {
      defaultedFields.push(...validation.defaultedBlockingIndexes.map((index) => `validation[${index}].blocking`));
    }
    if (validation.droppedEntries.length > 0) {
      next.findings = [
        ...(Array.isArray(next.findings) ? next.findings : []),
        {
          type: "handoff_contract_normalization",
          status: "normalized",
          reason: "malformed_validation_evidence_dropped",
          entries: validation.droppedEntries,
        },
      ];
    }
  }

  return {
    handoff: next,
    changed: remappedFields.length > 0 || removedFields.length > 0 || defaultedFields.length > 0 || droppedValidationEntries.length > 0 || mechanicallyNormalizedEntries.length > 0,
    remappedFields,
    removedFields,
    defaultedFields,
    droppedValidationEntries,
    mechanicallyNormalizedEntries,
    identityMismatches,
  };
}

/** Remove model-authored telemetry before any authoritative runtime usage is aggregated. */
export function stripModelOwnedHandoffTelemetry(handoff) {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) {
    return { handoff, removedFields: [] };
  }
  const next = clone(handoff);
  const removedFields = [];
  for (const field of ["metrics", "executionTelemetry", "auxiliaryInvocations"]) {
    if (Object.hasOwn(next, field)) {
      delete next[field];
      removedFields.push(field);
    }
  }
  return { handoff: next, removedFields };
}

export function classifyHandoffValidationError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("schema_validation_failed:handoffResult:")) {
    return { code: "handoff_schema_invalid", message, retryable: true, category: "contract", repairExhausted: true };
  }
  if (message.includes("handoff_identity_mismatch")) {
    return { code: "handoff_identity_mismatch", message, retryable: false, category: "contract" };
  }
  return { code: "handoff_invalid", message, retryable: false, category: "contract" };
}
