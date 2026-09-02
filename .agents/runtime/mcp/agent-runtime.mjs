import { buildDoctorReport } from "../doctor.mjs";
import { loadAgentCatalog } from "../agent-catalog.mjs";
import { loadSchemas, validateAgainstSchema } from "../schema-validator.mjs";
import { OrchestrationStore } from "../store.mjs";
import { AgentMcpError } from "./agent-errors.mjs";
import { projectArtifact, projectConflict, projectRegistry, projectRun, projectSummary, projectTask } from "./agent-projections.mjs";
import { buildSummary } from "../summary.mjs";

async function withStore(config, callback) {
  const store = await new OrchestrationStore(config.databaseUrl, {
    readOnly: true,
    schema: config.databaseSchema,
  }).open();
  try { return await callback(store); } finally { await store.close(); }
}

async function requireRun(store, runId) {
  const run = await store.getRun(runId);
  if (!run) throw new AgentMcpError("run_not_found", `Run não encontrado: ${runId}`);
  return run;
}

export async function runtimeStatus(config, runId = null) {
  return await withStore(config, async (store) => {
    if (runId) {
      const run = await requireRun(store, runId);
      return {
        run: projectRun(run),
        tasks: (await store.listTasks(runId)).map(projectTask),
        artifacts: (await store.listArtifacts(runId)).map((item) => projectArtifact(config.repositoryRoot, item)),
        conflicts: (await store.listConflicts(runId)).map((item) => projectConflict(config.repositoryRoot, item)),
      };
    }
    return { runs: (await store.listRuns(50)).map(projectRun) };
  });
}

export async function runtimeSummary(config, runId = null) {
  return await withStore(config, async (store) => {
    if (runId) await requireRun(store, runId);
    return projectSummary(await buildSummary(store, runId));
  });
}

export async function validateRuntimeArtifact(config, schemaName, artifact) {
  const schemas = await loadSchemas(config.repositoryRoot);
  const schema = schemas[schemaName];
  if (!schema) throw new AgentMcpError("unknown_schema", `Schema desconhecido: ${schemaName}`);
  return validateAgainstSchema(artifact, schema, schemaName);
}

export async function runtimeDoctor(config) {
  return await buildDoctorReport({
    repositoryRoot: config.repositoryRoot,
    databaseUrl: config.databaseUrl,
    databaseSchema: config.databaseSchema,
  });
}

export async function agentsResource(config) {
  return projectRegistry(await loadAgentCatalog(config.repositoryRoot));
}

export async function runResource(config, runId) {
  return await runtimeStatus(config, runId);
}

export async function taskResource(config, runId, taskId) {
  return await withStore(config, async (store) => {
    await requireRun(store, runId);
    const task = await store.getTask(taskId);
    if (!task || task.run_id !== runId) throw new AgentMcpError("task_not_found", `Task não encontrada: ${taskId}`);
    return projectTask(task);
  });
}

export async function artifactsResource(config, runId) {
  return await withStore(config, async (store) => {
    await requireRun(store, runId);
    return { artifacts: (await store.listArtifacts(runId)).map((item) => projectArtifact(config.repositoryRoot, item)) };
  });
}

export async function conflictsResource(config, runId) {
  return await withStore(config, async (store) => {
    await requireRun(store, runId);
    return { conflicts: (await store.listConflicts(runId)).map((item) => projectConflict(config.repositoryRoot, item)) };
  });
}
