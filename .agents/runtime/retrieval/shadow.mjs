import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadContextRetrievalConfig } from "./config.mjs";
import { loadOrBuildLexicalIndex } from "./index.mjs";
import { searchLexicalIndex } from "./search.mjs";

async function writeReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function runContextRetrievalShadow({ repositoryRoot, registry, plan, task, mandatoryReferences, environment = process.env }) {
  const config = loadContextRetrievalConfig(repositoryRoot, environment);
  if (!config.shadowEnabled || config.mode !== "lexical-shadow") return null;
  const path = join(repositoryRoot, ".runtime", "agents", "runs", plan.runId, "tasks", task.agentId, "context-retrieval-shadow.json");
  const mandatoryContextBytes = mandatoryReferences.filter((reference) => reference.included).reduce((sum, reference) => sum + Number(reference.bytes ?? 0), 0);

  try {
    const { index } = await loadOrBuildLexicalIndex({ repositoryRoot, indexPath: config.indexPath });
    const discovery = searchLexicalIndex({
      index,
      query: plan.request,
      registry,
      agentIds: [task.agentId],
      topK: config.topK,
      maxCandidateBytes: config.maxCandidateBytes,
    });
    const report = {
      schemaVersion: 1,
      mode: "lexical-shadow",
      runId: plan.runId,
      taskId: task.taskId,
      agentId: task.agentId,
      createdAt: new Date().toISOString(),
      mandatoryContextBytes,
      discoveredContextBytes: discovery.discoveredContextBytes,
      totalContextBytes: mandatoryContextBytes + discovery.discoveredContextBytes,
      packetInfluenced: false,
      latencyMs: discovery.latencyMs,
      fallbackUsed: discovery.fallbackUsed,
      candidates: discovery.results,
    };
    await writeReport(path, report);
    return { report, path };
  } catch {
    const report = {
      schemaVersion: 1,
      mode: "lexical-shadow",
      runId: plan.runId,
      taskId: task.taskId,
      agentId: task.agentId,
      createdAt: new Date().toISOString(),
      mandatoryContextBytes,
      discoveredContextBytes: 0,
      totalContextBytes: mandatoryContextBytes,
      packetInfluenced: false,
      latencyMs: 0,
      fallbackUsed: true,
      errorCode: "context_retrieval_shadow_failed",
      candidates: [],
    };
    await writeReport(path, report).catch(() => undefined);
    return { report, path };
  }
}
