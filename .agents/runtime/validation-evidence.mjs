import { spawn } from "node:child_process";
import { assertExecutableValidationCommands } from "./validation-command.mjs";

function runtimePassedCommands(handoff) {
  return new Set((handoff.validation ?? [])
    .filter((entry) => entry.authority === "runtime" && entry.phase === "final" && entry.blocking !== false && entry.result === "passed" && String(entry.evidence ?? "").trim())
    .map((entry) => entry.command));
}

/** Required commands are satisfied only by runtime-owned receipts. */
export function missingRequiredValidationCommands(brief, handoff) {
  assertExecutableValidationCommands(brief.validation ?? [], { label: "taskBrief.validation" });
  const passed = runtimePassedCommands(handoff);
  return [...new Set(brief.validation ?? [])].filter((command) => !passed.has(command));
}

function clipped(value, max = 12_000) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

export function runShellValidation(command, { workspace, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
    const args = isWindows ? ["/d", "/s", "/c", command] : ["-lc", command];
    const child = spawn(executable, args, { cwd: workspace, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      resolve({ exitCode: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut: false, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut: false, stdout, stderr });
    });
  });
}

/**
 * Materialize authoritative receipts for every Task Brief validation command.
 * Model-authored claims for those commands are discarded before execution, so a
 * specialist can never suppress the actual shell validation by writing "passed".
 */
export async function synthesizeRequiredValidationEvidence({
  workspace,
  brief,
  handoff,
  runner = runShellValidation,
  timeoutMs = Number(process.env.AGENT_HARNESS_AGENT_VALIDATION_TIMEOUT_MS ?? 600_000),
}) {
  assertExecutableValidationCommands(brief.validation ?? [], { label: "taskBrief.validation" });
  const commands = [...new Set(brief.validation ?? [])];
  if (handoff.status !== "complete" || commands.length === 0) return { handoff, attempted: false, commands: [], results: [] };

  const next = JSON.parse(JSON.stringify(handoff));
  const requiredSet = new Set(commands);
  next.validation = (next.validation ?? []).filter((entry) => !(requiredSet.has(entry.command) && entry.phase === "final" && entry.blocking !== false));
  const results = [];
  for (const command of commands) {
    const result = await runner(command, { workspace, timeoutMs });
    const passed = !result.timedOut && result.exitCode === 0;
    const evidence = [
      "runtime_validation_evidence",
      `exitCode=${result.exitCode ?? "null"}`,
      `timedOut=${result.timedOut === true}`,
      result.stdout ? `stdout=${clipped(result.stdout)}` : "",
      result.stderr ? `stderr=${clipped(result.stderr)}` : "",
    ].filter(Boolean).join("; ");
    const entry = {
      command,
      phase: "final",
      blocking: true,
      result: passed ? "passed" : "failed",
      evidence,
      authority: "runtime",
      exitCode: result.exitCode ?? null,
      timedOut: result.timedOut === true,
      executedAt: new Date().toISOString(),
    };
    next.validation.push(entry);
    results.push(entry);
  }
  next.findings = [
    ...(next.findings ?? []),
    {
      type: "runtime_validation_evidence",
      status: results.every((item) => item.result === "passed") ? "succeeded" : "failed",
      reason: "task_brief_required_validation_executed_authoritatively",
      commands,
    },
  ];
  return { handoff: next, attempted: true, commands, results };
}
