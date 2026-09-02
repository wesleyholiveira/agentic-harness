function requiredCriteria(taskBrief) {
  return (taskBrief.acceptanceCriteria ?? []).filter((criterion) => criterion.blocking !== false);
}

function requiredCriterionViolations(taskBrief, handoff) {
  const violations = [];
  const results = handoff.criterionResults ?? [];
  for (const criterion of requiredCriteria(taskBrief)) {
    const matches = results.filter((item) => item.criterionId === criterion.id);
    if (matches.length === 0) {
      violations.push(`criterion_missing:${criterion.id}`);
      continue;
    }
    if (matches.length !== 1) {
      const states = matches.map((item) => item.result).join(",");
      violations.push(`criterion_result_duplicate:${criterion.id}:${states}`);
      continue;
    }
    const result = matches[0];
    if (result.result !== "passed") violations.push(`criterion_not_passed:${criterion.id}:${result.result}`);
    else if (!String(result.evidence ?? "").trim()) violations.push(`criterion_evidence_missing:${criterion.id}`);
  }
  return violations;
}

function requiredValidationViolations(taskBrief, handoff) {
  const validations = handoff.validation ?? [];
  const violations = [];
  const requiredCommands = [...new Set(taskBrief.validation ?? [])];
  const requiredSet = new Set(requiredCommands);

  for (const command of requiredCommands) {
    const all = validations.filter((entry) => entry.command === command && entry.phase === "final" && entry.blocking !== false);
    const runtime = all.filter((entry) => entry.authority === "runtime");
    if (runtime.length === 0) {
      violations.push(`required_validation_missing_runtime_receipt:${command}`);
      continue;
    }
    if (runtime.length !== 1) {
      violations.push(`validation_result_conflict:${command}:${runtime.map((entry) => entry.result).join(",")}`);
      continue;
    }
    const receipt = runtime[0];
    if (receipt.result !== "passed" || !String(receipt.evidence ?? "").trim()) {
      violations.push(`required_validation_not_passed:${command}`);
    }
    const contradictory = all.filter((entry) => entry !== receipt && ["failed", "blocked"].includes(entry.result));
    if (contradictory.length > 0) {
      violations.push(`validation_result_conflict:${command}:${[receipt.result, ...contradictory.map((entry) => entry.result)].join(",")}`);
    }
  }

  for (const validation of validations) {
    if (validation.phase !== "final" || validation.blocking === false || validation.result === "passed") continue;
    if (!requiredSet.has(validation.command)) violations.push(`final_validation_${validation.result}:${validation.command}`);
  }
  return violations;
}

export function classifyCompletionFailure(violations = []) {
  const values = [...(violations ?? [])].map(String);
  if (values.some((value) => value.startsWith("required_validation_not_passed:") || value.startsWith("final_validation_failed:") || value.startsWith("final_validation_blocked:"))) {
    return { code: "completion_validation_failed", category: "contract", retryable: true, repairExhausted: true, failureClass: "validation-failure" };
  }
  if (values.some((value) => value.startsWith("validation_result_conflict:") || value.startsWith("criterion_result_duplicate:"))) {
    return { code: "completion_contract_conflict", category: "contract", retryable: true, repairExhausted: true, failureClass: "conflicting-evidence" };
  }
  if (values.some((value) => value.startsWith("criterion_missing:") || value.startsWith("criterion_evidence_missing:") || value.startsWith("required_validation_missing_runtime_receipt:"))) {
    return { code: "completion_evidence_missing", category: "contract", retryable: true, repairExhausted: true, failureClass: "missing-evidence" };
  }
  return { code: "completion_semantic_unproven", category: "contract", retryable: true, repairExhausted: true, failureClass: "semantic-unproven" };
}

export function evaluateCompletion({ taskBrief, handoff }) {
  const violations = [
    ...requiredCriterionViolations(taskBrief, handoff),
    ...requiredValidationViolations(taskBrief, handoff),
  ];

  if (handoff.sddReview?.decision === "changes_requested") violations.push("sdd_changes_requested");
  if (handoff.sddReview?.decision === "blocked") violations.push("sdd_blocked");
  if ((handoff.sddReview?.requiredDeltas ?? []).length > 0) violations.push("sdd_required_deltas_open");
  if ((handoff.residualRisks ?? []).some((risk) => /^blocking:/i.test(risk))) violations.push("blocking_residual_risk");
  if ((handoff.followUps ?? []).some((item) => /^required:/i.test(item))) violations.push("required_follow_up_open");

  if (handoff.status === "complete" && violations.length > 0) {
    return { accepted: false, ...classifyCompletionFailure(violations), violations };
  }
  return { accepted: handoff.status === "complete", code: handoff.status === "complete" ? "complete_proven" : `handoff_${handoff.status}`, violations };
}
