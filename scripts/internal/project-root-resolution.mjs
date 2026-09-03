import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalFilesystemIdentity } from "./compose-project-identity.mjs";

function isCanonicalSameOrDescendant(parentIdentity, childIdentity) {
  const parent = parentIdentity.endsWith("/") ? parentIdentity : `${parentIdentity}/`;
  return childIdentity === parentIdentity || childIdentity.startsWith(parent);
}

function looksLikeHarnessSourceRoot(candidateRoot) {
  try {
    const packageJsonPath = resolve(candidateRoot, "package.json");
    if (!existsSync(packageJsonPath)) return false;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (packageJson?.name !== "agentic-harness") return false;
    return [
      "SOURCE-OF-TRUTH.md",
      "bin/harness.mjs",
      ".agents/workflow.json",
    ].every((relativePath) => existsSync(resolve(candidateRoot, relativePath)));
  } catch {
    return false;
  }
}

/**
 * Resolve the consuming-project authority for the public launcher.
 *
 * AGENT_HARNESS_PROJECT_ROOT remains an explicit authority for host-driven
 * launches, but an inherited value that points back into AGENT_HARNESS_ROOT
 * must not override a real consumer cwd that contains this harness as a
 * submodule. That stale-self-root case is common when a qualification
 * controller launches a nested consumer from an environment already prepared
 * for the harness repository itself.
 */
export function resolveHarnessProjectRoot({
  harnessRoot,
  cwd = process.cwd(),
  environment = process.env,
} = {}) {
  if (!harnessRoot) throw new Error("harnessRoot is required");

  const resolvedHarnessRoot = resolve(harnessRoot);
  const resolvedCwd = resolve(cwd);
  const inheritedValue = environment.AGENT_HARNESS_PROJECT_ROOT?.trim();

  if (!inheritedValue) {
    return {
      projectRoot: resolvedCwd,
      source: "invocation-cwd",
      staleInheritedHarnessRootIgnored: false,
    };
  }

  const inheritedRoot = resolve(inheritedValue);
  const canonicalHarness = canonicalFilesystemIdentity(resolvedHarnessRoot);
  const canonicalCwd = canonicalFilesystemIdentity(resolvedCwd);
  const canonicalInherited = canonicalFilesystemIdentity(inheritedRoot);

  const cwdIsExternalConsumer = canonicalCwd !== canonicalHarness
    && isCanonicalSameOrDescendant(canonicalCwd, canonicalHarness)
    && existsSync(resolve(resolvedCwd, ".git"));
  const inheritedPointsIntoCurrentHarness = canonicalInherited === canonicalHarness
    || isCanonicalSameOrDescendant(canonicalHarness, canonicalInherited);
  const inheritedIsHarnessSource = inheritedPointsIntoCurrentHarness
    || looksLikeHarnessSourceRoot(inheritedRoot);

  if (cwdIsExternalConsumer && inheritedIsHarnessSource) {
    return {
      projectRoot: resolvedCwd,
      source: "consumer-cwd-over-stale-harness-env",
      staleInheritedHarnessRootIgnored: true,
    };
  }

  return {
    projectRoot: inheritedRoot,
    source: "AGENT_HARNESS_PROJECT_ROOT",
    staleInheritedHarnessRootIgnored: false,
  };
}
