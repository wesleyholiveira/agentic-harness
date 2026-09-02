function payloadObject(event) {
  const raw = event?.payload_json ?? event?.payload ?? null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function progressEventPayload(event) {
  return payloadObject(event);
}

export function findDurableProgressCheckpoint(events = [], messageIdInput = "") {
  const messageId = String(messageIdInput ?? "").trim();
  if (!messageId) return null;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.event_type !== "progress.checkpoint_committed") continue;
    const payload = payloadObject(event);
    if (String(payload.messageId ?? "") !== messageId) continue;
    if (payload.persistenceCommitted !== true) continue;
    if (payload.authoritative !== false || payload.presentationOnly !== true) continue;
    const effectKey = String(payload.effectKey ?? "").trim();
    if (!effectKey) continue;
    return { event, payload, effectKey };
  }
  return null;
}
