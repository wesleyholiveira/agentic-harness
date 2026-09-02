import { spawn } from "node:child_process";

export function runProcess(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    try { options.onSpawn?.({ pid: child.pid ?? null }); } catch {}
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); options.onStdout?.(chunk.toString()); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); options.onStderr?.(chunk.toString()); });
    let timedOut = false;
    let aborted = false;
    let timer = null;
    const terminate = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
    }
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ status: null, signal: null, stdout, stderr, error, timedOut, aborted });
    });
    child.on("close", (status, signal) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ status, signal, stdout, stderr, error: null, timedOut, aborted });
    });
  });
}
