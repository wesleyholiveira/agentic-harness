#!/usr/bin/env node

import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
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
