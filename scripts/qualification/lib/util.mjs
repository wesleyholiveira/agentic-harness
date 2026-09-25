import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

export function randomId(prefix = "qualification") {
  return `${prefix}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

export async function allocatePort() {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

export const QUALIFICATION_PORT_MIN = 20_000;
export const QUALIFICATION_PORT_MAX = 29_999;
const QUALIFICATION_PORT_ALLOCATION_ATTEMPTS = 512;

async function allocateQualificationPort(used) {
  const span = QUALIFICATION_PORT_MAX - QUALIFICATION_PORT_MIN + 1;
  for (let attempt = 0; attempt < QUALIFICATION_PORT_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidate = QUALIFICATION_PORT_MIN + (randomBytes(4).readUInt32BE(0) % span);
    if (used.has(candidate)) continue;
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error(
    `qualification_port_bank_exhausted:${QUALIFICATION_PORT_MIN}-${QUALIFICATION_PORT_MAX}:${QUALIFICATION_PORT_ALLOCATION_ATTEMPTS}`,
  );
}

export async function allocatePortSet() {
  const names = ["postgres", "rabbitmq", "rabbitmqManagement", "redis", "embeddings", "contextEngine", "opencode", "headroom"];
  const ports = {};
  const used = new Set();
  for (const name of names) {
    const port = await allocateQualificationPort(used);
    used.add(port);
    ports[name] = port;
  }
  return ports;
}

export async function isPortFree(port) {
  return await new Promise((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePromise(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolvePromise(true)));
  });
}

export async function waitFor(predicate, {
  timeoutMs = 60_000,
  intervalMs = 500,
  label = "condition",
  shouldRetryError = () => true,
} = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      if (!shouldRetryError(error)) throw error;
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const error = new Error(`qualification_wait_timeout:${label}:${timeoutMs}`);
  error.cause = lastError;
  throw error;
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseJsonOutput(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) throw new Error("qualification_json_output_empty");
  try { return JSON.parse(trimmed); } catch {}
  const lines = trimmed.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error("qualification_json_output_invalid");
}

export function stripAnsi(value) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
}

export function nativeRealpath(path) {
  return resolve(typeof realpathSync.native === "function" ? realpathSync.native(path) : realpathSync(path));
}
