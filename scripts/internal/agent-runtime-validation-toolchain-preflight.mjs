#!/usr/bin/env node

import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
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
