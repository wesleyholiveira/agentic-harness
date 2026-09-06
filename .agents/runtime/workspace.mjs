import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { anyPatternMatches, exists, fileFingerprint, listFiles, normalizeRelativePath, removeIfExists, sameFileFingerprint, snapshotFiles, runtimeTaskDirectoryName } from "./utils.mjs";
import { runProcess } from "./process.mjs";
import { assertWorkspaceOutsideRepository, resolveAgentWorkspaceRoot } from "./event-driven-contracts.mjs";

const ignoredNames = new Set([".git", ".runtime", "dist", "release", "target"]);

const toolingSideEffectPatterns = [
  ".opencode/package.json",
  ".opencode/package-lock.json",
  ".opencode/npm-shrinkwrap.json",
  ".opencode/pnpm-lock.yaml",
  ".opencode/yarn.lock",
  ".opencode/bun.lock",
  ".opencode/bun.lockb",
  ".opencode/.cache/**",
];

export function isToolingSideEffectPath(path) {
  const normalized = String(path).replaceAll("\\", "/").replace(/^\.\//, "");
  return toolingSideEffectPatterns.some((pattern) => anyPatternMatches([pattern], normalized));
}

function normalizeDeclaredPaths(paths = []) {
  return [...new Set(paths.map((path) => String(path).replaceAll("\\", "/").replace(/^\.\//, "")).filter(Boolean))].sort();
}

async function verifyReusablePath(workspace, task, path, changedSet) {
  if (isToolingSideEffectPath(path)) return { path, valid: false, reason: "tooling_side_effect" };
  if (!anyPatternMatches(task.ownedPaths ?? [], path)) return { path, valid: false, reason: "ownership_violation" };
  if (changedSet.has(path)) return { path, valid: false, reason: "changed_in_attempt" };

  const workspacePath = join(workspace.path, path);
  const current = await fileFingerprint(workspacePath);
  if (!current) return { path, valid: false, reason: "missing_in_workspace" };

  if (workspace.mode === "worktree") {
    const baseline = await runProcess("git", ["cat-file", "-e", `HEAD:${path}`], { cwd: workspace.path });
    if (baseline.status !== 0) return { path, valid: false, reason: "missing_in_baseline" };
    const diff = await runProcess("git", ["diff", "--quiet", "HEAD", "--", path], { cwd: workspace.path });
    if (diff.status !== 0) return { path, valid: false, reason: "changed_in_attempt" };
    return { path, valid: true, fingerprint: current };
  }

  const baseline = workspace.baseline?.get(path) ?? null;
  if (!baseline) return { path, valid: false, reason: "missing_in_baseline" };
  if (!sameFileFingerprint(baseline, current)) return { path, valid: false, reason: "changed_in_attempt" };
  return { path, valid: true, fingerprint: current };
}

async function verifyReadOnlyContextPath(workspace, path, changedSet) {
  if (isToolingSideEffectPath(path)) return { path, valid: false, reason: "tooling_side_effect" };
  if (changedSet.has(path)) return { path, valid: false, reason: "changed_in_attempt" };

  const workspacePath = join(workspace.path, path);
  const current = await fileFingerprint(workspacePath);
  if (!current) return { path, valid: false, reason: "missing_in_workspace" };

  if (workspace.mode === "worktree") {
    const baseline = await runProcess("git", ["cat-file", "-e", `HEAD:${path}`], { cwd: workspace.path });
    if (baseline.status !== 0) return { path, valid: false, reason: "missing_in_baseline" };
    const diff = await runProcess("git", ["diff", "--quiet", "HEAD", "--", path], { cwd: workspace.path });
    if (diff.status !== 0) return { path, valid: false, reason: "changed_in_attempt" };
    return { path, valid: true, fingerprint: current };
  }

  const baseline = workspace.baseline?.get(path) ?? null;
  if (!baseline) return { path, valid: false, reason: "missing_in_baseline" };
  if (!sameFileFingerprint(baseline, current)) return { path, valid: false, reason: "changed_in_attempt" };
  return { path, valid: true, fingerprint: current };
}

export async function reconcileHandoffPathDisposition({ workspace, task, inspection, changedPaths = [], reusedPaths = [], contextReferencePaths = [] }) {
  const actualChanged = normalizeDeclaredPaths(inspection?.changedPaths ?? []);
  const actualSet = new Set(actualChanged);
  const declaredChanged = normalizeDeclaredPaths(changedPaths);
  const explicitReused = normalizeDeclaredPaths(reusedPaths);
  const contextReferences = new Set(normalizeDeclaredPaths(contextReferencePaths));
  const ghostDeclarations = declaredChanged.filter((path) => !actualSet.has(path));
  const normalizedChangedSet = new Set(declaredChanged.filter((path) => actualSet.has(path)));
  const reclassifiedReusedToChanged = [];
  const baselineDetectedChanges = [];
  const reuseCandidates = [];
  const verifiedReused = [];
  const verifiedContextOnly = [];
  const invalidReused = [];

  for (const path of explicitReused) {
    if (!actualSet.has(path)) {
      reuseCandidates.push(path);
      continue;
    }

    // Workspace inspection is authoritative for authorship disposition. If an
    // owned path was actually modified during this attempt, an LLM-side
    // reusedPaths misclassification is deterministic to repair as changedPaths.
    // We still fail closed for read-only/context or out-of-ownership mutations.
    const isOwned = anyPatternMatches(task.ownedPaths ?? [], path);
    if (isOwned) {
      normalizedChangedSet.add(path);
      reclassifiedReusedToChanged.push(path);
      continue;
    }

    if (contextReferences.has(path)) {
      const result = await verifyReadOnlyContextPath(workspace, path, actualSet);
      invalidReused.push(result);
      continue;
    }

    invalidReused.push({ path, valid: false, reason: "ownership_violation" });
  }

  reuseCandidates.push(...ghostDeclarations);

  for (const path of normalizeDeclaredPaths(reuseCandidates)) {
    const isOwned = anyPatternMatches(task.ownedPaths ?? [], path);
    if (!isOwned && contextReferences.has(path)) {
      const result = await verifyReadOnlyContextPath(workspace, path, actualSet);
      if (result.valid) verifiedContextOnly.push({ path, fingerprint: result.fingerprint });
      else invalidReused.push(result);
      continue;
    }
    const result = await verifyReusablePath(workspace, task, path, actualSet);
    if (result.valid) {
      verifiedReused.push({ path, fingerprint: result.fingerprint });
    } else if (isOwned && result.reason === "changed_in_attempt") {
      // The Rust change-set is a fast operational hint, not the final semantic
      // authority. A baseline fingerprint mismatch independently proves this
      // owned path changed even if the collector omitted it (for example when
      // a pre-existing dirty path is edited again inside a copied workspace).
      normalizedChangedSet.add(path);
      if (!reclassifiedReusedToChanged.includes(path)) reclassifiedReusedToChanged.push(path);
      if (!baselineDetectedChanges.includes(path)) baselineDetectedChanges.push(path);
    } else {
      invalidReused.push(result);
    }
  }

  const normalizedChanged = [...normalizedChangedSet].sort();
  const declaredChangedSet = new Set(normalizedChanged);
  const missingDeclaredChanges = actualChanged.filter((path) => !declaredChangedSet.has(path));
  return {
    changedPaths: normalizedChanged,
    reusedPaths: verifiedReused.map((entry) => entry.path),
    reusedPathFingerprints: verifiedReused,
    contextOnlyPaths: verifiedContextOnly.map((entry) => entry.path),
    contextOnlyPathFingerprints: verifiedContextOnly,
    ghostDeclarations,
    reclassifiedReusedToChanged,
    baselineDetectedChanges,
    invalidReused,
    missingDeclaredChanges,
  };
}

export function classifyWorkspaceChanges(paths) {
  const toolingSideEffects = [];
  const changedPaths = [];
  for (const path of paths) {
    if (isToolingSideEffectPath(path)) toolingSideEffects.push(path);
    else changedPaths.push(path);
  }
  return { changedPaths, toolingSideEffects };
}

async function canUseGitWorktree(repositoryRoot) {
  if (!(await exists(join(repositoryRoot, ".git")))) return false;
  const status = await runProcess("git", ["status", "--porcelain"], { cwd: repositoryRoot });
  return status.status === 0 && status.stdout.trim() === "";
}

async function copyRepository(repositoryRoot, workspacePath) {
  await mkdir(workspacePath, { recursive: true });

  // The runtime directory intentionally lives under the repository root. Node's
  // fs.cp rejects copying a directory into one of its own descendants before a
  // filter can exclude `.runtime` (EINVAL on Windows). Copy each top-level entry
  // instead, skipping runtime/build state before recursion begins.
  for (const entry of await readdir(repositoryRoot, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name) || entry.name === "node_modules") continue;
    const source = join(repositoryRoot, entry.name);
    const destination = join(workspacePath, entry.name);
    await cp(source, destination, {
      recursive: entry.isDirectory(),
      force: true,
      preserveTimestamps: true,
      filter(candidate) {
        const rel = normalizeRelativePath(repositoryRoot, candidate);
        return !rel.split("/").some((part) => ignoredNames.has(part) || part === "node_modules");
      },
    });
  }

  const sourceModules = join(repositoryRoot, "node_modules");
  const targetModules = join(workspacePath, "node_modules");
  if (await exists(sourceModules)) {
    try {
      await symlink(sourceModules, targetModules, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // Tests and source inspection remain available even when a shared dependency link is unavailable.
    }
  }
}

async function initializeCopyWorkspaceGit(workspacePath) {
  const init = await runProcess("git", ["init", "--quiet"], { cwd: workspacePath });
  if (init.status !== 0) throw new Error(`copy_workspace_git_init_failed:${init.stderr || init.stdout}`);
  const add = await runProcess("git", ["add", "-A"], { cwd: workspacePath });
  if (add.status !== 0) throw new Error(`copy_workspace_git_add_failed:${add.stderr || add.stdout}`);
  const commit = await runProcess("git", [
    "-c", "user.name=Agentic Harness Agent Runtime",
    "-c", "user.email=agent-runtime@agentic-harness.invalid",
    "commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "Agent Runtime workspace baseline",
  ], { cwd: workspacePath });
  if (commit.status !== 0) throw new Error(`copy_workspace_git_commit_failed:${commit.stderr || commit.stdout}`);
}

export async function createIsolatedWorkspace({ repositoryRoot, runDirectory, task, mode = "auto", workspacePath: explicitWorkspacePath = null }) {
  let selectedMode = mode;
  if (selectedMode === "auto") selectedMode = await canUseGitWorktree(repositoryRoot) ? "worktree" : "copy";
  if (selectedMode === "none") {
    const patterns = task.ownedPaths?.length > 0 ? task.ownedPaths : ["**"];
    return { mode: "none", path: repositoryRoot, baseline: await snapshotFiles(repositoryRoot, patterns), _snapshotPatterns: patterns };
  }
  const workspacePath = assertWorkspaceOutsideRepository(
    repositoryRoot,
    explicitWorkspacePath ?? join(resolveAgentWorkspaceRoot(repositoryRoot), runtimeTaskDirectoryName(task.taskId, task.agentId)),
  );
  await removeIfExists(workspacePath);
  if (selectedMode === "worktree") {
    const result = await runProcess("git", ["worktree", "add", "--detach", workspacePath, "HEAD"], { cwd: repositoryRoot });
    if (result.status !== 0) throw new Error(`worktree_create_failed:${result.stderr || result.stdout}`);
    return { mode: "worktree", path: workspacePath, baseline: null };
  }
  if (selectedMode !== "copy") throw new Error(`unsupported_workspace_mode:${selectedMode}`);
  await copyRepository(repositoryRoot, workspacePath);
  const baseline = await snapshotFiles(workspacePath, ["**"]);
  await initializeCopyWorkspaceGit(workspacePath);
  return { mode: "copy", path: workspacePath, baseline };
}

async function changedPathsForCopy(workspace, task) {
  const patterns = workspace._snapshotPatterns ?? ["**"];
  const after = await snapshotFiles(workspace.path, patterns);
  const keys = new Set([...(workspace.baseline?.keys() ?? []), ...after.keys()]);
  const changed = [];
  for (const path of keys) {
    const beforeValue = workspace.baseline?.get(path) ?? null;
    const afterValue = after.get(path) ?? null;
    if (!sameFileFingerprint(beforeValue, afterValue)) changed.push(path);
  }
  return changed;
}

async function changedPathsForWorktree(workspace) {
  const [tracked, untracked] = await Promise.all([
    runProcess("git", ["diff", "--name-only", "--diff-filter=ACDMRTUXB", "HEAD", "--"], { cwd: workspace.path }),
    runProcess("git", ["ls-files", "--others", "--exclude-standard"], { cwd: workspace.path }),
  ]);
  if (tracked.status !== 0) throw new Error(`worktree_diff_failed:${tracked.stderr}`);
  if (untracked.status !== 0) throw new Error(`worktree_untracked_scan_failed:${untracked.stderr}`);
  return [...new Set([tracked.stdout, untracked.stdout]
    .flatMap((output) => output.split(/\r?\n/))
    .map((value) => value.trim())
    .filter(Boolean))].sort();
}

export async function inspectWorkspaceChanges(workspace, task) {
  const observedPaths = workspace.mode === "worktree" ? await changedPathsForWorktree(workspace) : await changedPathsForCopy(workspace, task);
  const { changedPaths, toolingSideEffects } = classifyWorkspaceChanges(observedPaths);
  const unauthorized = changedPaths.filter((path) => !anyPatternMatches(task.ownedPaths, path));
  return { changedPaths, unauthorized, toolingSideEffects, observedPaths };
}

async function gitCanonicalBlobFingerprint(cwd, path) {
  const absolute = join(cwd, path);
  if (!(await exists(absolute))) return null;
  const result = await runProcess("git", ["hash-object", `--path=${path}`, "--", path], { cwd });
  if (result.status !== 0) throw new Error(`worktree_git_fingerprint_failed:${path}:${result.stderr || result.stdout}`);
  return result.stdout.trim() || null;
}

async function materializationProof({ repositoryRoot, workspace, path }) {
  const expectedFingerprint = await fileFingerprint(join(workspace.path, path));
  const actualFingerprint = await fileFingerprint(join(repositoryRoot, path));
  if (sameFileFingerprint(expectedFingerprint, actualFingerprint)) {
    return { matches: true, expectedFingerprint, actualFingerprint, authority: "raw-file-fingerprint" };
  }

  // Git worktrees can legitimately materialize different working-tree bytes for
  // the same canonical content because of core.autocrlf/.gitattributes filters.
  // Compare the Git-cleaned blob identity before declaring an integration
  // mismatch. Copy workspaces remain byte-exact because no Git transform is
  // involved in their integration path.
  if (workspace.mode === "worktree" && expectedFingerprint && actualFingerprint) {
    const [expectedGitBlob, actualGitBlob] = await Promise.all([
      gitCanonicalBlobFingerprint(workspace.path, path),
      gitCanonicalBlobFingerprint(repositoryRoot, path),
    ]);
    if (expectedGitBlob && expectedGitBlob === actualGitBlob) {
      return {
        matches: true,
        expectedFingerprint,
        actualFingerprint,
        expectedGitBlob,
        actualGitBlob,
        authority: "git-canonical-blob",
      };
    }
    return {
      matches: false,
      expectedFingerprint,
      actualFingerprint,
      expectedGitBlob,
      actualGitBlob,
      authority: "git-canonical-blob",
    };
  }

  return { matches: false, expectedFingerprint, actualFingerprint, authority: "raw-file-fingerprint" };
}

export async function integrateWorkspace({ repositoryRoot, workspace, task, store, runId, inspection: authoritativeInspection = null, approvedChangedPaths = null }) {
  // Event-driven execution already produced an attempt/fence-scoped Rust change-set
  // and the semantic finalizer reconciled handoff disposition against the
  // workspace baseline. Re-scanning the entire copied workspace here creates a
  // second diff authority and, on container/host filesystems, can falsely
  // attribute the pre-existing dirty working tree to the current agent. When an
  // authoritative inspection is supplied, integrate only the reconciled paths.
  const inspection = authoritativeInspection ?? await inspectWorkspaceChanges(workspace, task);
  const changedPaths = normalizeDeclaredPaths(approvedChangedPaths ?? inspection.changedPaths ?? []);
  const reportedUnauthorized = normalizeDeclaredPaths(inspection.unauthorized ?? []);
  const ownershipViolations = [...new Set([
    ...reportedUnauthorized,
    ...changedPaths.filter((path) => !anyPatternMatches(task.ownedPaths ?? [], path)),
  ])].sort();
  if (ownershipViolations.length > 0) {
    for (const path of ownershipViolations) await store.addConflict({ runId, taskId: task.taskId, path, type: "ownership_violation", details: { agentId: task.agentId } });
    throw new Error(`workspace_ownership_violation:${ownershipViolations.join(",")}`);
  }
  for (const path of changedPaths) {
    const previous = await store.integratedPath(runId, path);
    if (previous && previous.task_id !== task.taskId && !(task.dependencies ?? []).includes(previous.task_id)) {
      await store.addConflict({ runId, taskId: task.taskId, path, type: "parallel_write", details: { priorTaskId: previous.task_id } });
      throw new Error(`workspace_parallel_write_conflict:${path}`);
    }
  }
  if (workspace.mode === "none") {
    for (const path of changedPaths) {
      const fingerprint = await fileFingerprint(join(repositoryRoot, path));
      await store.markIntegratedPath(runId, task.taskId, path, fingerprint?.sha256 ?? null);
    }
    return { ...inspection, changedPaths, unauthorized: [] };
  }
  if (workspace.mode === "worktree") {
    const patchPath = join(dirname(workspace.path), `${runtimeTaskDirectoryName(task.taskId, task.agentId)}.patch`);
    if (changedPaths.length > 0) {
      // `git diff HEAD -- <paths>` omits brand-new untracked files. Mark the
      // reconciled change-set as intent-to-add inside the isolated worktree so
      // the binary patch contains creations as well as modifications/deletions.
      // This mutates only the disposable worktree index after agent execution.
      const intent = await runProcess("git", ["add", "-N", "--", ...changedPaths], { cwd: workspace.path });
      if (intent.status !== 0) throw new Error(`worktree_intent_to_add_failed:${intent.stderr || intent.stdout}`);
    }
    const diffArgs = ["diff", "--binary", "HEAD", "--", ...changedPaths];
    const diff = await runProcess("git", diffArgs, { cwd: workspace.path });
    if (diff.status !== 0) throw new Error(`worktree_patch_failed:${diff.stderr}`);
    await writeFile(patchPath, diff.stdout, "utf8");
    if (diff.stdout.trim()) {
      const applied = await runProcess("git", ["apply", "--3way", patchPath], { cwd: repositoryRoot });
      if (applied.status !== 0) {
        await store.addConflict({ runId, taskId: task.taskId, path: "<patch>", type: "git_apply", details: { stderr: applied.stderr.slice(0, 2_000) } });
        throw new Error(`worktree_integrate_failed:${applied.stderr}`);
      }
    }
  } else {
    for (const path of changedPaths) {
      const rootPath = join(repositoryRoot, path);
      const workspacePath = join(workspace.path, path);
      const baseline = workspace.baseline?.get(path) ?? null;
      const current = await fileFingerprint(rootPath);
      if (!sameFileFingerprint(baseline, current)) {
        const details = { baselineFingerprint: baseline, currentFingerprint: current };
        await store.event?.(runId, task.taskId, "workspace.root_changed_since_fork", { path, ...details });
        await store.addConflict({ runId, taskId: task.taskId, path, type: "root_changed_since_fork", details });
        throw new Error(`copy_integrate_root_changed:${path}`);
      }
      if (!(await exists(workspacePath))) await rm(rootPath, { force: true });
      else {
        await mkdir(dirname(rootPath), { recursive: true });
        await cp(workspacePath, rootPath, { force: true });
      }
    }
  }
  const materializedFingerprints = new Map();
  const materializationMismatches = [];
  for (const path of changedPaths) {
    const proof = await materializationProof({ repositoryRoot, workspace, path });
    if (!proof.matches) {
      const details = { ...proof, workspaceMode: workspace.mode };
      await store.event?.(runId, task.taskId, "workspace.integration_materialization_mismatch", { path, ...details });
      await store.addConflict({ runId, taskId: task.taskId, path, type: "integration_materialization_mismatch", details });
      materializationMismatches.push(path);
      continue;
    }
    materializedFingerprints.set(path, proof.actualFingerprint);
  }
  if (materializationMismatches.length > 0) {
    throw new Error(`workspace_integration_materialization_mismatch:${materializationMismatches.join(",")}`);
  }
  for (const path of changedPaths) {
    const fingerprint = materializedFingerprints.get(path) ?? null;
    await store.markIntegratedPath(runId, task.taskId, path, fingerprint?.sha256 ?? null);
  }
  return { ...inspection, changedPaths, unauthorized: [] };
}

export async function cleanupWorkspace(repositoryRoot, workspace) {
  if (!workspace || workspace.mode === "none") return;
  if (workspace.mode === "worktree") {
    await runProcess("git", ["worktree", "remove", "--force", workspace.path], { cwd: repositoryRoot });
    return;
  }
  await removeIfExists(workspace.path);
}
