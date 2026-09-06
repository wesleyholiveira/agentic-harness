export function basicAuthHeaders(username, password) {
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}` };
}

function errorDetails(error) {
  if (!error || typeof error !== "object") return null;
  const details = {};
  for (const key of ["name", "message", "code", "errno", "syscall", "address", "port", "type"]) {
    const value = error[key];
    if (value !== undefined && value !== null) details[key] = value;
  }
  return details;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 15_000, allowStatuses = [200, 201, 202, 204] } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted || error?.name === "AbortError";
      const wrapped = new Error(
        timedOut
          ? `qualification_http_timeout:${method}:${url}:${timeoutMs}`
          : `qualification_http_transport_failed:${method}:${url}:${error instanceof Error ? error.message : String(error)}`,
      );
      wrapped.code = timedOut ? "qualification_http_timeout" : "qualification_http_transport_failed";
      wrapped.evidence = {
        url,
        method,
        timeoutMs,
        error: errorDetails(error),
        cause: errorDetails(error?.cause),
      };
      throw wrapped;
    }

    const raw = await response.text();
    let parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    }
    const result = {
      url,
      method,
      status: response.status,
      ok: response.ok,
      body: parsed,
      raw,
      headers: Object.fromEntries(response.headers.entries()),
    };
    if (!allowStatuses.includes(response.status)) {
      const error = new Error(`qualification_http_failed:${method}:${url}:${response.status}`);
      error.code = "qualification_http_failed";
      error.evidence = result;
      throw error;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableHttpError(error) {
  if (error?.code === "qualification_http_transport_failed" || error?.code === "qualification_http_timeout") return true;
  if (error?.code !== "qualification_http_failed") return false;
  const status = Number(error?.evidence?.status);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function summarizeFailure(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: error?.code ?? null,
    evidence: error?.evidence ?? null,
  };
}

export async function waitForJsonReady(url, {
  request = {},
  timeoutMs = 60_000,
  intervalMs = 1_000,
  label = "http-readiness",
} = {}) {
  const startedAt = Date.now();
  let attempts = 0;
  let lastFailure = null;

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    try {
      const response = await requestJson(url, request);
      return {
        response,
        attempts,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      lastFailure = summarizeFailure(error);
      if (!isRetryableHttpError(error)) {
        const rejected = new Error(`qualification_http_readiness_rejected:${label}:${url}`);
        rejected.code = "qualification_http_readiness_rejected";
        rejected.evidence = {
          label,
          url,
          attempts,
          elapsedMs: Date.now() - startedAt,
          lastFailure,
        };
        throw rejected;
      }
    }

    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    await sleep(Math.min(intervalMs, remainingMs));
  }

  const timeout = new Error(`qualification_http_readiness_timeout:${label}:${url}:${timeoutMs}`);
  timeout.code = "qualification_http_readiness_timeout";
  timeout.evidence = {
    label,
    url,
    attempts,
    timeoutMs,
    elapsedMs: Date.now() - startedAt,
    lastFailure,
  };
  throw timeout;
}
