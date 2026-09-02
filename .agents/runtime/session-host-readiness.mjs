function normalizeUrl(value) {
  const raw = String(value ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("agent_session_host_url_invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("agent_session_host_url_invalid_or_credentialed");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}


function sessionHostAuthHeaders(environment = process.env) {
  const username = String(
    environment.AGENT_HARNESS_OPENCODE_CONTINUATION_USERNAME
      ?? environment.AGENT_HARNESS_AGENT_PROGRESS_USERNAME
      ?? environment.OPENCODE_SERVER_USERNAME
      ?? "",
  ).trim();
  const password = String(
    environment.AGENT_HARNESS_OPENCODE_CONTINUATION_PASSWORD
      ?? environment.AGENT_HARNESS_AGENT_PROGRESS_PASSWORD
      ?? environment.OPENCODE_SERVER_PASSWORD
      ?? "",
  );
  if (!username && !password) return { headers: {}, authSource: null };
  if (!username || !password) throw new Error("agent_session_host_basic_auth_incomplete");
  const authSource = environment.AGENT_HARNESS_OPENCODE_CONTINUATION_USERNAME != null
    || environment.AGENT_HARNESS_OPENCODE_CONTINUATION_PASSWORD != null
    ? "continuation"
    : environment.AGENT_HARNESS_AGENT_PROGRESS_USERNAME != null
      || environment.AGENT_HARNESS_AGENT_PROGRESS_PASSWORD != null
      ? "progress"
      : "opencode-server";
  return {
    headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
    authSource,
  };
}

export function resolveSessionHostProbeTarget(environment = process.env) {
  const deliveryUrl = normalizeUrl(environment.AGENT_HARNESS_OPENCODE_CONTINUATION_URL);
  const explicitProbeUrl = normalizeUrl(environment.AGENT_HARNESS_OPENCODE_CONTINUATION_HOST_PROBE_URL);
  if (!deliveryUrl && !explicitProbeUrl) return { deliveryUrl: null, probeUrl: null, translated: false };
  if (explicitProbeUrl) return { deliveryUrl, probeUrl: explicitProbeUrl, translated: explicitProbeUrl !== deliveryUrl };

  const parsed = new URL(deliveryUrl);
  const dockerOnlyHostnames = new Set(["host.docker.internal", "gateway.docker.internal"]);
  if (dockerOnlyHostnames.has(parsed.hostname.toLowerCase())) {
    parsed.hostname = "127.0.0.1";
    return {
      deliveryUrl,
      probeUrl: parsed.toString().replace(/\/$/, ""),
      translated: true,
    };
  }
  return { deliveryUrl, probeUrl: deliveryUrl, translated: false };
}

export async function probeSessionHost({ environment = process.env, fetchImpl = fetch, timeoutMs = 3_000 } = {}) {
  const required = !["0", "false", "no", "off"].includes(
    String(environment.AGENT_HARNESS_AGENT_CONTINUATION_REQUIRED ?? "false").toLowerCase(),
  );
  let target;
  try {
    target = resolveSessionHostProbeTarget(environment);
  } catch (error) {
    return {
      configured: true,
      required,
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
      deliveryEndpoint: null,
      probeEndpoint: null,
      endpoint: null,
      translated: false,
    };
  }
  if (!target.deliveryUrl) {
    return {
      configured: false,
      required,
      healthy: false,
      error: required ? "delivery_url_missing" : null,
      deliveryEndpoint: null,
      probeEndpoint: target.probeUrl ?? null,
      endpoint: target.probeUrl ?? null,
      translated: target.translated,
    };
  }
  const probe = new URL(target.probeUrl ?? target.deliveryUrl);
  probe.pathname = "/global/health";
  probe.search = "";
  let auth;
  try {
    auth = sessionHostAuthHeaders(environment);
  } catch (error) {
    return {
      configured: true,
      required,
      healthy: false,
      deliveryEndpoint: target.deliveryUrl,
      probeEndpoint: target.probeUrl,
      endpoint: target.probeUrl,
      translated: target.translated,
      authSource: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const started = Date.now();
  try {
    const response = await fetchImpl(probe, { headers: auth.headers, signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await response.json(); } catch {}
    return {
      configured: true,
      required,
      healthy: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
      deliveryEndpoint: target.deliveryUrl,
      probeEndpoint: target.probeUrl,
      endpoint: target.probeUrl,
      translated: target.translated,
      authSource: auth.authSource,
      version: body && typeof body === "object" ? body.version ?? null : null,
      error: response.ok ? null : `http_${response.status}`,
    };
  } catch (error) {
    return {
      configured: true,
      required,
      healthy: false,
      latencyMs: Date.now() - started,
      deliveryEndpoint: target.deliveryUrl,
      probeEndpoint: target.probeUrl,
      endpoint: target.probeUrl,
      translated: target.translated,
      authSource: auth.authSource,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
