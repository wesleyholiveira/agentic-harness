function normalizedIdentityPart(value, fallback = "unknown") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

export function contextReadyEffectKey({ runId, taskId, attempt, packId = null, packetId = null }) {
  return [
    "runtime-context-ready/v1",
    normalizedIdentityPart(runId),
    normalizedIdentityPart(taskId),
    String(Math.max(1, Number(attempt ?? 1) || 1)),
    normalizedIdentityPart(packId ?? packetId, "unidentified-pack"),
  ].join(":");
}

export async function persistContextReady({ store, runId, taskId, attempt, packId = null, packetId = null, payload }) {
  const effectKey = contextReadyEffectKey({ runId, taskId, attempt, packId, packetId });
  const eventPayload = { ...payload, effectKey };
  if (typeof store.eventOnce === "function") {
    return await store.eventOnce(runId, taskId, "context.ready", eventPayload, effectKey);
  }
  await store.event(runId, taskId, "context.ready", eventPayload);
  return { inserted: true, eventId: null, degradedIdempotency: true };
}
