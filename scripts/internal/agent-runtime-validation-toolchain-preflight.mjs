#!/usr/bin/env node

import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function parseVersion(value) {
  const match = String(value ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function minimumNodeVersion(engine) {
  const match = String(engine ?? "").trim().match(/^>=\s*(\d+\.\d+\.\d+)$/);
  return match ? parseVersion(match[1]) : null;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function commandExecutable(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*([^\s;&|]+)/u);
  return match?.[1] ?? null;
}

function npmScriptName(value) {
  const match = String(value ?? "").trim().match(/^(?:npm\s+run|npm\s+test(?:\s+--)?)\s+([^\s;&|]+)/u);
  if (!match) return String(value ?? "").trim() === "npm test" ? "test" : null;
  return match[1] === "--" ? "test" : match[1];
}

export function requiredValidationExecutables({ commands = [], packageJson = {} } = {}) {
  const required = new Set();
  const shellBuiltins = new Set(["cd", "export", "set", "test", "true", "false", "echo", "printf", "pwd"]);

  const visit = (command, seenScripts = new Set()) => {
    const normalized = String(command ?? "").trim();
    if (!normalized) return;

    const segments = normalized
      .split(/\s*(?:&&|\|\||;|\|(?!\|))\s*/u)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length > 1) {
      for (const segment of segments) visit(segment, seenScripts);
      return;
    }

    const scriptName = npmScriptName(normalized);
    if (scriptName) {
      required.add("npm");
      if (!seenScripts.has(scriptName)) {
        const script = packageJson?.scripts?.[scriptName];
        if (typeof script === "string" && script.trim()) {
          const nextSeen = new Set(seenScripts);
          nextSeen.add(scriptName);
          visit(script, nextSeen);
        }
      }
      return;
    }

    const executable = commandExecutable(normalized);
    if (!executable || shellBuiltins.has(executable)) return;
    if (executable === "python3") required.add("python");
    else if (executable === "python") required.add("python");
    else required.add(executable);
  };

  for (const command of commands ?? []) visit(command);
  return [...required].sort();
}

async function executableAvailable(executable, { env = process.env, platform = process.platform } = {}) {
  const names = platform === "win32"
    ? [`${executable}.exe`, `${executable}.cmd`, `${executable}.bat`, executable]
    : [executable];
  for (const directory of String(env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      if (await exists(join(directory, name))) return true;
    }
  }
  return false;
}

function validationCommandSegments({ commands = [], packageJson = {} } = {}) {
  const output = [];
  const visit = (command, seenScripts = new Set()) => {
    const normalized = String(command ?? "").trim();
    if (!normalized) return;

    const segments = normalized
      .split(/\s*(?:&&|\|\||;|\|(?!\|))\s*/u)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length > 1) {
      for (const segment of segments) visit(segment, seenScripts);
      return;
    }

    const scriptName = npmScriptName(normalized);
    if (scriptName) {
      const script = packageJson?.scripts?.[scriptName];
      if (typeof script === "string" && script.trim() && !seenScripts.has(scriptName)) {
        const nextSeen = new Set(seenScripts);
        nextSeen.add(scriptName);
        visit(script, nextSeen);
      } else {
        output.push(normalized);
      }
      return;
    }
    output.push(normalized);
  };
  for (const command of commands ?? []) visit(command);
  return output;
}

function pythonScriptPathFromCommand(command) {
  const normalized = String(command ?? "").trim();
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:python|python3)\b/u.test(normalized)) return null;
  const match = normalized.match(/\b(?:python|python3)\s+(?!-m\b)(?:"([^"]+\.py)"|'([^']+\.py)'|([^\s;&|]+\.py))/u);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

export async function discoverPythonRequirementFiles({ root = process.cwd(), commands = [] } = {}) {
  const repositoryRoot = resolve(root);
  let packageJson = {};
  try {
    packageJson = await readJson(join(repositoryRoot, "package.json"));
  } catch {}

  const candidates = new Set();
  for (const command of validationCommandSegments({ commands, packageJson })) {
    const scriptPath = pythonScriptPathFromCommand(command);
    if (!scriptPath) continue;
    const absoluteScript = resolve(repositoryRoot, scriptPath);
    if (!absoluteScript.startsWith(repositoryRoot)) continue;
    let current = dirname(absoluteScript);
    while (current.startsWith(repositoryRoot)) {
      for (const name of ["requirements.txt", "requirements-test.txt", "requirements-dev.txt"]) {
        const requirementPath = join(current, name);
        if (await exists(requirementPath)) candidates.add(requirementPath);
      }
      if (current === repositoryRoot) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...candidates].sort();
}

async function pythonToolchainFingerprint(requirementFiles, repositoryRoot) {
  const hash = createHash("sha256");
  hash.update("agent-runtime-python-toolchain/v1\0");
  for (const path of requirementFiles) {
    const rel = relative(repositoryRoot, path).replaceAll("\\", "/");
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function runToolchainCommand(command, args, { env = process.env } = {}) {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error ?? null,
  };
}

async function acquireDirectoryLock(lockPath, readyPath, {
  timeoutMs = 900_000,
  pollMs = 500,
  sleepFn = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
} = {}) {
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      return { acquired: true };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await exists(readyPath)) return { acquired: false };
      if (Date.now() - started >= timeoutMs) {
        const timeout = new Error(`validation_python_toolchain_lock_timeout:${lockPath}`);
        timeout.code = "validation_python_toolchain_lock_timeout";
        throw timeout;
      }
      await sleepFn(pollMs);
    }
  }
}

export async function prepareValidationCommandToolchain({
  root = process.cwd(),
  commands = [],
  env = process.env,
  platform = process.platform,
  availability = executableAvailable,
  commandRunner = runToolchainCommand,
  toolchainRoot = env.AGENT_HARNESS_AGENT_WORKSPACE_ROOT
    ? join(env.AGENT_HARNESS_AGENT_WORKSPACE_ROOT, ".toolchains")
    : join(repositoryRootFallback(), ".agent-harness-toolchains"),
} = {}) {
  const inspected = await inspectValidationCommandToolchain({
    root,
    commands,
    env,
    platform,
    availability,
  });
  if (!inspected.ok) return { ...inspected, environment: {} };
  if (!inspected.requiredExecutables.includes("python")) {
    return { ...inspected, environment: {}, python: null };
  }

  const repositoryRoot = resolve(root);
  const requirementFiles = await discoverPythonRequirementFiles({ root: repositoryRoot, commands });
  if (requirementFiles.length === 0) {
    return {
      ...inspected,
      environment: {},
      python: {
        mode: "system",
        requirementFiles: [],
        fingerprint: null,
        venvPath: null,
      },
    };
  }

  const fingerprint = await pythonToolchainFingerprint(requirementFiles, repositoryRoot);
  const venvPath = join(resolve(toolchainRoot), "python", fingerprint);
  const readyPath = join(venvPath, ".ready");
  const lockPath = `${venvPath}.lock`;
  const binDir = platform === "win32" ? join(venvPath, "Scripts") : join(venvPath, "bin");
  const pythonPath = platform === "win32" ? join(binDir, "python.exe") : join(binDir, "python");

  await mkdir(dirname(venvPath), { recursive: true });
  if (!(await exists(readyPath))) {
    const lock = await acquireDirectoryLock(lockPath, readyPath);
    if (lock.acquired) {
      try {
        await rm(venvPath, { recursive: true, force: true });
        const created = commandRunner("python", ["-m", "venv", venvPath], { env });
        if (created.status !== 0) {
          return {
            ...inspected,
            ok: false,
            code: "agent_runtime_validation_python_venv_failed",
            failures: [created.stderr || created.stdout || String(created.error ?? "python_venv_failed")],
            environment: {},
            python: { mode: "venv", requirementFiles, fingerprint, venvPath },
          };
        }
        const installArgs = [
          "-m", "pip", "install", "--disable-pip-version-check",
          ...requirementFiles.flatMap((path) => ["-r", path]),
        ];
        const installed = commandRunner(pythonPath, installArgs, {
          env: {
            ...env,
            PIP_CACHE_DIR: env.PIP_CACHE_DIR
              ?? join(resolve(toolchainRoot), "pip-cache"),
          },
        });
        if (installed.status !== 0) {
          return {
            ...inspected,
            ok: false,
            code: "agent_runtime_validation_python_requirements_failed",
            failures: [installed.stderr || installed.stdout || String(installed.error ?? "python_requirements_failed")],
            environment: {},
            python: { mode: "venv", requirementFiles, fingerprint, venvPath },
          };
        }
        await writeFile(readyPath, "ready\n", "utf8");
      } finally {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  if (!(await exists(readyPath)) || !(await exists(pythonPath))) {
    return {
      ...inspected,
      ok: false,
      code: "agent_runtime_validation_python_toolchain_unavailable",
      failures: ["python_toolchain_not_materialized"],
      environment: {},
      python: { mode: "venv", requirementFiles, fingerprint, venvPath },
    };
  }

  return {
    ...inspected,
    environment: {
      VIRTUAL_ENV: venvPath,
      PATH: `${binDir}${delimiter}${env.PATH ?? ""}`,
      PIP_CACHE_DIR: env.PIP_CACHE_DIR ?? join(resolve(toolchainRoot), "pip-cache"),
    },
    python: {
      mode: "venv",
      requirementFiles,
      fingerprint,
      venvPath,
    },
  };
}

function repositoryRootFallback() {
  return process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
}

export async function inspectValidationCommandToolchain({
  root = process.cwd(),
  commands = [],
  env = process.env,
  platform = process.platform,
  availability = executableAvailable,
} = {}) {
  const repositoryRoot = resolve(root);
  let packageJson = {};
  try {
    packageJson = await readJson(join(repositoryRoot, "package.json"));
  } catch {
    // A repository without package.json can still use direct validation commands.
  }

  const requiredExecutables = requiredValidationExecutables({ commands, packageJson });
  const missingExecutables = [];
  for (const executable of requiredExecutables) {
    if (!(await availability(executable, { env, platform }))) missingExecutables.push(executable);
  }

  return {
    ok: missingExecutables.length === 0,
    code: missingExecutables.length === 0
      ? "agent_runtime_validation_command_toolchain_ready"
      : "agent_runtime_validation_command_toolchain_unavailable",
    repositoryRoot,
    requiredExecutables,
    missingExecutables,
    remediation: missingExecutables.length > 0
      ? `rebuild_agent_runtime_worker_with_required_executables:${missingExecutables.join(",")}`
      : null,
  };
}

export async function inspectAgentRuntimeValidationToolchain({
  root = process.cwd(),
  nodeVersion = process.versions.node,
  platform = process.platform,
} = {}) {
  const repositoryRoot = resolve(root);
  const failures = [];
  let packageJson;
  let packageLock;

  try {
    packageJson = await readJson(join(repositoryRoot, "package.json"));
  } catch (error) {
    return {
      ok: false,
      code: "agent_runtime_validation_package_json_unavailable",
      repositoryRoot,
      failures: [String(error?.message ?? error)],
    };
  }

  try {
    packageLock = await readJson(join(repositoryRoot, "package-lock.json"));
  } catch (error) {
    return {
      ok: false,
      code: "agent_runtime_validation_lockfile_unavailable",
      repositoryRoot,
      failures: [String(error?.message ?? error)],
    };
  }

  const requiredNode = minimumNodeVersion(packageJson.engines?.node);
  const actualNode = parseVersion(nodeVersion);
  if (!requiredNode || !actualNode || compareVersions(actualNode, requiredNode) < 0) {
    failures.push(`node_version_mismatch:required=${packageJson.engines?.node ?? "unknown"}:actual=${nodeVersion}`);
  }

  const declaredVitest = packageJson.devDependencies?.vitest ?? null;
  const lockedDeclaration = packageLock.packages?.[""]?.devDependencies?.vitest ?? null;
  const lockedVitest = packageLock.packages?.["node_modules/vitest"]?.version ?? null;
  if (!declaredVitest) failures.push("vitest_not_declared_in_devDependencies");
  if (!lockedDeclaration) failures.push("vitest_not_declared_in_lockfile_root");
  if (declaredVitest && lockedDeclaration && declaredVitest !== lockedDeclaration) {
    failures.push(`vitest_lock_declaration_mismatch:package=${declaredVitest}:lock=${lockedDeclaration}`);
  }
  if (!lockedVitest) failures.push("vitest_not_resolved_in_lockfile");

  const materializedPackagePath = join(repositoryRoot, "node_modules", "vitest", "package.json");
  let materializedVitest = null;
  if (await exists(materializedPackagePath)) {
    try {
      materializedVitest = (await readJson(materializedPackagePath)).version ?? null;
    } catch (error) {
      failures.push(`vitest_materialized_package_invalid:${String(error?.message ?? error)}`);
    }
  } else {
    failures.push("vitest_not_materialized");
  }

  if (lockedVitest && materializedVitest && lockedVitest !== materializedVitest) {
    failures.push(`vitest_materialized_version_mismatch:lock=${lockedVitest}:materialized=${materializedVitest}`);
  }

  const binaryName = platform === "win32" ? "vitest.cmd" : "vitest";
  const binaryPath = join(repositoryRoot, "node_modules", ".bin", binaryName);
  if (!(await exists(binaryPath))) failures.push(`vitest_binary_not_materialized:${binaryName}`);

  let nodeModulesRealPath = null;
  try {
    nodeModulesRealPath = await realpath(join(repositoryRoot, "node_modules"));
  } catch {
    failures.push("node_modules_not_materialized");
  }

  if (failures.length > 0) {
    return {
      ok: false,
      code: "agent_runtime_validation_toolchain_unavailable",
      repositoryRoot,
      nodeVersion,
      requiredNode: packageJson.engines?.node ?? null,
      vitest: {
        declared: declaredVitest,
        lockedDeclaration,
        locked: lockedVitest,
        materialized: materializedVitest,
        binaryPath,
      },
      nodeModulesRealPath,
      failures,
      remediation: "rebuild_and_restart_agent_runtime_with_dev_dependencies",
    };
  }

  return {
    ok: true,
    code: "agent_runtime_validation_toolchain_ready",
    repositoryRoot,
    nodeVersion,
    requiredNode: packageJson.engines?.node ?? null,
    vitest: {
      declared: declaredVitest,
      lockedDeclaration,
      locked: lockedVitest,
      materialized: materializedVitest,
      binaryPath,
    },
    nodeModulesRealPath,
  };
}

async function main() {
  const result = await inspectAgentRuntimeValidationToolchain();
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await main();
}
