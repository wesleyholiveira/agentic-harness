import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runtimeTaskDirectoryName, sha256 } from "./utils.mjs";

export const AGENT_RUNTIME_SCHEMA_VERSION = "agent-runtime-envelope/v1";
export const AGENT_EXECUTION_DESCRIPTOR_VERSION = "agent-execution-descriptor/v1";
export const AGENT_EXECUTION_RESULT_VERSION = "agent-execution-result/v1";

export const AGENT_RUNTIME_MESSAGE_KINDS = Object.freeze([
  "agent.run.reconcile.v1",
  "agent.task.execute.v1",
  "agent.task.prefetch.v1",
  "agent.execution.finished.v1",
  "agent.workspace.cleanup.v1",
  "agent.continuation.wake.v1",
]);

export const TERMINAL_TASK_STATUSES = new Set(["integrated", "verified", "failed", "blocked", "cancelled"]);
export const SUCCESS_TASK_STATUSES = new Set(["integrated", "verified"]);
export const TERMINAL_RUN_STATUSES = new Set(["closed", "failed", "blocked", "cancelled"]);

export function assertAgentRuntimeEnvelope(envelope) {
  if (!envelope || envelope.schemaVersion !== AGENT_RUNTIME_SCHEMA_VERSION) throw new Error("agent_runtime_envelope_version_invalid");
  if (!AGENT_RUNTIME_MESSAGE_KINDS.includes(envelope.kind)) throw new Error(`agent_runtime_message_kind_invalid:${envelope?.kind ?? "missing"}`);
  if (!String(envelope.messageId ?? "").trim() || !String(envelope.runId ?? "").trim()) throw new Error("agent_runtime_envelope_identity_missing");
  if (!Number.isInteger(Number(envelope.dispatchGeneration)) || Number(envelope.dispatchGeneration) < 0) throw new Error("agent_runtime_dispatch_generation_invalid");
  const tasklessKinds = new Set(["agent.run.reconcile.v1", "agent.continuation.wake.v1"]);
  if (!tasklessKinds.has(envelope.kind) && !String(envelope.taskId ?? "").trim()) throw new Error("agent_runtime_task_identity_missing");
  if (envelope.kind === "agent.continuation.wake.v1") {
    if (!String(envelope.continuationId ?? "").trim() || !String(envelope.deliveryId ?? "").trim() || !String(envelope.effectKey ?? "").trim()) {
      throw new Error("agent_runtime_continuation_identity_missing");
    }
  }
  return envelope;
}

export function resolveAgentWorkspaceRoot(repositoryRoot, environment = process.env) {
  const configured = String(environment.AGENT_HARNESS_AGENT_WORKSPACE_ROOT ?? "").trim();
  if (configured) return resolve(configured);
  const normalizedRepositoryRoot = resolve(repositoryRoot);
  return join(dirname(normalizedRepositoryRoot), ".agentic-harness-agent-workspaces", basename(normalizedRepositoryRoot));
}

export function assertWorkspaceOutsideRepository(repositoryRoot, workspacePath) {
  const root = resolve(repositoryRoot);
  const workspace = resolve(workspacePath);
  const rel = relative(root, workspace);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`agent_runtime_workspace_nested_in_repository:${workspace}`);
  }
  return workspace;
}

export function runtimeTaskPaths({ repositoryRoot, runId, taskId, agentId, attempt, workspaceRoot = null }) {
  const runDirectory = join(repositoryRoot, ".runtime", "agents", "runs", runId);
  const taskDirectory = join(runDirectory, "tasks", runtimeTaskDirectoryName(taskId, agentId));
  const selectedWorkspaceRoot = workspaceRoot ? resolve(workspaceRoot) : resolveAgentWorkspaceRoot(repositoryRoot);
  const workspacePath = assertWorkspaceOutsideRepository(
    repositoryRoot,
    join(selectedWorkspaceRoot, runId, `${runtimeTaskDirectoryName(taskId, agentId)}--attempt-${attempt}`),
  );
  return {
    runDirectory,
    taskDirectory,
    workspacePath,
    handoffPath: join(taskDirectory, `handoff-attempt-${attempt}.json`),
    logPath: join(taskDirectory, `executor-attempt-${attempt}.log`),
    descriptorPath: join(taskDirectory, `execution-descriptor-attempt-${attempt}.json`),
    resultPath: join(taskDirectory, `execution-result-attempt-${attempt}.json`),
    baselinePath: join(taskDirectory, `workspace-baseline-attempt-${attempt}.json`),
    changeSetPath: join(taskDirectory, `workspace-changeset-attempt-${attempt}.json`),
  };
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]));
  }
  return value;
}

export function stableFingerprint(value) {
  const stable = JSON.stringify(canonicalJsonValue(value));
  return `sha256:${sha256(Buffer.from(stable))}`;
}

export function dependenciesSatisfied(taskRow, stateById) {
  const dependencies = JSON.parse(taskRow.dependencies_json ?? "[]");
  return dependencies.every((dependency) => SUCCESS_TASK_STATUSES.has(stateById.get(dependency)));
}

export function dependenciesFailed(taskRow, stateById) {
  const dependencies = JSON.parse(taskRow.dependencies_json ?? "[]");
  return dependencies.some((dependency) => ["failed", "blocked", "cancelled"].includes(stateById.get(dependency)));
}

export function runtimeRoutingKey(kind) {
  const suffix = {
    "agent.run.reconcile.v1": "scheduler.reconcile",
    "agent.task.execute.v1": "task.execute",
    "agent.task.prefetch.v1": "task.prefetch",
    "agent.execution.finished.v1": "execution.finished",
    "agent.workspace.cleanup.v1": "workspace.cleanup",
    "agent.continuation.wake.v1": "continuation.wake",
  }[kind];
  if (!suffix) throw new Error(`agent_runtime_message_kind_invalid:${kind}`);
  return suffix;
}

export function isTransientWorkspaceCleanupError(error) {
  const code = String(error?.code ?? "").toUpperCase();
  return ["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"].includes(code);
}
