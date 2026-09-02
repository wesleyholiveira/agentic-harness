#!/usr/bin/env node

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);
const asPositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
};

const baseUrl = String(
  process.env.AGENT_HARNESS_AGENT_PROGRESS_OBSERVATION_URL
    ?? `http://127.0.0.1:${String(process.env.CONTEXT_ENGINE_HTTP_PORT ?? "8789").trim() || "8789"}/runtime-progress-observation`,
).trim();
const mode = String(flag("mode", "attached")).trim().toLowerCase();
const sessionId = flag("session-id");
const instanceId = flag("instance-id");
const messageId = flag("message-id");
const directory = flag("directory");
const maxAgeMs = asPositiveInteger(flag("max-age-ms", process.env.AGENT_HARNESS_AGENT_PROGRESS_PROJECTOR_HEARTBEAT_MAX_AGE_MS), 15_000);

function fail(code, details = {}) {
  process.stdout.write(`${JSON.stringify({ ok: false, code, ...details })}\n`);
  process.exitCode = 1;
}

function queryUrl(filters = {}) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(filters)) {
    if (value !== null && value !== undefined && String(value).trim()) url.searchParams.set(key, String(value));
  }
  return url;
}

async function getObservations(filters = {}) {
  const response = await fetch(queryUrl(filters), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`runtime_progress_observation_http_${response.status}`);
  const body = await response.json();
  return Array.isArray(body?.observations) ? body.observations : [];
}

function receivedAt(entry) {
  const value = Number(entry?.receivedAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function latest(entries, predicate = () => true) {
  return entries.filter(predicate).sort((a, b) => receivedAt(b) - receivedAt(a))[0] ?? null;
}

try {
  const filters = { sessionId, instanceId, messageId, directory };
  const observations = await getObservations(filters);
  if (mode === "attached") {
    const heartbeat = latest(observations, (entry) => entry.event === "progress.live_projector_heartbeat");
    const attach = latest(observations, (entry) => entry.event === "progress.live_projector_attached");
    const proof = heartbeat ?? attach;
    if (!proof) {
      fail("agent_runtime_live_projector_not_attached", { baseUrl, sessionId, instanceId });
    } else {
      const ageMs = Math.max(0, Date.now() - receivedAt(proof));
      const sameInstance = String(proof.instanceId ?? "");
      const lastTerminalLifecycle = latest(observations, (entry) =>
        String(entry.instanceId ?? "") === sameInstance &&
        ["progress.live_projector_detached", "progress.live_projector_disposed"].includes(String(entry.event ?? "")));
      if (ageMs > maxAgeMs) {
        fail("agent_runtime_live_projector_heartbeat_stale", { instanceId: sameInstance, sessionId: proof.sessionId ?? null, ageMs, maxAgeMs });
      } else if (lastTerminalLifecycle && receivedAt(lastTerminalLifecycle) > receivedAt(proof)) {
        fail("agent_runtime_live_projector_detached", { instanceId: sameInstance, sessionId: proof.sessionId ?? null, lifecycleEvent: lastTerminalLifecycle.event });
      } else {
        process.stdout.write(`${JSON.stringify({
          ok: true,
          code: "agent_runtime_live_projector_ready",
          instanceId: sameInstance,
          sessionId: proof.sessionId ?? null,
          heartbeatAgeMs: ageMs,
          proofEvent: proof.event,
          observationUrl: baseUrl,
        })}\n`);
      }
    }
  } else if (mode === "observed") {
    if (!messageId) {
      fail("agent_runtime_live_projector_message_id_required");
    } else {
      const observed = latest(observations, (entry) => entry.event === "progress.live_delivery_observed" && entry.messageId === messageId);
      if (!observed) {
        fail("agent_runtime_live_delivery_not_observed", { messageId, instanceId, sessionId });
      } else {
        const ageMs = Math.max(0, Date.now() - receivedAt(observed));
        process.stdout.write(`${JSON.stringify({
          ok: true,
          code: "agent_runtime_live_delivery_observed",
          instanceId: observed.instanceId ?? null,
          sessionId: observed.sessionId ?? null,
          messageId: observed.messageId,
          projectionLatencyMs: observed.projectionLatencyMs ?? null,
          observationAgeMs: ageMs,
          observationUrl: baseUrl,
        })}\n`);
      }
    }
  } else if (mode === "dump" || has("dump")) {
    process.stdout.write(`${JSON.stringify({ ok: true, code: "agent_runtime_live_projector_observations", observations }, null, 2)}\n`);
  } else {
    fail("agent_runtime_live_projector_probe_mode_invalid", { mode });
  }
} catch (error) {
  fail("agent_runtime_live_projector_probe_failed", { error: error instanceof Error ? error.message : String(error), baseUrl });
}
