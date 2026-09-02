import { isAbsolute, resolve } from "node:path";
import { normalizeRelativePath } from "../utils.mjs";

function parseJson(value, fallback) {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function projectRepositoryPath(repositoryRoot, value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const absolute = isAbsolute(value) ? value : resolve(repositoryRoot, value);
    return normalizeRelativePath(repositoryRoot, absolute);
  } catch {
    return "[outside-repository]";
  }
}

export function projectRun(run) {
  if (!run) return null;
  return {
    runId: run.run_id,
    status: run.status,
    workspaceMode: run.workspace_mode,
    maxParallel: Number(run.max_parallel ?? 0),
    peakParallel: Number(run.peak_parallel ?? 0),
    createdAt: run.created_at,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    errorCode: run.error_code,
  };
}

export function projectTask(task) {
  return {
    taskId: task.task_id,
    runId: task.run_id,
    agentId: task.agent_id,
    role: task.role,
    status: task.status,
    attempt: Number(task.attempt ?? 0),
    maxAttempts: Number(task.max_attempts ?? 0),
    dependencies: parseJson(task.dependencies_json, []),
    ownedPaths: parseJson(task.owned_paths_json, []),
    contextBytes: Number(task.context_bytes ?? 0),
    contextDocuments: Number(task.context_documents ?? 0),
    estimatedTokens: Number(task.estimated_tokens ?? 0),
    startedAt: task.started_at,
    completedAt: task.completed_at,
    durationMs: Number(task.duration_ms ?? 0),
    errorCode: task.error_code,
  };
}

export function projectArtifact(repositoryRoot, artifact) {
  return {
    artifactId: artifact.artifact_id,
    runId: artifact.run_id,
    taskId: artifact.task_id,
    kind: artifact.kind,
    version: artifact.version,
    path: projectRepositoryPath(repositoryRoot, artifact.path),
    sha256: artifact.sha256,
    accepted: Boolean(artifact.accepted),
    createdAt: artifact.created_at,
  };
}

export function projectConflict(repositoryRoot, conflict) {
  return {
    conflictId: conflict.conflict_id,
    runId: conflict.run_id,
    taskId: conflict.task_id,
    path: projectRepositoryPath(repositoryRoot, conflict.path),
    conflictType: conflict.conflict_type,
    createdAt: conflict.created_at,
  };
}

export function projectSummary(summary) {
  return {
    ...summary,
    runs: summary.runs.map(({ request: _request, ...run }) => run),
  };
}

export function projectRegistry(registry) {
  return {
    orchestrator: registry.orchestrator,
    agents: registry.agents.map((agent) => ({
      id: agent.id,
      kind: agent.kind,
      tier: agent.tier,
      primaryPaths: agent.primaryPaths ?? [],
      sharedPaths: agent.sharedPaths ?? [],
      skills: agent.skills ?? [],
    })),
  };
}
