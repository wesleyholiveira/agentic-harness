import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, resolve } from "node:path";

function cleanName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "command";
}

export class ProcessRunner {
  constructor({ outputDir, baseEnv = process.env }) {
    this.outputDir = outputDir;
    this.logsDir = resolve(outputDir, "logs");
    this.baseEnv = { ...baseEnv };
    this.sequence = 0;
    mkdirSync(this.logsDir, { recursive: true });
  }

  logPath(label) {
    this.sequence += 1;
    return resolve(this.logsDir, `${String(this.sequence).padStart(3, "0")}-${cleanName(label)}.log`);
  }

  run(command, args = [], options = {}) {
    const label = options.label || basename(command);
    const logPath = this.logPath(label);
    const startedAt = new Date().toISOString();
    const cwd = options.cwd || process.cwd();
    const env = { ...this.baseEnv, ...(options.env || {}) };
    const timeout = options.timeoutMs ?? 0;
    const result = spawnSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      input: options.input,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      timeout,
      windowsHide: true,
      shell: false,
    });
    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    const exitCode = result.status ?? (result.error ? 1 : 0);
    const finishedAt = new Date().toISOString();
    writeFileSync(logPath, [
      `startedAt=${startedAt}`,
      `finishedAt=${finishedAt}`,
      `cwd=${cwd}`,
      `command=${command}`,
      `args=${JSON.stringify(args)}`,
      `exitCode=${exitCode}`,
      result.error ? `spawnError=${result.error.message}` : "",
      "--- stdout ---",
      stdout,
      "--- stderr ---",
      stderr,
    ].filter(Boolean).join("\n"), "utf8");
    const evidence = {
      command,
      args,
      cwd,
      exitCode,
      stdout,
      stderr,
      logPath,
      error: result.error?.message ?? null,
      signal: result.signal ?? null,
      startedAt,
      finishedAt,
    };
    const allowed = options.allowExitCodes ?? [0];
    if (!allowed.includes(exitCode)) {
      const error = new Error(`qualification_command_failed:${label}:${exitCode}`);
      error.code = "qualification_command_failed";
      error.evidence = evidence;
      throw error;
    }
    return evidence;
  }

  start(command, args = [], options = {}) {
    const label = options.label || basename(command);
    const logPath = this.logPath(label);
    const cwd = options.cwd || process.cwd();
    const env = { ...this.baseEnv, ...(options.env || {}) };
    writeFileSync(logPath, `startedAt=${new Date().toISOString()}\ncwd=${cwd}\ncommand=${command}\nargs=${JSON.stringify(args)}\n--- output ---\n`, "utf8");
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: false,
    });
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
      appendFileSync(logPath, `\nspawnError=${error.message}\n`, "utf8");
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk) => appendFileSync(logPath, chunk));
    }
    return { child, logPath, command, args, cwd, env, get spawnError() { return spawnError; } };
  }
}

export function terminateProcessTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    return;
  }
  try { child.kill("SIGTERM"); } catch {}
}
