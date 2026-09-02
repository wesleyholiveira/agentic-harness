import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { pathToFileURL } from "node:url";

export const HEADROOM_VERSION = "0.36.5";
export const HEADROOM_PROXY_PACKAGE = `headroom-ai[proxy]==${HEADROOM_VERSION}`;
export const HEADROOM_UVX_ISOLATION_ARGS = ["--isolated", "--managed-python"];
export const HEADROOM_UVX_PYTHON_CANDIDATES = ["3.12", "3.13"];
export const HEADROOM_UVX_PYTHON = HEADROOM_UVX_PYTHON_CANDIDATES[0];

const DEFAULT_HEADROOM_PROXY_PORT = "8793";
const DEFAULT_PROXY_START_TIMEOUT_MS = 90_000;
const OUTER_PROVIDER_BASE_URL_KEYS = [
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "ANTHROPIC_BASE_URL",
  "GEMINI_BASE_URL",
  "GOOGLE_GEMINI_BASE_URL",
];

function parsePort(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`headroom_proxy_port_invalid:${normalized || "empty"}`);
  }
  const numeric = Number(normalized);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
    throw new Error(`headroom_proxy_port_invalid:${normalized}`);
  }
  return String(numeric);
}

function loopbackPort(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return null;
    if (url.port) return url.port;
    return url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : null;
  } catch {
    return null;
  }
}

export function resolveHeadroomProxyPort(baseEnv = process.env) {
  const port = parsePort(baseEnv.HEADROOM_PROXY_PORT ?? DEFAULT_HEADROOM_PROXY_PORT);
  const conflicts = OUTER_PROVIDER_BASE_URL_KEYS.flatMap((key) => {
    const inheritedPort = loopbackPort(baseEnv[key]);
    return inheritedPort === port ? [key] : [];
  });
  if (conflicts.length > 0) {
    throw new Error(
      `headroom_proxy_port_conflicts_with_outer_wrapper:${port}:${conflicts.join(",")}. ` +
        "Use a distinct HEADROOM_PROXY_PORT; repository default is 8793 and Caveman defaults to 8787.",
    );
  }
  return port;
}

function normalizeSavingsProfile(profile) {
  // `aggressive` is the repository-facing profile name retained for backwards
  // compatibility. Headroom's current built-ins are coding/balanced/agent-90/general.
  // Keep our historical 0.20 ratio but select Headroom's token-mode balanced base.
  return String(profile ?? "").trim().toLowerCase() === "aggressive" ? "balanced" : profile;
}

export function buildHeadroomEnvironment(baseEnv = process.env) {
  const {
    OPENCODE_CONFIG_CONTENT: _staleOpenCodeConfigContent,
    OPENAI_BASE_URL: outerOpenAiBaseUrl,
    OPENAI_API_BASE: outerOpenAiApiBase,
    ANTHROPIC_BASE_URL: outerAnthropicBaseUrl,
    GEMINI_BASE_URL: outerGeminiBaseUrl,
    GOOGLE_GEMINI_BASE_URL: outerGoogleGeminiBaseUrl,
    PYTHONHOME: _pythonHome,
    PYTHONPATH: _pythonPath,
    VIRTUAL_ENV: _virtualEnv,
    CONDA_PREFIX: _condaPrefix,
    CONDA_DEFAULT_ENV: _condaDefaultEnv,
    UV_SYSTEM_PYTHON: _uvSystemPython,
    UV_NO_MANAGED_PYTHON: _uvNoManagedPython,
    ...cleanEnv
  } = baseEnv;
  const port = resolveHeadroomProxyPort(baseEnv);
  const requestedProfile = baseEnv.HEADROOM_SAVINGS_PROFILE ?? "balanced";
  const profile = normalizeSavingsProfile(requestedProfile);

  const env = {
    ...cleanEnv,
    PYTHONSAFEPATH: "1",
    PYTHONIOENCODING: "utf-8",
    HEADROOM_PROXY_PORT: port,
    HEADROOM_PROXY_URL: `http://127.0.0.1:${port}`,
    HEADROOM_SAVINGS_PROFILE: profile,
    HEADROOM_TARGET_RATIO: baseEnv.HEADROOM_TARGET_RATIO ?? "0.20",
    HEADROOM_MIN_TOKENS: baseEnv.HEADROOM_MIN_TOKENS ?? "250",
    HEADROOM_TELEMETRY: baseEnv.HEADROOM_TELEMETRY ?? "off",
  };

  // Caveman owns the outer provider proxy. Headroom's direct proxy process does
  // not read OPENAI_BASE_URL/ANTHROPIC_BASE_URL as its upstream targets; it uses
  // *_TARGET_API_URL. Preserve the outer chain explicitly.
  if (!env.OPENAI_TARGET_API_URL) {
    const outerOpenAi = outerOpenAiBaseUrl || outerOpenAiApiBase;
    if (outerOpenAi && loopbackPort(outerOpenAi) !== port) env.OPENAI_TARGET_API_URL = outerOpenAi;
  }
  if (!env.ANTHROPIC_TARGET_API_URL) {
    const outerAnthropic = outerAnthropicBaseUrl;
    if (outerAnthropic && loopbackPort(outerAnthropic) !== port) env.ANTHROPIC_TARGET_API_URL = outerAnthropic;
  }
  if (!env.GEMINI_TARGET_API_URL) {
    const outerGemini = outerGeminiBaseUrl || outerGoogleGeminiBaseUrl;
    if (outerGemini && loopbackPort(outerGemini) !== port) env.GEMINI_TARGET_API_URL = outerGemini;
  }

  // The outer wrapper owns these provider-facing BASE_URL variables. Once their
  // values have been projected into Headroom's explicit *_TARGET_API_URL
  // upstream contract, they must not remain in the Headroom/OpenCode child
  // environment. Keeping both creates two competing routing authorities and can
  // make nested wrappers bypass or recursively re-enter the outer proxy.
  for (const key of OUTER_PROVIDER_BASE_URL_KEYS) delete env[key];

  return env;
}

export function buildHeadroomInvocation(headroomArgs, baseEnv = process.env, python = HEADROOM_UVX_PYTHON_CANDIDATES[0]) {
  const explicitBinary = String(baseEnv.HEADROOM_BINARY ?? "").trim();
  if (explicitBinary) {
    return {
      command: explicitBinary,
      args: [...headroomArgs],
      runtime: "explicit-binary",
      python: null,
    };
  }

  return {
    command: "uvx",
    args: [
      ...HEADROOM_UVX_ISOLATION_ARGS,
      "--python",
      python,
      "--from",
      HEADROOM_PROXY_PACKAGE,
      "headroom",
      ...headroomArgs,
    ],
    runtime: "uvx-pinned-proxy",
    python,
  };
}

export function buildHeadroomProxyInvocation(port, baseEnv = process.env, python = HEADROOM_UVX_PYTHON_CANDIDATES[0]) {
  return buildHeadroomInvocation(
    ["proxy", "--host", "127.0.0.1", "--port", String(port), "--no-telemetry"],
    baseEnv,
    python,
  );
}

export function buildHeadroomWrapInvocation(args, port, baseEnv = process.env, python = HEADROOM_UVX_PYTHON_CANDIDATES[0]) {
  return buildHeadroomInvocation(
    ["wrap", "opencode", "--no-proxy", "--port", String(port), "--no-mcp", "--no-serena", "--", ...args],
    baseEnv,
    python,
  );
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port: Number(port), exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function readiness(port, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.text();
    return /ready|healthy|ok/i.test(body) || body.trim() === "";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function attachCapture(child, output) {
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream?.on("data", (chunk) => {
      const text = chunk.toString();
      output.push(text);
      if (output.join("").length > 16_384) {
        const joined = output.join("").slice(-16_384);
        output.splice(0, output.length, joined);
      }
      target.write(chunk);
    });
  }
}

function terminateTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `taskkill /PID ${child.pid} /T /F >NUL 2>NUL`], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try { child.kill("SIGTERM"); } catch {}
}

export async function startHeadroomProxy({
  baseEnv = process.env,
  port = resolveHeadroomProxyPort(baseEnv),
  timeoutMs = Number(baseEnv.HEADROOM_PROXY_START_TIMEOUT_MS ?? DEFAULT_PROXY_START_TIMEOUT_MS),
  pythonCandidates = HEADROOM_UVX_PYTHON_CANDIDATES,
} = {}) {
  if (!(await isPortAvailable(port))) {
    throw new Error(`headroom_proxy_port_unavailable:${port}`);
  }

  const failures = [];
  for (const python of pythonCandidates) {
    const env = buildHeadroomEnvironment(baseEnv);
    const invocation = buildHeadroomProxyInvocation(port, baseEnv, python);
    const output = [];
    const child = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let spawnError = null;
    child.once("error", (error) => { spawnError = error; });
    attachCapture(child, output);

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (spawnError || child.exitCode !== null) break;
      if (await readiness(port)) {
        return { child, python, port: String(port), env, invocation, output };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    terminateTree(child);
    failures.push({
      python,
      output: output.join("").slice(-6_000),
      exitCode: child.exitCode,
      spawnError: spawnError?.message ?? null,
    });
    // Give Windows a short interval to release the port before trying a second managed Python.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const detail = failures
    .map((failure) => `python=${failure.python} exit=${failure.exitCode ?? "unknown"} spawnError=${failure.spawnError ?? "none"}\n${failure.output}`)
    .join("\n---\n");
  throw new Error(`headroom_pinned_proxy_failed_all_python_candidates:${pythonCandidates.join(",")}\n${detail}`);
}

export async function runHeadroomOpenCode(args = process.argv.slice(2), baseEnv = process.env) {
  let proxy;
  let port;
  try {
    port = resolveHeadroomProxyPort(baseEnv);
    console.log(`[headroom-opencode] starting pinned Headroom ${HEADROOM_VERSION} proxy on ${port}...`);
    proxy = await startHeadroomProxy({ baseEnv, port });
    console.log(`[headroom-opencode] proxy ready on ${port} using uv-managed Python ${proxy.python}.`);
  } catch (error) {
    console.error(`[headroom-opencode] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const cleanup = () => terminateTree(proxy.child);
  const signalHandler = () => {
    cleanup();
    process.exitCode = 130;
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);

  try {
    const invocation = buildHeadroomWrapInvocation(args, port, baseEnv, proxy.python);
    const child = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      env: proxy.env,
      stdio: "inherit",
      windowsHide: false,
      shell: false,
    });
    const status = await new Promise((resolve) => {
      child.once("error", (error) => {
        console.error(`[headroom-opencode] failed to launch ${invocation.command}: ${error.message}`);
        resolve(1);
      });
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
    });
    return status;
  } finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
    cleanup();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  process.exitCode = await runHeadroomOpenCode();
}
