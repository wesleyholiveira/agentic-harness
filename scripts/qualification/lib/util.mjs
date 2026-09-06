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

export async function allocatePortSet() {
  const names = ["postgres", "rabbitmq", "rabbitmqManagement", "redis", "embeddings", "contextEngine", "opencode", "headroom"];
  const ports = {};
  const used = new Set();
  for (const name of names) {
    let port;
    do { port = await allocatePort(); } while (used.has(port));
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

export async function waitFor(predicate, { timeoutMs = 60_000, intervalMs = 500, label = "condition" } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
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
