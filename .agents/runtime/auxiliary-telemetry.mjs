function numberOrZero(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function nullableNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

export function auxiliaryInvocationFromStructuredResult({ purpose, model, result, stepsLimit = 8 }) {
  const info = result?.info ?? null;
  const tokens = info?.tokens ?? info?.usage?.tokens ?? null;
  const stepsUsed = nullableNonNegativeInteger(info?.stepsUsed ?? info?.steps);
  const stopReason = info?.stopReason ?? info?.finishReason ?? info?.finish ?? null;
  return {
    purpose,
    modelId: model,
    sessionId: result?.sessionId ?? null,
    adapterAttempts: Math.max(1, Number(result?.attempts ?? info?.structuredAttempts ?? 1) || 1),
    stepsUsed,
    stepsLimit: Math.max(1, Number(stepsLimit) || 8),
    stepLimitReached: stepsUsed === null ? null : stepsUsed >= Math.max(1, Number(stepsLimit) || 8),
    stopReason: typeof stopReason === "string" ? stopReason : null,
    inputTokens: numberOrZero(tokens?.input ?? info?.usage?.inputTokens),
    cachedInputTokens: numberOrZero(tokens?.cache?.read ?? info?.usage?.cachedInputTokens),
    outputTokens: numberOrZero(tokens?.output ?? info?.usage?.outputTokens),
    costUsd: numberOrZero(info?.cost ?? info?.usage?.costUsd),
    wallMs: numberOrZero(result?.wallMs),
  };
}

export function appendAuxiliaryInvocation(handoff, invocation) {
  return {
    ...handoff,
    auxiliaryInvocations: [...(handoff?.auxiliaryInvocations ?? []), invocation],
  };
}
