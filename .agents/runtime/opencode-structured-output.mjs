import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { validateAgainstSchema } from "./schema-validator.mjs";

export const STRUCTURED_AGENT_ID = "runtime-structured-projector";

function splitModelId(value) {
  const model = String(value ?? "").trim();
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) throw new Error(`opencode_structured_model_invalid:${model}`);
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function extractStructuredOutput(response) {
  const candidates = [
    response?.info?.structured_output,
    response?.info?.structuredOutput,
    response?.info?.structured,
    response?.data?.info?.structured_output,
    response?.data?.info?.structuredOutput,
    response?.data?.info?.structured,
    response?.structured_output,
    response?.structuredOutput,
    response?.structured,
  ];
  return candidates.find((value) => value !== undefined && value !== null) ?? null;
}

async function reserveFreePort(hostname = "127.0.0.1") {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function fetchJson(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { connection: "close", ...(options.headers ?? {}) };
    const response = await fetch(url, { ...options, headers, signal: controller.signal });
    const text = await response.text();
    let body = null;
    if (text.trim()) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    if (!response.ok) throw new Error(`opencode_structured_http_${response.status}:${typeof body === "string" ? body.slice(0, 2_000) : JSON.stringify(body).slice(0, 2_000)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function structuredTestBaseUrl(env = process.env) {
  const enabled = String(env.AGENT_HARNESS_RUNTIME_TEST_MODE ?? "").trim().toLowerCase();
  const raw = String(env.AGENT_HARNESS_OPENCODE_STRUCTURED_TEST_BASE_URL ?? "").trim();
  if (!raw || !["1", "true", "yes", "on"].includes(enabled)) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("opencode_structured_test_base_url_invalid"); }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("opencode_structured_test_base_url_must_be_loopback_http");
  }
  return parsed.origin;
}

async function waitForHealth({ baseUrl, timeoutMs, stderr }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`${baseUrl}/global/health`, {}, Math.min(2_000, Math.max(250, deadline - Date.now())));
      if (health?.healthy === true) return health;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`opencode_structured_server_not_ready:${lastError?.message ?? "timeout"}:${stderr()}`);
}

function signalStructuredProcessTree(child, signal) {
  if (!child) return false;
  if (process.platform !== "win32" && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      // Structured OpenCode servers are started in their own process group. Kill
      // the group so a provider/helper inheriting stderr cannot keep the parent
      // adapter alive after the server process itself exits.
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        // Fall through to ChildProcess.kill for platforms/runtimes where process
        // groups are unavailable despite detached spawn.
      }
    }
  }
  try { return child.kill(signal); } catch { return false; }
}

export async function stopStructuredProcess(child, { graceMs = 2_000, killWaitMs = 2_000 } = {}) {
  if (!child) return { terminated: true, forced: false };
  let closed = false;
  const closedPromise = new Promise((resolve) => {
    const onClose = () => { closed = true; resolve(true); };
    child.once("close", onClose);
  });
  if (child.exitCode !== null || child.signalCode !== null) {
    // `exit` is not sufficient for adapter shutdown: inherited stdio can keep the
    // parent event loop alive. Give `close` a bounded chance, then destroy our pipe.
    const alreadyClosed = await Promise.race([closedPromise, sleep(50).then(() => false)]);
    if (!alreadyClosed) child.stderr?.destroy?.();
    return { terminated: true, forced: false };
  }

  signalStructuredProcessTree(child, "SIGTERM");
  const graceful = await Promise.race([closedPromise, sleep(Math.max(0, Number(graceMs) || 0)).then(() => false)]);
  if (graceful) return { terminated: true, forced: false };

  signalStructuredProcessTree(child, "SIGKILL");
  const killed = await Promise.race([closedPromise, sleep(Math.max(0, Number(killWaitMs) || 0)).then(() => false)]);
  if (!killed) {
    // Never let an inherited pipe hold the executor open indefinitely after the
    // process group has been force-killed.
    child.stderr?.destroy?.();
    child.stdout?.destroy?.();
    child.unref?.();
  }
  return { terminated: Boolean(killed || child.exitCode !== null || child.signalCode !== null), forced: true };
}

export function buildStructuredRuntimeOverride({ agentId, steps = Number(process.env.AGENT_HARNESS_TECHNICAL_PLAN_SYNTHESIS_STEPS ?? 8) }) {
  const selectedAgentId = STRUCTURED_AGENT_ID;
  return {
    default_agent: selectedAgentId,
    agent: {
      [selectedAgentId]: {
        mode: "primary",
        steps: Number(steps),
        temperature: 0,
        // Auxiliary structured passes are pure semantic projections. Replace the
        // specialist's normal implementation prompt and explicitly deny every
        // tool family that could mutate or inspect the workspace.
        prompt: "You are a bounded JSON-schema projection engine. Use only the evidence embedded in the user prompt. Never call tools, inspect files, edit state, ask questions, or infer missing evidence.",
        permission: {
          // OpenCode merges project configuration with this override. The wildcard
          // closes every built-in, custom and MCP-provided tool by default; the
          // explicit entries document the high-risk families and protect older
          // OpenCode builds that do not apply wildcard matching uniformly.
          "*": "deny",
          // OpenCode implements json_schema output through an internal
          // StructuredOutput tool. Current builds apply wildcard permissions to
          // that internal tool as well, so explicitly allow exactly this one
          // non-workspace capability while every mutating/inspection tool stays
          // denied.
          StructuredOutput: "allow",
          question: "deny",
          bash: "deny",
          edit: "deny",
          write: "deny",
          read: "deny",
          glob: "deny",
          grep: "deny",
          list: "deny",
          lsp: "deny",
          webfetch: "deny",
          websearch: "deny",
          todowrite: "deny",
          external_directory: "deny",
          doom_loop: "deny",
          task: { "*": "deny" },
          skill: { "*": "deny" },
        },
      },
    },
    mcp: {
      serena: { enabled: false },
      "codebase-memory-mcp": { enabled: false },
      headroom: { enabled: false },
      context7: { enabled: false },
      "context-engine": { enabled: false },
    },
    plugin: [],
  };
}

export function buildStructuredPromptBody({ model, agentId, schema, prompt, retryCount = 0 }) {
  const parsedRetryCount = Number(retryCount);
  const normalizedRetryCount = Number.isInteger(parsedRetryCount) && parsedRetryCount >= 0 ? parsedRetryCount : 0;
  return {
    model: splitModelId(model),
    agent: String(agentId),
    parts: [{ type: "text", text: String(prompt) }],
    format: { type: "json_schema", schema, retryCount: normalizedRetryCount },
  };
}

function responseInfo(response) {
  return response?.info ?? response?.data?.info ?? null;
}

function structuredResponseError(response) {
  const error = response?.info?.error ?? response?.data?.info?.error ?? null;
  return error ? JSON.stringify(error).slice(0, 2_000) : "no_structured_output";
}


function responseText(response) {
  const roots = [response, response?.data].filter(Boolean);
  const texts = [];
  for (const root of roots) {
    for (const part of root?.parts ?? []) {
      if (!part || typeof part !== "object") continue;
      if (part.type && !["text", "output_text", "assistant_text"].includes(String(part.type))) continue;
      if (typeof part.text === "string" && part.text.trim()) texts.push(part.text.trim());
      else if (typeof part.content === "string" && part.content.trim()) texts.push(part.content.trim());
    }
    if (typeof root?.text === "string" && root.text.trim()) texts.push(root.text.trim());
  }
  return texts.join("\n").trim();
}

function balancedTopLevelJsonObjects(value) {
  const source = String(value ?? "");
  const objects = [];
  let start = null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== null) {
        objects.push(source.slice(start, index + 1));
        start = null;
      }
    }
  }
  return objects;
}

function schemaValidatedTextProjection(response, schema) {
  const text = responseText(response);
  if (!text) return { value: null, error: "text_projection_missing" };
  const candidates = [text, ...balancedTopLevelJsonObjects(text)];
  const seen = new Set();
  const errors = [];
  for (const candidate of candidates.reverse()) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const value = JSON.parse(candidate);
      const validation = validateAgainstSchema(value, schema, "textProjection");
      if (validation.valid) return { value, error: null };
      errors.push(`schema:${validation.errors.join("; ")}`);
    } catch (error) {
      errors.push(`json:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { value: null, error: `text_projection_invalid:${errors.slice(-3).join(" | ")}` };
}

function buildTextProjectionPromptBody({ model, agentId, schema, prompt, attempt, maxAttempts }) {
  return {
    model: splitModelId(model),
    agent: String(agentId),
    parts: [{
      type: "text",
      text: `${String(prompt)}\n\nTEXT JSON FALLBACK ${attempt}/${maxAttempts}: OpenCode's StructuredOutput channel did not yield a usable value. Return ONLY one JSON object matching this schema exactly, with no markdown or prose. Do not call tools.\nSCHEMA:\n${JSON.stringify(schema)}`,
    }],
    format: { type: "text" },
  };
}

function aggregateStructuredInfo(infos) {
  const available = infos.filter((info) => info && typeof info === "object");
  if (available.length === 0) return null;
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const info of available) {
    const tokens = info.tokens ?? info.usage?.tokens ?? null;
    totals.input += Number(tokens?.input ?? info.usage?.inputTokens ?? 0);
    totals.output += Number(tokens?.output ?? info.usage?.outputTokens ?? 0);
    totals.reasoning += Number(tokens?.reasoning ?? 0);
    totals.cacheRead += Number(tokens?.cache?.read ?? info.usage?.cachedInputTokens ?? 0);
    totals.cacheWrite += Number(tokens?.cache?.write ?? 0);
    totals.cost += Number(info.cost ?? info.usage?.costUsd ?? 0);
  }
  return {
    ...available.at(-1),
    tokens: {
      input: totals.input,
      output: totals.output,
      reasoning: totals.reasoning,
      cache: { read: totals.cacheRead, write: totals.cacheWrite },
    },
    cost: totals.cost,
    structuredAttempts: available.length,
  };
}

export async function requestStructuredOutputWithRetries({
  baseUrl,
  sessionId,
  headers,
  model,
  agentId,
  schema,
  prompt,
  promptTimeoutMs,
  maxAttempts = 2,
  textFallbackAttempts = 1,
  fetcher = fetchJson,
}) {
  const parsedMaxAttempts = Number(maxAttempts);
  const boundedMaxAttempts = Number.isInteger(parsedMaxAttempts) && parsedMaxAttempts >= 1
    ? Math.min(parsedMaxAttempts, 4)
    : 2;
  const failures = [];
  const infos = [];
  for (let attempt = 1; attempt <= boundedMaxAttempts; attempt += 1) {
    const attemptPrompt = attempt === 1
      ? String(prompt)
      : `${String(prompt)}\n\nSTRUCTURED OUTPUT RETRY ${attempt}/${boundedMaxAttempts}: the previous response did not produce a usable schema-constrained value. Return the requested structured value now; do not call any other tool or add prose.`;
    try {
      const response = await fetcher(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify(buildStructuredPromptBody({ model, agentId, schema, prompt: attemptPrompt, retryCount: 0 })),
      }, promptTimeoutMs);
      const info = responseInfo(response);
      if (info) infos.push(info);
      const value = extractStructuredOutput(response);
      if (value !== null) {
        const validation = validateAgainstSchema(value, schema, "structuredOutput");
        if (validation.valid) {
          return {
            value,
            info: aggregateStructuredInfo(infos),
            attempts: attempt,
            failures,
            response,
          };
        }
        failures.push({
          attempt,
          error: `opencode_structured_output_schema_invalid:${validation.errors.join("; ")}`,
        });
      } else {
        failures.push({ attempt, error: `opencode_structured_output_missing:${structuredResponseError(response)}` });
      }
    } catch (error) {
      failures.push({ attempt, error: error instanceof Error ? error.message : String(error) });
    }
    if (attempt < boundedMaxAttempts) await sleep(Math.min(1_000, 150 * attempt));
  }
  const parsedFallbackAttempts = Number(textFallbackAttempts);
  const boundedFallbackAttempts = Number.isInteger(parsedFallbackAttempts) && parsedFallbackAttempts > 0
    ? Math.min(parsedFallbackAttempts, 2)
    : 0;
  for (let fallbackAttempt = 1; fallbackAttempt <= boundedFallbackAttempts; fallbackAttempt += 1) {
    const attempt = boundedMaxAttempts + fallbackAttempt;
    try {
      const response = await fetcher(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify(buildTextProjectionPromptBody({
          model, agentId, schema, prompt, attempt: fallbackAttempt, maxAttempts: boundedFallbackAttempts,
        })),
      }, promptTimeoutMs);
      const info = responseInfo(response);
      if (info) infos.push(info);
      const projection = schemaValidatedTextProjection(response, schema);
      if (projection.value !== null) {
        return {
          value: projection.value,
          info: aggregateStructuredInfo(infos),
          attempts: attempt,
          failures,
          response,
          fallback: "text-json",
        };
      }
      failures.push({ attempt, error: projection.error });
    } catch (error) {
      failures.push({ attempt, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const error = new Error(`opencode_structured_output_failed:${failures.map((item) => `attempt-${item.attempt}:${item.error}`).join(" | ")}`);
  error.failures = failures;
  error.info = aggregateStructuredInfo(infos);
  throw error;
}

export async function runOpenCodeStructuredOutput({
  workspace,
  model,
  agentId,
  schema,
  prompt,
  title = "Agentic Harness structured output",
  startTimeoutMs = Number(process.env.AGENT_HARNESS_OPENCODE_STRUCTURED_START_TIMEOUT_MS ?? 30_000),
  promptTimeoutMs = Number(process.env.AGENT_HARNESS_OPENCODE_STRUCTURED_PROMPT_TIMEOUT_MS ?? 180_000),
  retryCount = null,
  maxAttempts = null,
  env = process.env,
}) {
  const invocationStartedMs = Date.now();
  const invocationStartedAt = new Date(invocationStartedMs).toISOString();
  const testBaseUrl = structuredTestBaseUrl(env);
  const port = testBaseUrl ? null : await reserveFreePort();
  const baseUrl = testBaseUrl ?? `http://127.0.0.1:${port}`;
  let stderrText = "";
  const runtimeAgentId = STRUCTURED_AGENT_ID;
  const structuredOverride = buildStructuredRuntimeOverride({ agentId: runtimeAgentId });
  const child = testBaseUrl ? null : spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace,
    env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(structuredOverride) },
    stdio: ["ignore", "ignore", "pipe"],
    // On POSIX isolate the auxiliary server and every helper it spawns in one
    // process group so bounded shutdown can terminate the whole tree.
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  child?.stderr?.on("data", (chunk) => {
    stderrText = `${stderrText}${chunk.toString()}`.slice(-16_000);
  });
  const spawnError = child ? new Promise((_, reject) => child.once("error", reject)) : null;
  const prematureExit = child ? new Promise((_, reject) => child.once("exit", (code, signal) => {
    reject(new Error(`opencode_structured_server_exited_before_ready:code=${code ?? "null"}:signal=${signal ?? "null"}:${stderrText.slice(-4_000)}`));
  })) : null;
  try {
    const readiness = [waitForHealth({ baseUrl, timeoutMs: startTimeoutMs, stderr: () => stderrText.slice(-4_000) })];
    if (spawnError) readiness.push(spawnError);
    if (prematureExit) readiness.push(prematureExit);
    await Promise.race(readiness);
    const headers = { "content-type": "application/json", "x-opencode-directory": workspace };
    const sessionResponse = await fetchJson(`${baseUrl}/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title }),
    }, 15_000);
    const sessionId = sessionResponse?.id ?? sessionResponse?.data?.id;
    if (!sessionId) throw new Error("opencode_structured_session_id_missing");
    const configuredRetryBudget = Number(retryCount ?? env.AGENT_HARNESS_OPENCODE_STRUCTURED_RETRY_COUNT ?? 1);
    const configuredMaxAttempts = Number(maxAttempts ?? env.AGENT_HARNESS_OPENCODE_STRUCTURED_MAX_ATTEMPTS
      ?? (Number.isInteger(configuredRetryBudget) && configuredRetryBudget >= 0 ? configuredRetryBudget + 1 : 2));
    const structured = await requestStructuredOutputWithRetries({
      baseUrl,
      sessionId,
      headers,
      model,
      agentId: runtimeAgentId,
      schema,
      prompt,
      promptTimeoutMs,
      maxAttempts: configuredMaxAttempts,
    });
    const invocationCompletedMs = Date.now();
    return {
      value: structured.value,
      sessionId,
      info: structured.info,
      attempts: structured.attempts,
      failures: structured.failures,
      fallback: structured.fallback ?? null,
      serverStderr: stderrText,
      agentId: runtimeAgentId,
      startedAt: invocationStartedAt,
      completedAt: new Date(invocationCompletedMs).toISOString(),
      wallMs: Math.max(0, invocationCompletedMs - invocationStartedMs),
    };
  } finally {
    if (child) await stopStructuredProcess(child);
  }
}

export { aggregateStructuredInfo, extractStructuredOutput, splitModelId, structuredTestBaseUrl };
