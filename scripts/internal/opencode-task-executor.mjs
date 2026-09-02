#!/usr/bin/env node
import { copyFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, readJson, writeJson } from "../../.agents/runtime/utils.mjs";
import { loadAndVerifyAgentInputManifest, manifestAttachmentPaths, manifestRepositoryRoot, resolveManifestEntryPath } from "../../.agents/runtime/agent-input-manifest.mjs";
import { assertSchema, validateAgainstSchema } from "../../.agents/runtime/schema-validator.mjs";
import { runProcess } from "../../.agents/runtime/process.mjs";
import { repairImplementationPlanFromReview, synthesizeMissingImplementationPlan } from "../../.agents/runtime/technical-plan-synthesis.mjs";
import { missingCompletionCriterionIds, synthesizeMissingCriterionResults } from "../../.agents/runtime/completion-evidence-synthesis.mjs";
import { synthesizeRequiredValidationEvidence } from "../../.agents/runtime/validation-evidence.mjs";
import { resolveTaskExecutionTopology } from "../../.agents/runtime/agent-topology.mjs";
import { sanitizeHandoffTelemetryShape } from "../../.agents/runtime/handoff-telemetry.mjs";
import { normalizeModelHandoffContract, stripModelOwnedHandoffTelemetry } from "../../.agents/runtime/handoff-contract.mjs";
import {
  finalAssistantResponseFromJsonStream,
  jsonObjectsFromFinalResponse,
  resolveAuthoritativeHandoff,
  sessionExportDocumentFromValue,
  sessionExportIsUsable,
} from "../../.agents/runtime/handoff-authority.mjs";
import { finalizeHandoffStructured, requiresStructuredHandoffFinalization } from "../../.agents/runtime/handoff-structured-finalization.mjs";
import { repairProductDiscoveryScopeBlock } from "../../.agents/runtime/product-discovery-scope-repair.mjs";
import { productDiscoveryAcceptanceCriteriaIssue, projectProductDiscoveryAcceptanceCriteria } from "../../.agents/runtime/product-discovery-acceptance-criteria.mjs";
import { isBootstrapReviewStage } from "../../.agents/runtime/bootstrap-capabilities.mjs";
import { loadAgentCatalog } from "../../.agents/runtime/agent-catalog.mjs";
import { projectMissingProductDiscoveryBootstrapAssessment } from "../../.agents/runtime/product-discovery-bootstrap-assessment.mjs";
import { runOpenCodeStructuredOutput } from "../../.agents/runtime/opencode-structured-output.mjs";
import {
  readRepairCheckpoint,
  repairCheckpointPathForHandoff,
  repairResumeReceiptPathForHandoff,
  writeRepairCheckpoint,
  writeRepairResumeReceipt,
} from "../../.agents/runtime/repair-checkpoint.mjs";
import { repairEffectKey } from "../../.agents/runtime/retry-efficiency.mjs";

const RUNTIME_EVENT_PREFIX = "@@agentic-harness-runtime-event ";

export function resolveOpenCodeInvocation(env = process.env) {
  if (String(env.AGENT_HARNESS_RUNTIME_TEST_MODE ?? "") === "1") {
    const command = String(env.AGENT_HARNESS_OPENCODE_TEST_COMMAND ?? "").trim();
    if (command) {
      let prefixArgs = [];
      const raw = String(env.AGENT_HARNESS_OPENCODE_TEST_ARGS_JSON ?? "").trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
          throw new Error("opencode_test_args_invalid");
        }
        prefixArgs = parsed;
      }
      return { command, prefixArgs };
    }
  }
  return { command: "opencode", prefixArgs: [] };
}

function resolveOpenCodeAuthPath(env = process.env) {
  const dataHome = String(env.XDG_DATA_HOME ?? "").trim();
  if (dataHome) return join(dataHome, "opencode", "auth.json");
  const home = String(env.HOME ?? "").trim() || homedir();
  return join(home, ".local", "share", "opencode", "auth.json");
}

export async function prepareIsolatedOpenCodeAttemptEnv({ manifestPath, attempt, env = process.env }) {
  const boundedAttempt = Math.max(1, Number(attempt ?? 1));
  const stateRoot = join(dirname(resolve(String(manifestPath))), "opencode-attempt-state", `attempt-${boundedAttempt}`);
  const dataHome = join(stateRoot, "data");
  const stateHome = join(stateRoot, "state");
  const targetAuthPath = join(dataHome, "opencode", "auth.json");
  const sourceAuthPath = resolveOpenCodeAuthPath(env);
  await Promise.all([
    mkdir(dirname(targetAuthPath), { recursive: true }),
    mkdir(stateHome, { recursive: true }),
  ]);
  let authCopied = false;
  if (resolve(sourceAuthPath) !== resolve(targetAuthPath)) {
    try {
      await copyFile(sourceAuthPath, targetAuthPath);
      authCopied = true;
    } catch {
      // Provider credentials may be supplied by another supported mechanism.
      // Do not invent credentials; the OpenCode invocation remains fail-closed.
    }
  }
  return {
    env: {
      ...env,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateHome,
    },
    stateRoot,
    dataHome,
    stateHome,
    sourceAuthPath,
    targetAuthPath,
    authCopied,
  };
}

function emitRuntimeEvent(type, payload = {}) {
  process.stderr.write(`${RUNTIME_EVENT_PREFIX}${JSON.stringify({ type, payload })}\n`);
}

export function resolveQualificationProcessLossBoundary({ brief, resumeCheckpoint = null, env = process.env } = {}) {
  const boundary = String(env.AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_BOUNDARY ?? "").trim();
  if (boundary !== "repair-checkpoint-after-full-agent") return null;
  // Qualification fault injection is only legal on the original full-agent
  // execution. Replacement execution must never re-arm the same fault.
  if (resumeCheckpoint) return null;
  const taskMatch = String(env.AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_TASK_MATCH ?? "").trim();
  if (taskMatch) {
    const identities = [brief?.taskId, brief?.sdd?.stage, brief?.agentId].filter(Boolean).map(String);
    if (!identities.some((value) => value === taskMatch || value.includes(taskMatch))) return null;
  }
  const rawWaitMs = Number(env.AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_WAIT_MS ?? 120_000);
  const waitMs = Math.max(5_000, Math.min(300_000, Number.isFinite(rawWaitMs) ? Math.trunc(rawWaitMs) : 120_000));
  return { boundary, taskMatch: taskMatch || null, waitMs };
}

async function armQualificationProcessLossBoundary({ brief, handoff, sessionId, usage, repairCheckpointPath, resumeCheckpoint }) {
  const qualification = resolveQualificationProcessLossBoundary({ brief, resumeCheckpoint });
  if (!qualification) return false;
  const sourceRevision = Number(handoff?.implementationPlan?.revision ?? handoff?.sddReview?.reviewedRevision ?? 0);
  const checkpoint = await writeRepairCheckpoint(repairCheckpointPath, {
    runId: brief.runId,
    taskId: brief.taskId,
    taskAttempt: Number(brief.modelRouting?.attempt ?? 1),
    repairKind: "qualification-process-loss",
    repairPass: 1,
    repairPassLimit: 1,
    status: "repair-started",
    sourceRevision,
    handoff,
    sessionId,
    usage,
    qualificationBoundary: qualification.boundary,
  });
  emitRuntimeEvent("qualification.process_loss_boundary_ready", {
    runId: brief.runId,
    taskId: brief.taskId,
    taskAttempt: Number(brief.modelRouting?.attempt ?? 1),
    checkpointEffectKey: checkpoint.effectKey,
    checkpointStatus: checkpoint.status,
    repairKind: checkpoint.repairKind,
    waitMs: qualification.waitMs,
  });
  // A real qualification harness is expected to terminate the worker process at
  // this point. If it fails to do so, do not silently continue and accidentally
  // classify an unexercised crash boundary as PASS.
  await sleep(qualification.waitMs);
  throw new Error("qualification_process_loss_not_triggered_before_deadline");
}

export function buildHeadlessRuntimeOverride({
  agentId,
  stepsLimit,
  executionTopology = null,
  contextEngineUrl = process.env.AGENT_HARNESS_CONTEXT_ENGINE_INTERNAL_URL?.trim() || null,
}) {
  const selectedAgentId = String(agentId);
  const topology = executionTopology ?? {
    orchestrationRole: "specialist",
    interactiveMode: "subagent",
    sessionRole: "primary",
  };
  if (topology.sessionRole !== "primary") {
    throw new Error(`runtime_session_role_unsupported:${selectedAgentId}:${topology.sessionRole ?? "missing"}`);
  }
  const runtimeOverride = {
    // Global topology and child-session topology are deliberately different:
    // specialists stay `subagent` in the generated OpenCode config so the interactive entrypoint
    // remains the Main Orchestrator, while the owner of an already-routed Runtime
    // V2 task becomes `primary` only inside this isolated child process.
    default_agent: selectedAgentId,
    agent: {
      [selectedAgentId]: {
        mode: topology.sessionRole,
        steps: Number(stepsLimit),
        permission: { question: "deny" },
      },
    },
  };
  if (contextEngineUrl) {
    runtimeOverride.mcp = {
      // Host OpenCode keeps its developer-local MCPs, but the Linux execution
      // container must not inherit Windows-only commands/paths from the host OpenCode configuration.
      serena: { enabled: false },
      "codebase-memory-mcp": { enabled: false },
      headroom: { enabled: false },
      context7: process.env.CONTEXT7_API_KEY?.trim()
        ? {
            enabled: true,
            type: "remote",
            url: "https://mcp.context7.com/mcp",
            headers: { Authorization: `Bearer ${process.env.CONTEXT7_API_KEY.trim()}` },
          }
        : { enabled: false, type: "remote", url: "https://mcp.context7.com/mcp" },
      "context-engine": {
        enabled: true,
        type: "remote",
        url: contextEngineUrl,
        oauth: false,
        headers: { "X-Agentic-Harness-Agent-Id": selectedAgentId },
      },
    };
  }
  return runtimeOverride;
}

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

export function detectOpenCodeAgentFallback(value, requestedAgentId) {
  const cleaned = stripAnsi(value);
  const requested = String(requestedAgentId);
  const marker = `agent "${requested}" is a subagent, not a primary agent. Falling back to default agent`;
  if (!cleaned.toLowerCase().includes(marker.toLowerCase())) return null;
  return { requestedAgentId: requested, fallbackDetected: true };
}

function jsonValues(value, visitor) {
  if (!value || typeof value !== "object") return;
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) jsonValues(item, visitor);
    return;
  }
  for (const item of Object.values(value)) jsonValues(item, visitor);
}

function parseJsonDocuments(value) {
  const documents = [];
  const cleaned = stripAnsi(value);
  try { documents.push(JSON.parse(cleaned)); } catch {}
  for (const line of cleaned.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { documents.push(JSON.parse(line)); } catch {}
  }
  return documents;
}

function sessionIdFromOutput(value) {
  for (const document of parseJsonDocuments(value)) {
    let sessionId = null;
    jsonValues(document, (current) => {
      if (!sessionId && typeof current.sessionID === "string") sessionId = current.sessionID;
      if (!sessionId && typeof current.sessionId === "string") sessionId = current.sessionId;
    });
    if (sessionId) return sessionId;
  }
  return null;
}

function parseHandoff(value) {
  const finalResponse = finalAssistantResponseFromJsonStream(value) ?? stripAnsi(value);
  for (const parsed of [...jsonObjectsFromFinalResponse(finalResponse)].reverse()) {
    if (parsed && typeof parsed === "object" && ["complete", "failed", "blocked", "cancelled"].includes(parsed.status)) return parsed;
  }
  throw new Error("opencode_handoff_json_not_found_in_final_response");
}

function usageFromDocuments(documents) {
  const seen = new Set();
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, stepCount: 0, lastReason: null };
  let found = false;
  for (const document of documents) {
    jsonValues(document, (current) => {
      const type = current.type;
      if (!(["step-finish", "step_finish"].includes(type)) || !current.tokens || typeof current.tokens !== "object") return;
      const identity = String(current.id ?? current.part?.id ?? `${current.messageID ?? current.messageId ?? ""}:${JSON.stringify(current.tokens)}:${current.reason ?? ""}`);
      if (seen.has(identity)) return;
      seen.add(identity);
      found = true;
      totals.stepCount += 1;
      totals.input += Number(current.tokens.input ?? 0);
      totals.output += Number(current.tokens.output ?? 0);
      totals.reasoning += Number(current.tokens.reasoning ?? 0);
      totals.cacheRead += Number(current.tokens.cache?.read ?? 0);
      totals.cacheWrite += Number(current.tokens.cache?.write ?? 0);
      totals.cost += Number(current.cost ?? 0);
      if (current.reason) totals.lastReason = String(current.reason);
    });
  }
  return found ? totals : null;
}

export function usageFromOutput(value) {
  return usageFromDocuments(parseJsonDocuments(value));
}

export function usageFromSessionExport(value) {
  const document = sessionExportDocumentFromValue(value);
  return document ? usageFromDocuments([document]) : null;
}

export async function exportOpenCodeSession({
  sessionId,
  workspace,
  outputPath,
  processRunner = runProcess,
  maxAttempts = Number(process.env.AGENT_HARNESS_OPENCODE_EXPORT_MAX_ATTEMPTS ?? 2),
  timeoutMs = Number(process.env.AGENT_HARNESS_OPENCODE_EXPORT_TIMEOUT_MS ?? 120_000),
  env = process.env,
}) {
  const parsedAttempts = Number(maxAttempts);
  const boundedAttempts = Number.isInteger(parsedAttempts) && parsedAttempts >= 1 ? Math.min(parsedAttempts, 3) : 2;
  const attempts = [];
  let lastResult = null;

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    // Write directly to a regular file descriptor rather than capturing export
    // stdout through a pipe. Some OpenCode builds have truncated large exports
    // when stdout is piped, which can expose a complete stale nested message but
    // omit the true final assistant response.
    const temporaryPath = `${resolve(String(outputPath))}.session-export-${process.pid}-${attempt}.json`;
    const handle = await open(temporaryPath, "w");
    let result;
    let stdout = "";
    try {
      const invocation = resolveOpenCodeInvocation(env);
      result = await processRunner(invocation.command, [...invocation.prefixArgs, "export", String(sessionId)], {
        cwd: workspace,
        timeoutMs,
        env,
        stdio: ["ignore", handle.fd, "pipe"],
      });
    } catch (error) {
      result = {
        status: null,
        signal: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        error,
        timedOut: false,
        aborted: false,
      };
    } finally {
      await handle.close().catch(() => {});
      stdout = await readFile(temporaryPath, "utf8").catch(() => "");
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
    const usable = result?.status === 0 && sessionExportIsUsable(stdout);
    const summary = {
      attempt,
      status: result?.status ?? null,
      signal: result?.signal ?? null,
      timedOut: result?.timedOut === true,
      aborted: result?.aborted === true,
      bytes: Buffer.byteLength(stdout),
      usable,
      stderr: String(result?.stderr ?? "").slice(-2_000),
    };
    attempts.push(summary);
    lastResult = { ...result, stdout, attempt, usable, attempts: [...attempts] };
    if (usable) return lastResult;
    if (attempt < boundedAttempts) await sleep(Math.min(1_000, 150 * attempt));
  }

  return lastResult ?? {
    status: null,
    signal: null,
    stdout: "",
    stderr: "opencode_session_export_not_attempted",
    timedOut: false,
    aborted: false,
    attempt: 0,
    usable: false,
    attempts,
  };
}

function promptFor({ brief }) {
  const stage = brief.sdd?.stage ?? "implementation";
  const productDiscoveryContract = stage === "product-discovery"
    ? "- product-discovery: this is the UPSTREAM bootstrap stage. Architecture, Database, DevOps, AI/LLMOps, Technical Refinement, QA/readiness and Product Acceptance are downstream and their pending state is expected; NEVER block Product Discovery because those stages have not run. Task Brief.validation is the complete blocking executable validation authority for this stage. Agent catalog manifests, docs/AGENTS.md and generic skills may advertise docs:check or other repository-wide commands, but a command absent from Task Brief.validation is NOT a Product Discovery blocker. Complete this stage when its own PROC-PO process criteria are proven in criterionResults and a separate product-only acceptanceCriteria catalog is emitted with explicit proofStage on every item. PROC-PO-* belongs only to criterionResults, never acceptanceCriteria. You MUST also emit bootstrapReviewAssessment with contractVersion=bootstrap-review-assessment/v1. The exact envelope shape is {\"contractVersion\":\"bootstrap-review-assessment/v1\",\"requiredCapabilities\":[],\"factRequirements\":[],\"evidence\":\"...\"}; populate arrays from evidence rather than omitting the field. requiredCapabilities lists only review capabilities actually required by the scoped increment. factRequirements must classify every cross-review input as either authoritative-context (source MUST be one of product-discovery, frozen-adr, project-memory, repository-context and evidence must identify the resolved fact) or review (providerCapabilityId MUST be the review capability that produces the fact). Explicit request-scoped bootstrap capabilities or producer->consumer facts MUST appear in requiredCapabilities/factRequirements; omit or reclassify only when the request permits it and concrete authoritative evidence resolves them. Use explicit [] when no cross-review fact edge is needed. Do not use reasoning/model opinion as authoritative-context provenance.\n"
    : "";
  const governanceReviewContract = isBootstrapReviewStage(stage)
    ? "- bootstrap-governance-review: this stage reviews the approved Product Discovery scope and defines/approves constraints for Technical Refinement. It is NOT a downstream execution/readiness gate. Technical Refinement and the Technical Lead implementationPlan are downstream by construction: the plan does not exist yet and MUST NOT be required for this review. Do not require implementation, QA, terminal-run, attached-TUI checkpoint, rollout, or other evidence that can only exist after this review integrates. Only Task Brief.dependencies and corresponding Context Packet upstreamArtifacts are prerequisite review outputs; if a sibling review is not an explicit dependency, do not wait for or require it. Resolved bootstrapFactBindings supplied by authoritative Product Discovery/ADR/Project Memory/repository context are sufficient fact authority and do not create a sibling-review prerequisite. Missing future-stage evidence is expected and is not a blocker. Block only for a current-scope ambiguity, contradiction, unsafe constraint, or evidence that this review itself is required to produce and cannot prove.\n"
    : "";
  const databaseReviewContract = stage === "database-review"
    ? "- database-review: classify database impact from the scoped increment, not from invariants the request says to preserve. A documentation-only marker or other change that leaves schema, migrations, queries, indexes, transactions, persistence and backfills untouched is database_impact=none and the review passes: emit PROC-DB-1 result=passed with scoped evidence and sddReview.decision=approved; do NOT use not_applicable/blocked merely because no database change is required. If impacted, this review must DEFINE explicit migration/backfill, query/index, transaction, compatibility and rollback constraints for downstream Technical Refinement; it must not wait for or require a Technical Lead implementationPlan.\n"
    : "";
  const operationalReadinessContract = stage === "operational-readiness"
    ? "- operational-readiness: verify only assigned criteria and the specialist domain. Task Brief.validation is the complete blocking command authority for this readiness task; agent manifests are only a reusable catalog and MUST NOT add docs:check, test:ml, test:worker or any other command that is absent from Task Brief.validation. If the accepted QA evidence plus upstream domain review proves impact=none, explicit no-impact evidence is a valid PASS; approve it with requiredDeltas=[] unless scoped contradictory evidence exists. Do not demand unrelated production gates or relitigate outer/environment qualification.\n"
    : "";
  const technicalRefinementContract = stage === "technical-refinement"
    ? "- technical-refinement: emit handoff.implementationPlan matching .agents/schemas/implementation-plan.schema.json. Task Brief.upstreamAcceptanceCriteria is immutable Product Owner authority. ownership-projection.json is attached as the compact planning view; the Runtime compiler retains .agents/agents/*/agent.json as exact ownership authority: every ownedPath must match the chosen owner\'s primaryPaths/sharedPaths/collaborativePaths exactly; never infer a neighboring package/test path. Work-item validation is scoped; do not copy broad catalog-level defaults. Use executable work-item commands only. Work items may reference only implementation-proof criterion IDs, must be bounded and acyclic, and governance/verification roles cannot own implementation. Validate the entire plan against ownership, criteria, dependencies and commands before completion. If valid, emit sddReview with role=technical-lead, stage=technical-refinement, decision=approved, requiredDeltas=[]; otherwise return changes_requested/blocked.\n"
    : "";
  return `Execute the assigned Agentic Harness task to completion in this workspace.

The attached Task Brief is the execution contract. Do not reinterpret or weaken acceptance criteria. Every blocking criterion must be proven with explicit evidence. A RED TDD failure is allowed only as validation phase \"red\"; every blocking validation with phase \"final\" must pass before status can be \"complete\".

Required blocking criterion IDs for this task:
${(brief.acceptanceCriteria ?? []).filter((criterion) => criterion.blocking !== false).map((criterion) => `- ${criterion.id}: ${criterion.statement} | verification: ${criterion.verification}`).join("\n") || "- none"}

Your final criterionResults MUST contain exactly one entry for every required blocking criterion ID above, using the ID byte-for-byte. Before returning status=complete, compare criterionResults against this list and prove there are no missing IDs.

If something required cannot be completed, use status \"failed\" or \"blocked\". Never hide unfinished work in followUps or residualRisks while claiming complete.

Path disposition contract:
- changedPaths must contain only repository paths actually created, modified or deleted during this attempt.
- If an owned artifact already existed before this attempt, remains byte-identical and you verified it already satisfies the assigned criteria, put it in reusedPaths instead of changedPaths.
- If you modify an owned artifact during this attempt, it belongs in changedPaths even if it existed before the attempt. The runtime will mechanically normalize an owned path mistakenly reported in reusedPaths when workspace inspection proves it changed, but do not rely on that repair.
- Cite the verification of reused artifacts in criterionResults and/or final validation evidence. Never claim an unchanged path as changed.
- readOnlyContextPaths in the Task Brief are supporting context only. If you read one, report it in usedContextPaths. Never place a read-only context path in changedPaths or reusedPaths.
- reusedPaths is not a list of files you read; it is only for pre-existing artifacts inside ownedPaths that are being accepted as task output without modification.

Handoff Result v2 envelope contract:
- artifactVersion, assumptions, contractChanges, residualRisks and followUps are required. Emit the arrays explicitly even when they are empty.
- every validation entry must contain command, phase, blocking, result and evidence. Never emit a partial validation record.
- sddReview: role/stage/reviewedRevision = Task Brief.sdd.* (logical role); no legacy aliases. Review complete => approved (product acceptance => accepted). Positive: requiredDeltas=[], nextRole null or next role. Negative: non-empty nextRole+deltas.
- schemaVersion/runId/taskId/agentId are authoritative runtime identity fields. Missing identity fields are filled from the Task Brief; any conflicting non-empty identity is a terminal fenced-task violation and is never overwritten.

Telemetry contract:
- metrics and executionTelemetry are runtime-owned envelopes. Do not invent provider-specific or byte-count fields there. You may omit them; the runtime will populate canonical telemetry.

Stage-specific contract:
- product-discovery: Task Brief.acceptanceCriteria are Runtime PROCESS gates (PROC-PO-*). Prove those IDs only in handoff.criterionResults and NEVER copy them into handoff.acceptanceCriteria. handoff.acceptanceCriteria is exclusively the Product Owner PRODUCT-BEHAVIOR catalog; emit stable non-PROC product criterion IDs, binary statements, verification instructions, and explicit proofStage for every item. Use proofStage=implementation when an implementation task can prove it; quality-assurance for criteria that require independent QA; product-acceptance for criteria that require the Product Owner acceptance gate; use database-readiness/infrastructure-readiness/ai-readiness only when that specialist gate is the authoritative proof point. Historical handoffs that mixed PROC-* process gates into acceptanceCriteria are legacy artifacts and MUST NOT be copied.
${productDiscoveryContract}${governanceReviewContract}${databaseReviewContract}${technicalRefinementContract}- quality-assurance: independently verify every assigned criterion and approve only when proven.
${operationalReadinessContract}- product-acceptance: use sddReview.decision=accepted only when the increment satisfies every assigned criterion.
- implementation: implement the assigned work item, not the whole product request. Task Brief.validation is the blocking validation authority for this runtime task. Agent manifests and generic verification skills may list broader repository checks as a reusable catalog, but they do not expand this work item's scope. If you voluntarily run a broader check and it fails only because of pre-existing, byte-unchanged files outside ownedPaths, record that as a non-blocking finding/residual risk instead of returning failed. A failure caused by this attempt, a failure inside ownedPaths, or any failed command explicitly listed in Task Brief.validation remains blocking.
- quality-assurance: Task Brief.validation is blocking. Task Brief.changeProvenance owns diff attribution; use implementationChangedPaths/implementationReusedPaths, never raw git status alone. Pre-existing dirty/tracked/untracked state is not implementation work. changedPaths=[] with required files in implementationReusedPaths is valid when fresh QA passes. Only increment-caused failures or an explicit repository-wide criterion block.

Use the Context Engine MCP tools when a contextEngine payload contains ctxref/ctxpack references and more detail is needed. Inspect repository files progressively rather than guessing.

The authoritative Task Brief, Context Packet and Handoff Result v2 JSON Schema are attached to this message with OpenCode --file. Treat task-brief.json as the execution contract, context-packet.json as supporting context, and handoff-result.schema.json as the structural output authority. Technical Refinement also receives implementation-plan.schema.json. Do not infer missing requirements from this launcher prompt.

Current execution stage: ${stage}.

This executor is non-interactive. Do not invoke the question tool or wait for human input. If a human decision is genuinely required and cannot be resolved from the Task Brief or Context Packet, return status "blocked" with the unresolved decision in residualRisks.

At the end, return ONLY one valid JSON object matching .agents/schemas/handoff-result.schema.json. Do not wrap it in markdown and do not append commentary.`;
}

export function shouldSynthesizeTechnicalPlan({ brief, handoff }) {
  const decision = handoff?.sddReview?.decision ?? null;
  return brief.sdd?.stage === "technical-refinement"
    && handoff?.status === "complete"
    && !["changes_requested", "blocked"].includes(decision);
}

function compactLauncherPrompt({ brief, manifest }) {
  const stage = brief.sdd?.stage ?? "implementation";
  return [
    "Execute the assigned Agentic Harness Runtime V2 task using AgentInputManifest/v1 and its attached files.",
    "Task Brief is exact execution authority; executor-contract.md contains concise launcher rules; Context Packet is retrieved context; upstream/governance files are deterministic projections.",
    `Manifest fingerprint: ${manifest.manifestFingerprint}.`,
    `Current execution stage: ${stage}.`,
    "Use context_get_agent_input_artifact only for manifest-listed lazy full-artifact refs when projection detail is insufficient.",
    "This executor is non-interactive. Return ONLY one valid JSON object matching handoff-result.schema.json.",
  ].join(" ");
}

function buildOpenCodeRunArgs({ args, brief, manifestPath, manifest, workspace }) {
  if (!manifestPath || !manifest) throw new Error("opencode_agent_input_manifest_required");
  const commandArgs = [
    "run",
    "--format", "json",
    "--model", String(args.model),
    "--agent", String(args.agentId),
    "--dir", workspace,
    "--auto",
    "--file", manifestPath,
  ];
  for (const entry of manifest.entries ?? []) {
    if (!entry.attach || entry.deliveryMode !== "attachment") continue;
    const resolved = resolveManifestEntryPath(manifestPath, entry);
    if (!resolved) throw new Error(`opencode_manifest_attachment_path_missing:${entry.entryId}`);
    commandArgs.push("--file", resolved);
  }
  if (args.variant) commandArgs.push("--variant", String(args.variant));
  const rawTitle = `${brief.taskId} attempt ${brief.modelRouting?.attempt ?? 1}`;
  commandArgs.push("--title", rawTitle.slice(0, 160), compactLauncherPrompt({ brief, manifest }));
  return commandArgs;
}

async function main() {
  const executorStartedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const required = ["agentInputManifest", "workspace", "handoff", "model", "agentId"];
  for (const key of required) if (!args[key]) throw new Error(`opencode_task_executor_missing_arg:${key}`);
  const manifestPath = resolve(String(args.agentInputManifest));
  const repositoryRoot = manifestRepositoryRoot(manifestPath);
  const manifestSchema = await readJson(resolve(repositoryRoot, ".agents", "schemas", "agent-input-manifest.schema.json"));
  const manifest = await loadAndVerifyAgentInputManifest(manifestPath, manifestSchema);
  const entryByCategory = (category) => (manifest.entries ?? []).filter((entry) => entry.category === category);
  const taskEntry = entryByCategory("task_contract").find((entry) => entry.attach);
  const contextEntry = entryByCategory("retrieved_context").find((entry) => entry.attach);
  const handoffSchemaEntry = entryByCategory("schemas").find((entry) => entry.sourceRef === "schema:handoff-result");
  if (!taskEntry || !contextEntry || !handoffSchemaEntry) throw new Error("opencode_agent_input_manifest_required_authority_missing");
  const taskBriefPath = resolveManifestEntryPath(manifestPath, taskEntry);
  const contextPacketPath = resolveManifestEntryPath(manifestPath, contextEntry);
  const handoffSchemaPath = resolveManifestEntryPath(manifestPath, handoffSchemaEntry);
  const brief = await readJson(taskBriefPath);
  const wireContextPacket = await readJson(contextPacketPath);
  const upstreamEntry = entryByCategory("upstream_evidence").find((entry) => entry.attach);
  const upstreamProjection = upstreamEntry ? await readJson(resolveManifestEntryPath(manifestPath, upstreamEntry)) : null;
  const contextPacket = { ...wireContextPacket, upstreamArtifacts: upstreamProjection?.artifacts ?? [] };
  const workspace = resolve(String(args.workspace));
  const handoffSchema = await readJson(handoffSchemaPath);
  if (manifest.runId !== brief.runId || manifest.taskId !== brief.taskId || manifest.agentId !== brief.agentId) throw new Error("opencode_agent_input_manifest_identity_mismatch");
  const commandArgs = buildOpenCodeRunArgs({ args, brief, manifestPath, manifest, workspace });
  emitRuntimeEvent("agent_input.manifest_loaded", {
    runId: brief.runId, taskId: brief.taskId, attempt: Number(manifest.attempt), manifestFingerprint: manifest.manifestFingerprint,
    attachments: manifestAttachmentPaths(manifest).length, accounting: manifest.accounting,
  });
  const executionTopology = resolveTaskExecutionTopology(brief);
  const runtimeAgentOverride = buildHeadlessRuntimeOverride({
    agentId: args.agentId,
    stepsLimit: Number(args.stepsLimit ?? brief.modelRouting?.stepsLimit ?? 100),
    executionTopology,
  });
  const attempt = Number(brief.modelRouting?.attempt ?? 1);
  const resolvedHandoffPath = resolve(String(args.handoff));
  const repairCheckpointPath = repairCheckpointPathForHandoff(resolvedHandoffPath);
  const resumeCheckpoint = await readRepairCheckpoint(repairCheckpointPath, { runId: brief.runId, taskId: brief.taskId, taskAttempt: attempt });
  const emitRepairEvent = (eventType, payload = {}) => {
    const effectKey = repairEffectKey({
      runId: brief.runId,
      taskId: brief.taskId,
      taskAttempt: payload.taskAttempt ?? attempt,
      repairKind: payload.repairKind ?? "unknown",
      repairPass: payload.repairPass ?? payload.repairPasses ?? 0,
      sourceRevision: payload.sourceRevision ?? 0,
      eventType,
    });
    emitRuntimeEvent(eventType, { ...payload, effectKey });
    return effectKey;
  };

  emitRuntimeEvent("opencode.execution_topology", {
    agentId: String(args.agentId),
    orchestrationRole: executionTopology.orchestrationRole,
    interactiveMode: executionTopology.interactiveMode,
    sessionRole: executionTopology.sessionRole,
    compatibility: executionTopology.compatibility ?? null,
  });

  let result = { status: 0, signal: null, timedOut: false, aborted: false, stdout: "", stderr: "" };
  let sessionId = null;
  let sessionExport = null;
  let sessionExportResult = null;
  let usage = null;
  let usageSource = "unavailable";
  let authority = null;
  let handoff = null;
  const isolatedState = await prepareIsolatedOpenCodeAttemptEnv({ manifestPath, attempt, env: process.env });
  const openCodeEnv = isolatedState.env;
  emitRuntimeEvent("opencode.state_isolated", {
    attempt,
    dataHome: isolatedState.dataHome,
    stateHome: isolatedState.stateHome,
    authCopied: isolatedState.authCopied,
    authority: "per-semantic-attempt-opencode-state",
  });

  if (resumeCheckpoint?.handoff && ["repair-started", "repair-completed", "repair-exhausted"].includes(resumeCheckpoint.status)) {
    handoff = resumeCheckpoint.handoff;
    sessionId = resumeCheckpoint.sessionId ?? null;
    usage = resumeCheckpoint.usage ?? null;
    usageSource = "durable-repair-checkpoint";
    authority = { authoritySource: "durable-repair-checkpoint", schemaValid: true, schemaErrors: [], sessionExportUsable: false, sessionExportFallbackReason: "repair_resume", normalization: null };
    const dispatchGeneration = Number(process.env.AGENT_HARNESS_AGENT_DISPATCH_GENERATION ?? 0);
    const fencingToken = Number(process.env.AGENT_HARNESS_AGENT_FENCING_TOKEN ?? 0);
    const resumeReceipt = await writeRepairResumeReceipt(repairResumeReceiptPathForHandoff(resolvedHandoffPath), {
      runId: brief.runId,
      taskId: brief.taskId,
      taskAttempt: attempt,
      sourceTaskAttempt: Number(resumeCheckpoint.taskAttempt ?? attempt),
      dispatchGeneration,
      fencingToken,
      repairKind: resumeCheckpoint.repairKind ?? null,
      repairPass: resumeCheckpoint.repairPass ?? null,
      checkpointStatus: resumeCheckpoint.status,
      checkpointEffectKey: resumeCheckpoint.effectKey ?? null,
      sourceRevision: resumeCheckpoint.sourceRevision ?? null,
      repairedRevision: resumeCheckpoint.repairedRevision ?? null,
      sameTaskAttempt: Number(resumeCheckpoint.taskAttempt ?? attempt) === attempt,
      skippedFullAgentInvocation: true,
      agentInputManifestFingerprint: manifest.manifestFingerprint,
    });
    emitRuntimeEvent("repair.resume_checkpoint_loaded", {
      effectKey: resumeReceipt.effectKey,
      checkpointEffectKey: resumeCheckpoint.effectKey ?? null,
      repairKind: resumeCheckpoint.repairKind ?? null,
      repairPass: resumeCheckpoint.repairPass ?? null,
      sourceTaskAttempt: resumeCheckpoint.taskAttempt ?? null,
      taskAttempt: attempt,
      dispatchGeneration,
      fencingToken,
      sourceRevision: resumeCheckpoint.sourceRevision ?? null,
      repairedRevision: resumeCheckpoint.repairedRevision ?? null,
      sameTaskAttempt: Number(resumeCheckpoint.taskAttempt ?? attempt) === attempt,
      skippedFullAgentInvocation: true,
    });
  } else {
    emitRuntimeEvent("opencode.launching", { agentId: String(args.agentId), modelId: String(args.model) });
    let sessionProbe = "";
    let observedSessionId = null;
    const openCodeInvocation = resolveOpenCodeInvocation(openCodeEnv);
    result = await runProcess(openCodeInvocation.command, [...openCodeInvocation.prefixArgs, ...commandArgs], {
      cwd: workspace,
      timeoutMs: Number(process.env.AGENT_HARNESS_AGENT_TASK_TIMEOUT_MS ?? 3_600_000),
      env: {
        ...openCodeEnv,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(runtimeAgentOverride),
        OPENCODE_PERMISSION: JSON.stringify({ question: "deny" }),
        AGENT_HARNESS_AGENT_REASONING_EFFORT: String(args.reasoningEffort ?? brief.modelRouting?.reasoningEffort ?? "medium"),
      },
      onSpawn: ({ pid }) => emitRuntimeEvent("opencode.spawned", { pid, agentId: String(args.agentId), modelId: String(args.model) }),
      onStdout: (chunk) => {
        process.stdout.write(chunk);
        if (!observedSessionId) {
          sessionProbe = `${sessionProbe}${chunk}`.slice(-131_072);
          const observed = sessionIdFromOutput(sessionProbe);
          if (observed) {
            observedSessionId = observed;
            emitRuntimeEvent("opencode.session.observed", { sessionId: observed });
          }
        }
      },
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    emitRuntimeEvent("opencode.completed", { status: result.status, signal: result.signal, timedOut: result.timedOut, aborted: result.aborted });
    const agentFallback = detectOpenCodeAgentFallback(result.stderr ?? "", args.agentId);
    if (agentFallback) {
      emitRuntimeEvent("opencode.agent_fallback_detected", agentFallback);
      throw new Error(`opencode_agent_fallback_detected:${agentFallback.requestedAgentId}`);
    }
    if (result.status !== 0) process.exit(result.status || 1);

    sessionId = observedSessionId ?? sessionIdFromOutput(result.stdout ?? "");
    if (sessionId) {
      try {
        sessionExportResult = await exportOpenCodeSession({ sessionId, workspace, outputPath: resolve(String(args.handoff)), env: openCodeEnv });
        if (sessionExportResult.status === 0 && sessionExportResult.stdout?.trim()) sessionExport = sessionExportResult.stdout;
        emitRuntimeEvent("opencode.session_export", {
          sessionId, status: sessionExportResult.status, attempt: sessionExportResult.attempt, usable: sessionExportResult.usable === true,
          bytes: Buffer.byteLength(sessionExportResult.stdout ?? ""), attempts: sessionExportResult.attempts ?? [],
        });
      } catch (error) {
        emitRuntimeEvent("opencode.session_export", { sessionId, status: null, usable: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const exportedUsage = sessionExport ? usageFromSessionExport(sessionExport) : null;
    const streamedUsage = usageFromOutput(result.stdout ?? "");
    usage = exportedUsage ?? streamedUsage;
    usageSource = exportedUsage ? "session-export" : streamedUsage ? "json-stream" : "unavailable";

    authority = resolveAuthoritativeHandoff({ stdout: result.stdout ?? "", sessionExport, handoffSchema, brief, attempt });
    handoff = authority.handoff;
    await armQualificationProcessLossBoundary({
      brief,
      handoff,
      sessionId,
      usage,
      repairCheckpointPath,
      resumeCheckpoint,
    });
  }
  const structuredRunner = (options) => runOpenCodeStructuredOutput({ ...options, env: openCodeEnv });
  emitRuntimeEvent("opencode.handoff_authority_resolved", {
    source: authority.authoritySource,
    schemaValid: authority.schemaValid,
    schemaErrors: authority.schemaErrors,
    sessionExportUsable: authority.sessionExportUsable,
    sessionExportFallbackReason: authority.sessionExportFallbackReason,
  });
  const strippedTelemetry = stripModelOwnedHandoffTelemetry(handoff);
  handoff = strippedTelemetry.handoff;
  if (strippedTelemetry.removedFields.length > 0) {
    emitRuntimeEvent("opencode.model_owned_telemetry_discarded", {
      removedFields: strippedTelemetry.removedFields,
      authority: "runtime-owned-telemetry-envelope",
    });
  }
  const initialContractNormalization = authority.normalization ?? normalizeModelHandoffContract({ handoff, brief, attempt });
  if (initialContractNormalization.changed) {
    emitRuntimeEvent("opencode.handoff_contract_normalized", {
      remappedFields: initialContractNormalization.remappedFields,
      removedFields: initialContractNormalization.removedFields,
      defaultedFields: initialContractNormalization.defaultedFields,
      droppedValidationEntries: initialContractNormalization.droppedValidationEntries,
      mechanicallyNormalizedEntries: initialContractNormalization.mechanicallyNormalizedEntries ?? [],
    });
    if ((initialContractNormalization.mechanicallyNormalizedEntries ?? []).length > 0) {
      emitRepairEvent("repair.started", { repairKind: "handoff-mechanical", repairPass: 1, taskAttempt: attempt, sameTaskAttempt: true });
      await writeRepairCheckpoint(repairCheckpointPath, {
        runId: brief.runId, taskId: brief.taskId, taskAttempt: attempt, repairKind: "handoff-mechanical", repairPass: 1,
        status: "repair-completed", handoff, sessionId, usage, sourceRevision: handoff?.implementationPlan?.revision ?? 0,
      });
      emitRepairEvent("repair.completed", {
        repairKind: "handoff-mechanical", repairPass: 1, taskAttempt: attempt, sameTaskAttempt: true,
        normalizedEntries: initialContractNormalization.mechanicallyNormalizedEntries.length,
      });
      const estimatedAvoidedMs = Math.max(0, Date.now() - executorStartedAt) + Number(process.env.AGENT_HARNESS_RUNTIME_RETRY_DEFAULT_DELAY_MS ?? 30_000);
      handoff.findings = [
        ...(handoff.findings ?? []),
        {
          type: "runtime_repair",
          repairKind: "handoff-mechanical",
          status: "completed",
          repairPass: 1,
          taskAttempt: attempt,
          sameTaskAttempt: true,
          normalizedEntries: initialContractNormalization.mechanicallyNormalizedEntries.length,
          avoidedFullRetry: true,
          estimatedAvoidedMs,
          estimateClass: "counterfactual",
        },
      ];
      emitRepairEvent("retry.full_attempt_avoided", {
        repairKind: "handoff-mechanical", failureCode: "handoff_schema_invalid", taskAttempt: attempt, repairPass: 1, estimatedAvoidedMs, estimateClass: "counterfactual",
      });
    }
  }

  const exhaustedProductCriteriaCheckpoint = resumeCheckpoint?.status === "repair-exhausted"
    && resumeCheckpoint?.repairKind === "product-discovery-acceptance-criteria";
  const productCriteriaIssue = !exhaustedProductCriteriaCheckpoint
    ? productDiscoveryAcceptanceCriteriaIssue({ brief, handoff, requireComplete: true })
    : null;
  if (productCriteriaIssue) {
    const taskAttempt = Number(brief.modelRouting?.attempt ?? 1);
    const sourceRevision = Number(handoff?.sddReview?.reviewedRevision ?? 0);
    await writeRepairCheckpoint(repairCheckpointPath, {
      runId: brief.runId,
      taskId: brief.taskId,
      taskAttempt,
      repairKind: "product-discovery-acceptance-criteria",
      repairPass: 1,
      repairPassLimit: 1,
      status: "repair-started",
      sourceRevision,
      handoff,
      sessionId,
      usage,
      failureCode: productCriteriaIssue.code,
    });
    emitRepairEvent("repair.started", {
      repairKind: "product-discovery-acceptance-criteria",
      repairPass: 1,
      repairPassLimit: 1,
      taskAttempt,
      sameTaskAttempt: true,
      failureCode: productCriteriaIssue.code,
      sourceRevision,
    });
    try {
      const projection = await projectProductDiscoveryAcceptanceCriteria({
        workspace, model: String(args.model), brief, handoff, structuredRunner,
      });
      handoff = projection.handoff;
      if (projection.attempted) {
        const estimatedAvoidedMs = Math.max(0, Date.now() - executorStartedAt)
          + Number(process.env.AGENT_HARNESS_RUNTIME_RETRY_DEFAULT_DELAY_MS ?? 30_000);
        handoff.findings = [
          ...(handoff.findings ?? []),
          {
            type: "runtime_repair",
            repairKind: "product-discovery-acceptance-criteria",
            status: "completed",
            repairPass: 1,
            taskAttempt,
            sameTaskAttempt: true,
            avoidedFullRetry: true,
            estimatedAvoidedMs,
            estimateClass: "counterfactual",
            failureCode: productCriteriaIssue.code,
          },
        ];
        await writeRepairCheckpoint(repairCheckpointPath, {
          runId: brief.runId,
          taskId: brief.taskId,
          taskAttempt,
          repairKind: "product-discovery-acceptance-criteria",
          repairPass: 1,
          repairPassLimit: 1,
          status: "repair-completed",
          sourceRevision,
          handoff,
          sessionId,
          usage,
          failureCode: productCriteriaIssue.code,
        });
        emitRuntimeEvent("opencode.product_discovery_acceptance_criteria_projection", {
          failureCode: productCriteriaIssue.code,
          modelId: String(args.model),
          sessionId: projection.sessionId ?? null,
          evidencePaths: projection.evidencePaths ?? [],
          authority: "bounded-product-discovery-acceptance-criteria-projection",
        });
        emitRepairEvent("repair.completed", {
          repairKind: "product-discovery-acceptance-criteria",
          repairPass: 1,
          taskAttempt,
          sameTaskAttempt: true,
          failureCode: productCriteriaIssue.code,
          sourceRevision,
          estimatedAvoidedMs,
        });
        emitRepairEvent("retry.full_attempt_avoided", {
          repairKind: "product-discovery-acceptance-criteria",
          failureCode: productCriteriaIssue.code,
          taskAttempt,
          repairPass: 1,
          estimatedAvoidedMs,
          estimateClass: "counterfactual",
          sourceRevision,
        });
        process.stderr.write(`product_discovery_acceptance_criteria_projection_succeeded:${productCriteriaIssue.code}\n`);
      }
    } catch (error) {
      handoff.findings = [
        ...(handoff.findings ?? []),
        {
          type: "runtime_repair",
          repairKind: "product-discovery-acceptance-criteria",
          status: "exhausted",
          repairPass: 1,
          taskAttempt,
          sameTaskAttempt: true,
          failureCode: productCriteriaIssue.code,
          error: error instanceof Error ? error.message : String(error),
          nextDisposition: "true-task-retry-no-contract-backoff",
        },
      ];
      await writeRepairCheckpoint(repairCheckpointPath, {
        runId: brief.runId,
        taskId: brief.taskId,
        taskAttempt,
        repairKind: "product-discovery-acceptance-criteria",
        repairPass: 1,
        repairPassLimit: 1,
        status: "repair-exhausted",
        sourceRevision,
        handoff,
        sessionId,
        usage,
        failureCode: productCriteriaIssue.code,
      });
      emitRepairEvent("repair.exhausted", {
        repairKind: "product-discovery-acceptance-criteria",
        repairPass: 1,
        repairPasses: 1,
        taskAttempt,
        sameTaskAttempt: true,
        failureCode: productCriteriaIssue.code,
        sourceRevision,
      });
      process.stderr.write(`product_discovery_acceptance_criteria_projection_failed:${productCriteriaIssue.code}:${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  try {
    const scopeRepair = await repairProductDiscoveryScopeBlock({
      workspace, model: String(args.model), brief, handoff, structuredRunner,
    });
    handoff = scopeRepair.handoff;
    if (scopeRepair.attempted) {
      emitRuntimeEvent("opencode.product_discovery_scope_repair", {
        reason: scopeRepair.reason,
        modelId: String(args.model),
        sessionId: scopeRepair.sessionId ?? null,
      });
      process.stderr.write(`product_discovery_scope_repair_succeeded:${scopeRepair.reason}\n`);
    }
  } catch (error) {
    handoff.findings = [
      ...(handoff.findings ?? []),
      {
        type: "product_discovery_scope_repair",
        status: "failed",
        reason: "bounded_stage_scope_repair_failed",
        error: error instanceof Error ? error.message : String(error),
      },
    ];
    process.stderr.write(`product_discovery_scope_repair_failed:${error instanceof Error ? error.message : String(error)}\n`);
  }

  if (brief.sdd?.stage === "product-discovery" && handoff.status === "complete") {
    try {
      const runtimeRegistry = await loadAgentCatalog(process.env.AGENT_HARNESS_ROOT || workspace);
      const projection = await projectMissingProductDiscoveryBootstrapAssessment({
        workspace, model: String(args.model), brief, contextPacket, handoff, handoffSchema, registry: runtimeRegistry, structuredRunner,
      });
      handoff = projection.handoff;
      if (projection.attempted) {
        emitRuntimeEvent("opencode.product_discovery_bootstrap_assessment_projection", {
          modelId: String(args.model),
          sessionId: projection.sessionId ?? null,
          authority: "bounded-product-discovery-assessment-projection",
        });
        process.stderr.write(`product_discovery_bootstrap_assessment_projection_succeeded:model=${String(args.model)}\n`);
      }
    } catch (error) {
      handoff.findings = [
        ...(handoff.findings ?? []),
        {
          type: "product_discovery_bootstrap_assessment_projection",
          status: "failed",
          reason: "bootstrap_review_assessment_missing_or_invalid",
          error: error instanceof Error ? error.message : String(error),
        },
      ];
      process.stderr.write(`product_discovery_bootstrap_assessment_projection_failed:${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  if (shouldSynthesizeTechnicalPlan({ brief, handoff })) {
    try {
      const implementationPlanSchema = await readJson(resolve(workspace, ".agents", "schemas", "implementation-plan.schema.json"));
      const synthesis = await synthesizeMissingImplementationPlan({ workspace, brief, handoff, implementationPlanSchema, structuredRunner });
      handoff = synthesis.handoff;
      if (synthesis.attempted) {
        // A review decision authored before the implementation plan was repaired
        // cannot approve the repaired plan. Force a bounded review projection only
        // after the final plan, runtime validations and criterion evidence exist.
        if (handoff.sddReview) {
          delete handoff.sddReview;
          handoff.findings = [
            ...(handoff.findings ?? []),
            { type: "sdd_review_invalidated", status: "required", reason: "implementation_plan_repaired_after_review" },
          ];
        }
        process.stderr.write(`technical_plan_synthesis_succeeded:model=${synthesis.model}:repair_passes=${synthesis.repairPasses ?? 0}\n`);
      }
    } catch (error) {
      handoff.findings = [
        ...(handoff.findings ?? []),
        {
          type: "technical_plan_synthesis",
          status: "failed",
          reason: "implementation_plan_missing_or_invalid",
          error: error instanceof Error ? error.message : String(error),
        },
      ];
      process.stderr.write(`technical_plan_synthesis_failed:${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (handoff.status === "complete") {
    try {
      const validationSynthesis = await synthesizeRequiredValidationEvidence({ workspace, brief, handoff });
      handoff = validationSynthesis.handoff;
      if (validationSynthesis.attempted) {
        process.stderr.write(`runtime_validation_evidence_succeeded:commands=${validationSynthesis.commands.length}\n`);
        emitRuntimeEvent("opencode.runtime_validation_evidence", {
          commands: validationSynthesis.commands,
          passed: validationSynthesis.results.filter((item) => item.result === "passed").length,
          failed: validationSynthesis.results.filter((item) => item.result !== "passed").length,
        });
      }
    } catch (error) {
      handoff.findings = [
        ...(handoff.findings ?? []),
        {
          type: "runtime_validation_evidence",
          status: "failed",
          reason: "required_validation_execution_failed",
          error: error instanceof Error ? error.message : String(error),
        },
      ];
      process.stderr.write(`runtime_validation_evidence_failed:${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  const missingCriterionIds = missingCompletionCriterionIds(brief, handoff);
  if (handoff.status === "complete" && missingCriterionIds.length > 0) {
    try {
      const synthesis = await synthesizeMissingCriterionResults({ workspace, brief, handoff, structuredRunner });
      handoff = synthesis.handoff;
      if (synthesis.attempted) {
        process.stderr.write(`completion_evidence_synthesis_succeeded:model=${synthesis.model}:criteria=${synthesis.missingIds.join(",")}\n`);
      }
    } catch (error) {
      handoff.findings = [
        ...(handoff.findings ?? []),
        {
          type: "completion_evidence_synthesis",
          status: "failed",
          reason: "blocking_criterion_result_missing",
          criterionIds: missingCriterionIds,
          error: error instanceof Error ? error.message : String(error),
        },
      ];
      process.stderr.write(`completion_evidence_synthesis_failed:${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (requiresStructuredHandoffFinalization({ brief, handoff, handoffSchema, contextPacket })) {
    try {
      const structured = await finalizeHandoffStructured({
        workspace, model: String(args.model), brief, contextPacket, handoff, handoffSchema, structuredRunner,
      });
      handoff = structured.handoff;
      emitRuntimeEvent("opencode.handoff_structured_finalization", {
        reason: "review_or_envelope_projection_required",
        modelId: String(args.model),
        sessionId: structured.sessionId,
      });
    } catch (error) {
      handoff.findings = [
        ...(handoff.findings ?? []),
        {
          type: "handoff_structured_finalization",
          status: "failed",
          reason: "review_or_envelope_projection_failed",
          error: error instanceof Error ? error.message : String(error),
        },
      ];
      process.stderr.write(`handoff_structured_finalization_failed:${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  const exhaustedTechnicalReviewCheckpoint = resumeCheckpoint?.status === "repair-exhausted"
    && resumeCheckpoint?.repairKind === "technical-review-semantic";
  if (brief.sdd?.stage === "technical-refinement" && handoff.status === "complete"
      && handoff.sddReview?.decision === "changes_requested" && !exhaustedTechnicalReviewCheckpoint) {
    const implementationPlanSchema = await readJson(resolve(workspace, ".agents", "schemas", "implementation-plan.schema.json"));
    const configuredRepairPasses = Number(process.env.AGENT_HARNESS_TECHNICAL_REVIEW_REPAIR_PASSES ?? 2);
    const repairPassLimit = Math.max(1, Math.min(3, Number.isFinite(configuredRepairPasses) ? Math.trunc(configuredRepairPasses) : 2));
    const taskAttempt = Number(brief.modelRouting?.attempt ?? 1);
    let repaired = false;
    const resumeRepairPass = resumeCheckpoint?.repairKind === "technical-review-semantic"
      ? Math.max(1, Number(resumeCheckpoint.repairPass ?? 1) + (resumeCheckpoint.status === "repair-completed" ? 1 : 0))
      : 1;
    for (let repairPass = resumeRepairPass; repairPass <= repairPassLimit && handoff.sddReview?.decision === "changes_requested"; repairPass += 1) {
      const requiredDeltas = [...(handoff.sddReview?.requiredDeltas ?? [])];
      const sourceRevision = Number(handoff.implementationPlan?.revision ?? 0);
      await writeRepairCheckpoint(repairCheckpointPath, {
        runId: brief.runId, taskId: brief.taskId, taskAttempt, repairKind: "technical-review-semantic", repairPass, repairPassLimit,
        status: "repair-started", sourceRevision, handoff, sessionId, usage,
      });
      emitRepairEvent("repair.started", {
        repairKind: "technical-review-semantic", repairPass, repairPassLimit, taskAttempt, requiredDeltaCount: requiredDeltas.length, sameTaskAttempt: true, sourceRevision,
      });
      try {
        const repair = await repairImplementationPlanFromReview({
          workspace,
          brief,
          handoff,
          implementationPlanSchema,
          model: String(args.model),
          repairPass,
          structuredRunner,
        });
        handoff = repair.handoff;
        const reprojected = await finalizeHandoffStructured({
          workspace, model: String(args.model), brief, contextPacket, handoff, handoffSchema, structuredRunner,
        });
        handoff = reprojected.handoff;
        if (handoff.sddReview?.decision === "approved") {
          const estimatedAvoidedMs = Math.max(0, Date.now() - executorStartedAt) + Number(process.env.AGENT_HARNESS_RUNTIME_RETRY_DEFAULT_DELAY_MS ?? 30_000);
          handoff.findings = [
            ...(handoff.findings ?? []),
            {
              type: "runtime_repair",
              repairKind: "technical-review-semantic",
              status: "completed",
              repairPass,
              taskAttempt,
              sameTaskAttempt: true,
              avoidedFullRetry: true,
              estimatedAvoidedMs,
              estimateClass: "counterfactual",
              sourceRevision: repair.sourceRevision,
              repairedRevision: repair.repairedRevision,
              requiredDeltas,
            },
          ];
          await writeRepairCheckpoint(repairCheckpointPath, {
            runId: brief.runId, taskId: brief.taskId, taskAttempt, repairKind: "technical-review-semantic", repairPass,
            status: "repair-completed", sourceRevision: repair.sourceRevision, repairedRevision: repair.repairedRevision, handoff, sessionId, usage,
          });
          emitRepairEvent("repair.completed", {
            repairKind: "technical-review-semantic", repairPass, taskAttempt, sameTaskAttempt: true, avoidedFullRetry: true, estimatedAvoidedMs,
            sourceRevision: repair.sourceRevision, repairedRevision: repair.repairedRevision,
          });
          emitRepairEvent("retry.full_attempt_avoided", {
            repairKind: "technical-review-semantic", failureCode: "review_not_approved", taskAttempt, repairPass, estimatedAvoidedMs, estimateClass: "counterfactual",
            sourceRevision: repair.sourceRevision,
          });
          repaired = true;
          break;
        }
        if (handoff.sddReview?.decision === "blocked") break;
      } catch (error) {
        handoff.findings = [
          ...(handoff.findings ?? []),
          {
            type: "runtime_repair",
            repairKind: "technical-review-semantic",
            status: "failed",
            repairPass,
            taskAttempt,
            sameTaskAttempt: true,
            requiredDeltas,
            error: error instanceof Error ? error.message : String(error),
          },
        ];
        process.stderr.write(`technical_review_same_attempt_repair_failed:pass=${repairPass}:${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (!repaired && handoff.sddReview?.decision === "changes_requested") {
      handoff.findings = [
        ...(handoff.findings ?? []),
        {
          type: "runtime_repair",
          repairKind: "technical-review-semantic",
          status: "exhausted",
          repairPasses: repairPassLimit,
          taskAttempt,
          sameTaskAttempt: true,
          nextDisposition: "true-task-retry-no-contract-backoff",
        },
      ];
      await writeRepairCheckpoint(repairCheckpointPath, {
        runId: brief.runId, taskId: brief.taskId, taskAttempt, repairKind: "technical-review-semantic", repairPass: repairPassLimit,
        status: "repair-exhausted", sourceRevision: handoff.implementationPlan?.revision ?? 0, handoff, sessionId, usage,
      });
      emitRepairEvent("repair.exhausted", { repairKind: "technical-review-semantic", repairPasses: repairPassLimit, taskAttempt, failureCode: "review_not_approved", sourceRevision: handoff.implementationPlan?.revision ?? 0 });
    }
  }

  const finalContractNormalization = normalizeModelHandoffContract({
    handoff,
    brief,
    attempt: Number(brief.modelRouting?.attempt ?? 1),
  });
  handoff = finalContractNormalization.handoff;
  if (finalContractNormalization.changed) {
    emitRuntimeEvent("opencode.handoff_contract_normalized", {
      remappedFields: finalContractNormalization.remappedFields,
      removedFields: finalContractNormalization.removedFields,
      defaultedFields: finalContractNormalization.defaultedFields,
      droppedValidationEntries: finalContractNormalization.droppedValidationEntries,
      mechanicallyNormalizedEntries: finalContractNormalization.mechanicallyNormalizedEntries ?? [],
    });
    if ((finalContractNormalization.mechanicallyNormalizedEntries ?? []).length > 0) {
      const estimatedAvoidedMs = Math.max(0, Date.now() - executorStartedAt) + Number(process.env.AGENT_HARNESS_RUNTIME_RETRY_DEFAULT_DELAY_MS ?? 30_000);
      handoff.findings = [
        ...(handoff.findings ?? []),
        {
          type: "runtime_repair",
          repairKind: "handoff-mechanical",
          status: "completed",
          repairPass: 1,
          taskAttempt: attempt,
          sameTaskAttempt: true,
          normalizedEntries: finalContractNormalization.mechanicallyNormalizedEntries.length,
          avoidedFullRetry: true,
          estimatedAvoidedMs,
          estimateClass: "counterfactual",
        },
      ];
      emitRepairEvent("repair.completed", { repairKind: "handoff-mechanical", repairPass: 1, taskAttempt: attempt, sameTaskAttempt: true, estimatedAvoidedMs });
    }
  }
  const stepsLimit = Number(args.stepsLimit ?? brief.modelRouting?.stepsLimit ?? 0);
  const priorMetrics = handoff.metrics ?? {};
  handoff.metrics = {
    ...priorMetrics,
    ...(usage ? {
      inputTokens: Number(priorMetrics.inputTokens ?? 0) + usage.input,
      outputTokens: Number(priorMetrics.outputTokens ?? 0) + usage.output,
      cachedInputTokens: Number(priorMetrics.cachedInputTokens ?? 0) + usage.cacheRead,
      costUsd: Number(priorMetrics.costUsd ?? 0) + usage.cost,
    } : {}),
  };
  handoff.executionTelemetry = {
    ...(handoff.executionTelemetry ?? {}),
    modelId: String(args.model),
    variant: args.variant ? String(args.variant) : null,
    reasoningEffort: String(args.reasoningEffort ?? brief.modelRouting?.reasoningEffort ?? "medium"),
    stepsLimit,
    stepsUsed: usage?.stepCount ?? handoff.executionTelemetry?.stepsUsed ?? null,
    stepLimitReached: usage ? usage.stepCount >= stepsLimit : handoff.executionTelemetry?.stepLimitReached ?? null,
    stopReason: usage?.lastReason ?? handoff.executionTelemetry?.stopReason ?? "model_final_response",
    attempt: Number(brief.modelRouting?.attempt ?? 1),
    sessionId,
    usageSource,
  };
  const normalizedTelemetry = sanitizeHandoffTelemetryShape(handoff);
  handoff = normalizedTelemetry.handoff;
  if (normalizedTelemetry.removedMetricKeys.length || normalizedTelemetry.removedExecutionTelemetryKeys.length) {
    emitRuntimeEvent("opencode.handoff_telemetry_normalized", {
      removedMetricKeys: normalizedTelemetry.removedMetricKeys,
      removedExecutionTelemetryKeys: normalizedTelemetry.removedExecutionTelemetryKeys,
    });
  }
  const finalSchemaValidation = validateAgainstSchema(handoff, handoffSchema, "handoffResult");
  if (!finalSchemaValidation.valid) {
    const sourceRevision = Number(handoff?.implementationPlan?.revision ?? handoff?.sddReview?.reviewedRevision ?? 0);
    await writeRepairCheckpoint(repairCheckpointPath, {
      runId: brief.runId,
      taskId: brief.taskId,
      taskAttempt: attempt,
      repairKind: "handoff-schema",
      repairPass: 1,
      repairPassLimit: 1,
      status: "repair-exhausted",
      sourceRevision,
      handoff,
      sessionId,
      usage,
      failureCode: "handoff_schema_invalid",
      schemaErrors: finalSchemaValidation.errors,
    });
    emitRepairEvent("repair.exhausted", {
      repairKind: "handoff-schema",
      repairPass: 1,
      repairPasses: 1,
      taskAttempt: attempt,
      sameTaskAttempt: true,
      failureCode: "handoff_schema_invalid",
      sourceRevision,
      schemaErrorCount: finalSchemaValidation.errors.length,
    });
    throw new Error(`schema_validation_failed:handoffResult:${finalSchemaValidation.errors.join("; ")}`);
  }
  assertSchema(handoff, handoffSchema, "handoffResult");
  await writeJson(resolve(String(args.handoff)), handoff);
}

export { buildOpenCodeRunArgs, parseHandoff, promptFor, sessionIdFromOutput };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
