function parsePayload(event) {
  const value = event?.payload_json ?? event?.payload ?? null;
  if (value && typeof value === "object") return value;
  try { return JSON.parse(String(value ?? "{}")); }
  catch { return {}; }
}

function matchingPhysicalIdentity(payload, sourceIdentity, replacementIdentity) {
  return Number(payload.taskAttempt) === Number(sourceIdentity.attempt)
    && Number(payload.sourceTaskAttempt) === Number(sourceIdentity.attempt)
    && Number(payload.dispatchGeneration) === Number(replacementIdentity.dispatchGeneration)
    && Number(payload.fencingToken) === Number(replacementIdentity.fencingToken);
}

export function evaluateH9RRecoveryEvidence({ sourceIdentity, replacementIdentity, events, replacementLog = "", processLossMechanism = null }) {
  const typed = (type) => events
    .filter((event) => event.event_type === type)
    .map((event) => ({ event, payload: parsePayload(event) }));
  const matchingResume = typed("repair.resume_checkpoint_loaded")
    .filter(({ payload }) => matchingPhysicalIdentity(payload, sourceIdentity, replacementIdentity));
  const matchingPrepared = typed("repair.replacement_execution_prepared")
    .filter(({ payload }) => matchingPhysicalIdentity(payload, sourceIdentity, replacementIdentity)
      && Number(payload.sourceDispatchGeneration) === Number(sourceIdentity.dispatchGeneration)
      && Number(payload.sourceFencingToken) === Number(sourceIdentity.fencingToken)
      && payload.preservedSemanticAttempt === true);
  const matchingDispatched = typed("repair.replacement_execution_dispatched")
    .filter(({ payload }) => matchingPhysicalIdentity(payload, sourceIdentity, replacementIdentity)
      && Number(payload.sourceDispatchGeneration) === Number(sourceIdentity.dispatchGeneration)
      && Number(payload.sourceFencingToken) === Number(sourceIdentity.fencingToken)
      && payload.sameTaskAttempt === true
      && payload.skippedFullAgentInvocationExpected === true);
  const repairEffects = new Map();
  for (const event of events.filter((item) => String(item.event_type ?? "").startsWith("repair."))) {
    const effectKey = parsePayload(event).effectKey;
    if (!effectKey) continue;
    repairEffects.set(effectKey, (repairEffects.get(effectKey) ?? 0) + 1);
  }
  const duplicateRepairEffectKeys = [...repairEffects.entries()]
    .filter(([, count]) => count > 1)
    .map(([effectKey, count]) => ({ effectKey, count }));
  const resume = matchingResume[0]?.payload ?? null;
  const checks = {
    processLossMechanismIsAncestorPidNamespace: processLossMechanism === "docker-host-pid-namespace-helper-sigkill",
    processLossObserved: sourceIdentity.workerRestartAfter > sourceIdentity.workerRestartBefore,
    workerHostPidChanged: Number(sourceIdentity.workerHostPidBefore) > 1
      && Number(sourceIdentity.workerHostPidAfter) > 1
      && Number(sourceIdentity.workerHostPidAfter) !== Number(sourceIdentity.workerHostPidBefore),
    semanticAttemptPreserved: Number(replacementIdentity.attempt) === Number(sourceIdentity.attempt),
    dispatchGenerationAdvancedExactlyOnce: Number(replacementIdentity.dispatchGeneration) === Number(sourceIdentity.dispatchGeneration) + 1,
    fencingTokenAdvancedExactlyOnce: Number(replacementIdentity.fencingToken) === Number(sourceIdentity.fencingToken) + 1,
    exactlyOneMatchingReplacementPrepared: matchingPrepared.length === 1,
    exactlyOneMatchingReplacementDispatched: matchingDispatched.length === 1,
    exactlyOneMatchingResumeReceipt: matchingResume.length === 1,
    skippedFullAgentInvocation: resume?.skippedFullAgentInvocation === true,
    sameTaskAttemptReceipt: resume?.sameTaskAttempt === true,
    checkpointIdentityPreserved: Boolean(resume?.checkpointEffectKey)
      && String(resume.checkpointEffectKey) === String(sourceIdentity.checkpointEffectKey),
    noDuplicateRepairEffects: duplicateRepairEffectKeys.length === 0,
    replacementLogSkippedOpenCodeLaunch: replacementLog ? !replacementLog.includes('"type":"opencode.launching"') : true,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    resumeReceipt: resume,
    replacementPrepared: matchingPrepared[0]?.payload ?? null,
    replacementDispatched: matchingDispatched[0]?.payload ?? null,
    duplicateRepairEffectKeys,
  };
}
