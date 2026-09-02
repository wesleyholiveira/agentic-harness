import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  manifestEntryFromFile,
  projectOwnershipRegistry,
  writeAgentInputManifest,
} from "./agent-input-manifest.mjs";
import { buildConciseExecutorContract } from "./agent-input-contract.mjs";
import { writeJson } from "./utils.mjs";

export async function prepareAgentInputManifest({
  repositoryRoot,
  taskDirectory,
  runId,
  taskId,
  agentId,
  attempt,
  stage,
  brief,
  briefPath,
  contextPath,
  contextMetrics = null,
  upstreamEvidencePath = null,
  upstreamArtifactCount = 0,
  fullArtifacts = [],
  registry,
  schemas,
}) {
  const entries = [];

  entries.push(await manifestEntryFromFile({
    repositoryRoot,
    category: "task_contract",
    authorityClass: "exact-authority",
    path: briefPath,
    sourceRef: `runtime:task-brief:${taskId}:${attempt}`,
  }));

  entries.push(await manifestEntryFromFile({
    repositoryRoot,
    category: "retrieved_context",
    authorityClass: "retrieved-context",
    path: contextPath,
    sourceRef: `runtime:context-packet:${taskId}:${attempt}`,
    rawTokens: contextMetrics?.contextEngine?.rawTokens ?? null,
  }));

  if (upstreamEvidencePath && upstreamArtifactCount > 0) {
    entries.push(await manifestEntryFromFile({
      repositoryRoot,
      category: "upstream_evidence",
      authorityClass: "deterministic-projection",
      path: upstreamEvidencePath,
      sourceRef: `runtime:upstream-evidence:${taskId}:${attempt}`,
    }));
  }

  const executorContractPath = join(taskDirectory, "executor-contract.md");
  await writeFile(executorContractPath, buildConciseExecutorContract({ brief }), "utf8");
  entries.push(await manifestEntryFromFile({
    repositoryRoot,
    category: "execution_contract",
    authorityClass: "exact-authority",
    path: executorContractPath,
    sourceRef: `runtime:executor-contract:${taskId}:${attempt}`,
  }));

  const handoffSchemaPath = join(repositoryRoot, ".agents", "schemas", "handoff-result.schema.json");
  entries.push(await manifestEntryFromFile({
    repositoryRoot,
    category: "schemas",
    authorityClass: "exact-authority",
    path: handoffSchemaPath,
    sourceRef: "schema:handoff-result",
  }));

  if (stage === "technical-refinement") {
    const implementationSchemaPath = join(repositoryRoot, ".agents", "schemas", "implementation-plan.schema.json");
    entries.push(await manifestEntryFromFile({
      repositoryRoot,
      category: "schemas",
      authorityClass: "exact-authority",
      path: implementationSchemaPath,
      sourceRef: "schema:implementation-plan",
    }));
    const ownershipProjectionPath = join(taskDirectory, "ownership-projection.json");
    await writeJson(ownershipProjectionPath, projectOwnershipRegistry(registry));
    entries.push(await manifestEntryFromFile({
      repositoryRoot,
      category: "governance",
      authorityClass: "deterministic-projection",
      path: ownershipProjectionPath,
      sourceRef: "registry:implementation-ownership-projection",
      projectionOf: ".agents/agents/*/agent.json",
    }));
  }

  for (const artifact of fullArtifacts) {
    entries.push(await manifestEntryFromFile({
      repositoryRoot,
      category: "references",
      authorityClass: "lazy-reference",
      deliveryMode: "lazy",
      path: artifact.path,
      sourceRef: artifact.sourceRef ?? artifact.producer ?? "upstream-artifact",
      attach: false,
      artifactRef: artifact.artifactRef,
      lazyPolicy: artifact.lazyPolicy,
      mediaType: artifact.mediaType,
      projectionOf: artifact.sourceRef ?? null,
    }));
  }

  return await writeAgentInputManifest({
    repositoryRoot,
    taskDirectory,
    runId,
    taskId,
    agentId,
    attempt,
    entries,
    schema: schemas.agentInputManifest,
  });
}
