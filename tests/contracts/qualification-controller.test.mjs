import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("standalone qualification is a deterministic external controller, not the Main Orchestrator", () => {
  const publicLauncher = readFileSync(resolve(root, "bin/harness.mjs"), "utf8");
  const launcher = readFileSync(resolve(root, "scripts/harness-qualify.mjs"), "utf8");
  const controller = readFileSync(resolve(root, "scripts/qualification/standalone-v1.mjs"), "utf8");
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const main = JSON.parse(readFileSync(resolve(root, ".opencode/agents.generated.json"), "utf8"))["main-orchestrator"];

  assert.match(publicLauncher, /case "qualify": run\(process\.execPath, \[resolve\(harnessRoot, "scripts\/harness-qualify\.mjs"\), \.\.\.rest\]\)/);
  assert.match(launcher, /scripts["'],\s*["']qualification["'],\s*["']standalone-v1\.mjs/);
  assert.match(launcher, /spawnSync\(command, args,[\s\S]*?shell:\s*false/);
  assert.match(controller, /ProcessRunner/);
  assert.match(controller, /prompt_async/);
  assert.match(controller, /waitForRunId/);
  assert.doesNotMatch(controller, /context-engine_agent_start/);
  assert.doesNotMatch(controller, /requestJson\([^\n]*\/mcp/);

  assert.equal(Object.keys(pkg.scripts).length, 10);
  assert.equal(pkg.scripts["harness:qualify"], "node bin/harness.mjs qualify");
  assert.equal(main.permission.bash, "deny");
  assert.equal(main.permission.edit, "deny");
  assert.deepEqual(main.permission.task, { "*": "deny" });
  assert.equal(main.permission["serena_*"], "deny");
});

test("qualification controller self-test is shell-independent from the Main Orchestrator and emits a structured report", () => {
  const output = mkdtempSync(join(tmpdir(), "agentic-harness-qualification-selftest-"));
  try {
    const result = spawnSync(process.execPath, [resolve(root, "scripts/qualification/standalone-v1.mjs"), "--self-test", "--output", output], {
      cwd: root,
      env: { ...process.env, AGENT_HARNESS_ROOT: root },
      encoding: "utf8",
      shell: false,
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(resolve(output, "qualification-report.json"), "utf8"));
    assert.equal(report.contractVersion, "agentic-harness-standalone-qualification/v1");
    assert.equal(report.verdict, "PASS");
    assert.equal(report.firstDivergence, null);
    assert.equal(report.gates.find((gate) => gate.name === "Q-ENTRY")?.result, "PASS");
    assert.equal(report.gates.find((gate) => gate.name === "R-11")?.result, "PASS");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("qualification process runner resolves Windows .cmd shims without shell:true", async () => {
  const shimDir = mkdtempSync(join(tmpdir(), "agentic-harness-win-shim-"));
  try {
    const shim = resolve(shimDir, "npm.CMD");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(shim, "@echo off\r\n", "utf8");
    const { resolveSpawnInvocation } = await import("../../scripts/qualification/lib/process.mjs");
    const invocation = resolveSpawnInvocation("npm", ["ci"], {
      platform: "win32",
      env: {
        Path: shimDir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
    });
    assert.equal(invocation.resolvedCommand, shim);
    assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
    assert.equal(invocation.wrapper, "cmd.exe");
    assert.equal(invocation.windowsVerbatimArguments, true);
    assert.deepEqual(invocation.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
    assert.equal(invocation.args[4], `""${shim}" "ci""`);
    assert.doesNotMatch(invocation.args[4], /\bcall\b/i);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
  }
});


test("Windows batch invocation uses cmd /S /C outer quoting without backslash-escaped executable quotes", async () => {
  const { resolveSpawnInvocation } = await import("../../scripts/qualification/lib/process.mjs");
  const tempRoot = mkdtempSync(join(tmpdir(), "agentic-harness-win space-"));
  try {
    const { writeFileSync } = await import("node:fs");
    const shim = resolve(tempRoot, "npm.CMD");
    writeFileSync(shim, "@echo off\r\n", "utf8");
    const invocation = resolveSpawnInvocation("npm", ["--version"], {
      platform: "win32",
      env: {
        Path: tempRoot,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
    });
    assert.equal(invocation.windowsVerbatimArguments, true);
    assert.deepEqual(invocation.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
    assert.equal(invocation.args[4], `""${shim}" "--version""`);
    assert.doesNotMatch(invocation.args[4], /\\"/u);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
