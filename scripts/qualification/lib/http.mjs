export function basicAuthHeaders(username, password) {
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}` };
}

export async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 15_000, allowStatuses = [200, 201, 202, 204] } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    }
    const result = { status: response.status, ok: response.ok, body: parsed, raw, headers: Object.fromEntries(response.headers.entries()) };
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
