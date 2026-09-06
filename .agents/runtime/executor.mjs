import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildContextPacket, buildTaskBrief } from "./context-builder.mjs";
import { persistContextReady } from "./context-ready.mjs";
import { resolveTaskExecutionTopology } from "./agent-topology.mjs";
import { evaluateCompletion } from "./completion-gate.mjs";
import { isSddReviewStage, requiredReviewDecision, validateSddReviewContract } from "./review-contract.mjs";
import { canonicalizeImplementationPlanAcceptanceCriteria, collectImplementationPlanValidationIssues, compileImplementationDag, saveCompiledDag } from "./dag-compiler.mjs";
import { assertSchema } from "./schema-validator.mjs";
import { cleanupWorkspace, createIsolatedWorkspace, inspectWorkspaceChanges, integrateWorkspace, reconcileHandoffPathDisposition } from "./workspace.mjs";
import { runProcess } from "./process.mjs";
import { resolveTaskReasoning } from "./reasoning.mjs";
import { computeEphemeralPort, dockerLifecycleScopeId, ServiceLifecycleManager } from "./service-lifecycle.mjs";
import { exists, fileFingerprint, nowIso, readJson, sha256, sleep, writeJson, runtimeTaskDirectoryName } from "./utils.mjs";
import { sanitizeHandoffTelemetryShape } from "./handoff-telemetry.mjs";
import { productDiscoveryAcceptanceCriteriaIssue } from "./product-discovery-acceptance-criteria.mjs";
import { classifyHandoffValidationError, normalizeModelHandoffContract } from "./handoff-contract.mjs";
import { assertPolicyAllowed, recordPolicyDecision } from "./policy-engine.mjs";
import { deriveRetryBudgetState, repairEffectKey } from "./retry-efficiency.mjs";
import { bootstrapTopologyReadyForTask, normalizeProductDiscoveryReviewAssessment } from "./bootstrap-topology-refiner.mjs";
import { recordReplayCapsuleArtifact, updateReplayCapsuleEvidence } from "./run-replay.mjs";
import { stableFingerprint } from "./event-driven-contracts.mjs";

function commandFromTemplate(template, values) {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`executor_template_unknown_placeholder:${key}`);
    return JSON.stringify(String(values[key]));
  });
}

const EXECUTOR_HEARTBEAT_INTERVAL_MS = 5_000;
const RUNTIME_EVENT_PREFIX = "@@agentic-harness-runtime-event ";

async function snapshotTerminalReplayCapsule({ repositoryRoot, plan, schemas, store, terminal }) {
  if (!store?.listEvents || !store?.listArtifacts || !store?.listCheckpoints) return null;
  const updated = await updateReplayCapsuleEvidence(repositoryRoot, plan.runId, {
    events: await store.listEvents(plan.runId),
    artifacts: await store.listArtifacts(plan.runId),
    checkpoints: await store.listCheckpoints(plan.runId),
    terminal,
    schemas,
  });
  if (!updated) return null;
  await recordReplayCapsuleArtifact(store, {
    runId: plan.runId,
    path: updated.path,
    capsule: updated.capsule,
    stage: "terminal",
  });
  return updated;
}

export function createPostExecutionActivityHeartbeat({ record, intervalMs = EXECUTOR_HEARTBEAT_INTERVAL_MS }) {
  let phase = "post-executor";
  let timer = null;
  let active = false;
  const startedMs = Date.now();
  const emit = async (type, payload = {}) => await record(type, {
    phase,
    elapsedMs: Date.now() - startedMs,
    ...payload,
  });
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (active) return;
        active = true;
        Promise.resolve(emit("task.post_execution.heartbeat"))
          .catch(() => {})
          .finally(() => { active = false; });
      }, intervalMs);
      timer.unref?.();
    },
    async setPhase(nextPhase, payload = {}) {
      phase = String(nextPhase);
      await emit("task.post_execution.phase", payload);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get phase() { return phase; },
  };
}

function closeWritable(stream) {
  return new Promise((resolve) => stream.end(resolve));
}

function createRuntimeEventDecoder(onEvent) {
  let pending = "";
  const consume = (line) => {
    const index = line.indexOf(RUNTIME_EVENT_PREFIX);
    if (index < 0) return;
    const encoded = line.slice(index + RUNTIME_EVENT_PREFIX.length).trim();
    if (!encoded) return;
    try {
      const value = JSON.parse(encoded);
      if (value?.type) onEvent(value);
    } catch {}
  };
  return {
    push(chunk) {
      pending += String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
    },
    flush() {
      if (pending) consume(pending);
      pending = "";
    },
  };
}

// --------------- Docker Lifecycle Integration ---------------

/**
 * Service name to container port mapping for ephemeral port computation.
 * Must match the mapping in service-lifecycle.mjs buildEphemeralPortMap.
 */
const SERVICE_PORT_MAP = {
  postgres: { container: 5432, env: "AGENT_HARNESS_VALIDATION_POSTGRES_PORT" },
  rabbitmq: { container: 5672, env: "AGENT_HARNESS_VALIDATION_RABBITMQ_AMQP_PORT" },
  redis: { container: 6379, env: "AGENT_HARNESS_VALIDATION_REDIS_PORT" },
  "context-engine": { container: 8789, env: "AGENT_HARNESS_VALIDATION_CONTEXT_ENGINE_PORT" },
  "context-embeddings": { container: 80, env: "AGENT_HARNESS_VALIDATION_EMBEDDINGS_PORT" },
};

/**
 * Check whether Docker validation is enabled via feature flag.
 * Default: enabled (true), disabled when AGENT_HARNESS_AGENT_DOCKER_VALIDATION=false.
 */
export function isDockerValidationEnabled() {
  return process.env.AGENT_HARNESS_AGENT_DOCKER_VALIDATION !== "false";
}

/**
 * Resolve the Docker profile for a single agent.
 * Returns the profile object { name, services } or null if the agent has no Docker profile (profile=none or missing).
 *
 * @param {object} options
 * @param {string} options.agentId
 * @param {object} options.registry - Loaded distributed agent capability catalog (with agents array)
 * @param {object|null} options.dockerProfiles - Loaded .agents/docker-profiles.json or null
 * @returns {{ name: string, services: string[] } | null}
 */
export function resolveAgentDockerProfile({ agentId, registry, dockerProfiles }) {
  if (!dockerProfiles) return null;

  const agent = registry.agents?.find((a) => a.id === agentId);
  if (!agent) return null;

  const profileName = agent.dockerProfile;
  if (!profileName || profileName === "none") return null;

  const profile = dockerProfiles.profiles?.[profileName];
  if (!profile) return null;

  // For "dynamic" profile, the services list is empty (resolved at run time)
  if (profileName === "dynamic") return { name: "dynamic", services: [] };

  // For other profiles, return the services list
  return { name: profileName, services: profile.services ?? [] };
}

/**
 * Resolve the Docker profile for a run by computing the union of agent profiles.
 * Used for agents with dockerProfile = "dynamic" (e.g., verification-evidence).
 * Returns the profile { name, services } or null if all agents have no Docker profile.
 *
 * @param {object} options
 * @param {Map<string, {agentId: string}>} options.taskPlans
 * @param {object} options.registry
 * @param {object|null} options.dockerProfiles
 * @returns {{ name: string, services: string[] } | null}
 */
export function resolveRunDockerProfile({ taskPlans, registry, dockerProfiles }) {
  if (!dockerProfiles) return null;

  const serviceSet = new Set();

  for (const taskPlan of taskPlans.values()) {
    const agentProfile = resolveAgentDockerProfile({
      agentId: taskPlan.agentId,
      registry,
      dockerProfiles,
    });
    if (agentProfile && agentProfile.name !== "none") {
      for (const service of agentProfile.services) {
        serviceSet.add(service);
      }
    }
  }

  if (serviceSet.size === 0) return null;

  return {
    name: "dynamic",
    services: [...serviceSet],
  };
}

/**
 * Build environment variables for Docker lifecycle service ports.
 * Computes ephemeral ports deterministically from runId and injects them
 * as AGENT_HARNESS_VALIDATION_*_PORT env vars.
 *
 * @param {object} options
 * @param {string} options.runId
 * @param {string[]} options.services
 * @returns {Record<string, string>}
 */
export function buildDockerLifecycleEnv({ runId, taskId = null, services }) {
  const env = {};
  const basePort = computeEphemeralPort(dockerLifecycleScopeId(runId, taskId));
  const entries = Object.entries(SERVICE_PORT_MAP);

  for (const service of services) {
    // Find the primary service mapping (e.g., "postgres")
    const entry = entries.find(([key]) => key === service);
    if (entry) {
      const offset = entries.findIndex(([k]) => k === service);
      const port = ((basePort + offset - 30000) % 10000) + 30000;
      env[entry[1].env] = String(port);
    }
  }


  return env;
}

/**
 * Orchestrate the Docker lifecycle for a task: preflight → up → waitForHealth.
 * Returns the lifecycle result and the lifecycle manager instance for teardown.
 *
 * @param {object} options
 * @param {string} options.repositoryRoot
 * @param {string} options.runId
 * @param {{name: string, services: string[]}} options.profile
 * @param {number} options.timeoutMs
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{status: string, code?: string, lifecycleManager: ServiceLifecycleManager | null, lifecycleEnv: Record<string, string> | null}>}
 */
export async function orchestrateDockerLifecycle({ repositoryRoot, runId, taskId = null, profile, timeoutMs, signal }) {
  const lifecycleManager = new ServiceLifecycleManager({
    repositoryRoot,
    runId,
    taskId,
  });

  // Step 1: Preflight
  const preflight = await lifecycleManager.preflight();
  if (!preflight.available) {
    return {
      status: "blocked",
      code: "docker_unavailable",
      lifecycleManager,
      lifecycleEnv: null,
    };
  }

  // Step 2: Up
  const up = await lifecycleManager.up(profile);
  if (up.status !== "ok") {
    return {
      status: "blocked",
      code: up.code ?? "service_conflict",
      lifecycleManager,
      lifecycleEnv: null,
    };
  }

  // Step 3: Compute env vars (must match what the compose override generated)
  const lifecycleEnv = buildDockerLifecycleEnv({ runId, taskId, services: profile.services });

  // Step 4: Wait for health
  const health = await lifecycleManager.waitForHealth(timeoutMs, { signal });
  if (health.status !== "ok") {
    return {
      status: "blocked",
      code: health.code ?? "service_healthcheck_timeout",
      lifecycleManager,
      lifecycleEnv,
    };
  }

  return {
    status: "ok",
    lifecycleManager,
    lifecycleEnv,
  };
}

/**
 * Compile the dockerValidation array for the Integration Decision from tasks and their handoffs.
 *
 * @param {Array<{task_id: string, status: string}>} tasks - Task rows from the store
 * @param {Map<string, object|null>} handoffs - Map of taskId to handoff object (or null if no handoff)
 * @returns {Array<{taskId: string, profile: string, result: string, services: string[], limitation: string|null}>}
 */
export function compileDockerValidation(tasks, handoffs) {
  return tasks
    .filter((task) => handoffs.get(task.task_id) != null)
    .map((task) => {
      const handoff = handoffs.get(task.task_id);
      const dv = handoff?.dockerValidation;
      const result =
        task.status === "integrated" || task.status === "verified" ? "pass" :
        task.status === "failed" ? "fail" : "blocked";

      return {
        taskId: task.task_id,
        profile: dv?.profile ?? "none",
        result,
        services: dv?.services?.map((s) => (typeof s === "string" ? s : s.name)) ?? [],
        limitation: dv?.error ?? null,
      };
    });
}

/**
 * Compile a dockerValidationSummary from the dockerValidation array and task list.
 * Produces counts for: totalTasks, tasksWithDocker, tasksValidated, tasksBlocked, tasksWithMocks.
 *
 * @param {Array<{taskId: string, profile: string, result: string, services: string[], limitation: string|null}>} dockerValidation
 * @param {Array<{task_id: string, status: string}>} tasks
 * @returns {{ totalTasks: number, tasksWithDocker: number, tasksValidated: number, tasksBlocked: number, tasksWithMocks: number }}
 */
export function compileDockerValidationSummary(dockerValidation, tasks) {
  const totalTasks = tasks.length;
  const tasksWithDocker = dockerValidation.filter((dv) => dv.profile !== "none").length;
  const tasksValidated = dockerValidation.filter((dv) => dv.result === "pass" && dv.profile !== "none").length;
  const tasksBlocked = dockerValidation.filter((dv) => dv.result === "blocked").length;
  const tasksWithMocks = dockerValidation.filter((dv) => dv.profile === "none").length;

  return {
    totalTasks,
    tasksWithDocker,
    tasksValidated,
    tasksBlocked,
    tasksWithMocks,
  };
}

/**
 * Determine the refined run status considering Docker validation limitations.
 *
 * Rules:
 *   - Code failures (status "failed") always result in run status "failed".
 *   - Tasks blocked only by Docker unavailability or healthcheck timeout, with no code failures
 *     and all other tasks integrated → "closed" (with limitation documented in dockerValidation).
 *   - Tasks blocked for other reasons (non-Docker) with no code failures → "blocked".
 *   - Cancelled tasks with no failures/blocks → "cancelled".
 *   - All tasks integrated/verified → "closed".
 *
 * @param {Array<{task_id: string, status: string}>} tasks - Task rows from the store
 * @param {Array<{taskId: string, profile: string, result: string, services: string[], limitation: string|null}>} dockerValidation
 * @returns {string} run status: "failed" | "blocked" | "cancelled" | "closed"
 */
export function determineRunStatusWithDocker(tasks, dockerValidation) {
  void dockerValidation;
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.some((task) => task.status === "cancelled")) return "cancelled";
  if (tasks.some((task) => !["integrated", "verified"].includes(task.status))) return "failed";
  return "closed";
}

/**
 * Classify a validation command failure into code, service, or environmental category.
 *
 * Categories:
 *   - "code": validationCommands failed against healthy services (or no lifecycle used).
 *   - "service": a Docker service became unhealthy during validation.
 *   - "environmental": Docker unavailable or healthcheck timeout (limitation, not code fault).
 *
 * @param {object} options
 * @param {{ status: number, timedOut: boolean, stderr: string, stdout: string, error: { message?: string } | null }} options.result
 * @param {{ allHealthy: boolean, unhealthyServices: string[] } | null} options.preTeardownHealth
 * @param {{ code: string, message: string } | null} options.dockerBlocked
 * @param {boolean} options.lifecycleUsed
 * @returns {{ code: string, message: string, retryable: boolean, category: 'code' | 'service' | 'environmental' }}
 */

function providerRetryAfterFromMessage(value) {
  const text = String(value ?? "");
  const ms = text.match(/retry[-_ ]?after(?:ms)?\s*[:=]\s*(\d{1,9})\s*ms/i);
  if (ms) return Math.max(0, Number(ms[1]));
  const seconds = text.match(/retry[-_ ]?after\s*[:=]\s*(\d{1,7})(?:\s*s(?:ec(?:onds?)?)?)?\b/i);
  if (seconds) return Math.max(0, Number(seconds[1]) * 1000);
  return null;
}

export function classifyValidationFailure({ result, preTeardownHealth, dockerBlocked, lifecycleUsed }) {
  // Case 1: Docker lifecycle was blocked before execution (environmental limitation)
  if (dockerBlocked) {
    return {
      code: dockerBlocked.code,
      message: dockerBlocked.message,
      retryable: false,
      category: "environmental",
    };
  }

  // Case 2: Service(s) became unhealthy during validation (service failure)
  if (lifecycleUsed && preTeardownHealth && !preTeardownHealth.allHealthy) {
    const names = (preTeardownHealth.unhealthyServices || []).join(", ");
    return {
      code: "executor_service_failed",
      message: `Service(s) unhealthy during validation: ${names}`.slice(0, 4_000),
      retryable: true,
      category: "service",
    };
  }

  // A requested Runtime V2 specialist must never silently execute as OpenCode's
  // default primary agent. Retrying the same config cannot repair this contract.
  const rawMessage = result.stderr || result.stdout || result.error?.message || "executor failed";
  const providerRetryAfterMs = providerRetryAfterFromMessage(rawMessage);
  if (/\b429\b|rate[ -]?limit|too many requests/i.test(String(rawMessage))) {
    return {
      code: "provider_rate_limited",
      message: String(rawMessage).slice(0, 4_000),
      retryable: true,
      category: "provider",
      providerRetryAfterMs,
    };
  }
  if (String(rawMessage).includes("opencode_agent_fallback_detected:")) {
    return {
      code: "opencode_agent_fallback_detected",
      message: String(rawMessage).slice(0, 4_000),
      retryable: false,
      category: "code",
    };
  }
  if (String(rawMessage).includes("schema_validation_failed:handoffResult:")) {
    return {
      code: "handoff_schema_invalid",
      message: String(rawMessage).slice(0, 4_000),
      retryable: true,
      category: "contract",
      repairExhausted: true,
    };
  }
  if (String(rawMessage).includes("handoff_identity_mismatch:")) {
    return {
      code: "handoff_identity_mismatch",
      message: String(rawMessage).slice(0, 4_000),
      retryable: false,
      category: "contract",
    };
  }
  if (/\bdatabase is locked\b/i.test(String(rawMessage))) {
    return {
      code: "opencode_state_database_locked",
      message: String(rawMessage).slice(0, 4_000),
      retryable: true,
      category: "tooling-infrastructure",
    };
  }

  // Case 3: execution liveness failures are retryable but semantically distinct.
  // This lets routing escalate immediately without pretending a provider stall
  // or soft execution budget was a contract rejection.
  const message = String(rawMessage).slice(0, 4_000);
  if (result.stalled) {
    return { code: "executor_stalled", message, retryable: true, category: "liveness" };
  }
  if (result.softTimedOut) {
    return { code: "executor_soft_timeout", message, retryable: true, category: "liveness" };
  }
  return {
    code: result.timedOut ? "executor_timeout" : "executor_exit_nonzero",
    message,
    retryable: true,
    category: result.timedOut ? "liveness" : "code",
  };
}

async function taskStateMap(store, runId) {
  return new Map((await store.listTasks(runId)).map((task) => [task.task_id, task.status]));
}

function dependenciesSatisfied(task, states) {
  const dependencies = JSON.parse(task.dependencies_json);
  return dependencies.every((dependency) => ["integrated", "verified", "complete"].includes(states.get(dependency)));
}

function dependenciesFailed(task, states) {
  const dependencies = JSON.parse(task.dependencies_json);
  return dependencies.some((dependency) => ["failed", "blocked", "cancelled"].includes(states.get(dependency)));
}

export async function stageContractFailure(taskPlan, handoff, schemas, registry, plan, store, brief = null) {
  const stage = taskPlan.stage ?? "implementation";
  if (stage === "product-discovery") {
    const requiresBootstrapAssessment = plan?.workflow?.bootstrapFactTopology === "fact-capability-v2"
      || plan?.provenance?.plannerVersion === "capability-fact-planner/v1";
    if (requiresBootstrapAssessment) {
      if (!handoff?.bootstrapReviewAssessment) {
        return {
          code: "product_discovery_bootstrap_assessment_missing",
          message: "Product Discovery must emit bootstrapReviewAssessment before bootstrap review topology can be refined",
          retryable: true,
          category: "contract",
          repairExhausted: true,
        };
      }
      try {
        normalizeProductDiscoveryReviewAssessment(handoff, registry);
      } catch (error) {
        return {
          code: "product_discovery_bootstrap_assessment_invalid",
          message: String(error?.message ?? error),
          retryable: true,
          category: "contract",
          repairExhausted: true,
        };
      }
    }
    const criteriaIssue = productDiscoveryAcceptanceCriteriaIssue({
      brief: brief ?? { sdd: { stage }, acceptanceCriteria: [] },
      handoff,
    });
    if (criteriaIssue) {
      const messages = {
        product_acceptance_criteria_missing: "Product Owner must emit stable product acceptanceCriteria",
        product_acceptance_process_criterion_leaked: `Runtime process criterion ${criteriaIssue.criterionId ?? "unknown"} must not appear in Product Owner product acceptanceCriteria`,
        product_acceptance_criterion_invalid: `Product acceptance criterion ${criteriaIssue.criterionId ?? "unknown"} requires id, source, statement, blocking and verification`,
        product_acceptance_proof_stage_missing: `Product acceptance criterion ${criteriaIssue.criterionId ?? "unknown"} must emit explicit proofStage`,
        product_acceptance_proof_stage_invalid: `Product acceptance criterion ${criteriaIssue.criterionId ?? "unknown"} has invalid proofStage`,
        product_acceptance_implementation_proof_missing: "Product Discovery must classify at least one product criterion as proofStage=implementation so Technical Refinement can compile implementation work",
        product_acceptance_criterion_duplicate: `Duplicate product acceptance criterion: ${criteriaIssue.criterionId ?? "unknown"}`,
      };
      return {
        code: criteriaIssue.code,
        message: messages[criteriaIssue.code] ?? criteriaIssue.reason,
        retryable: true,
        category: "contract",
        repairExhausted: true,
      };
    }
  }
  if (stage === "technical-refinement") {
    try {
      const poArtifact = (await store.listArtifacts(plan.runId))
        .filter((artifact) => artifact.task_id === plan.workflow.productOwnerTaskId && artifact.kind === "handoff" && Number(artifact.accepted) === 1)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      if (!poArtifact) throw new Error("product_owner_handoff_artifact_missing");
      const poHandoff = await readJson(poArtifact.path);
      const requiredAcceptanceCriteria = poHandoff.acceptanceCriteria ?? [];
      const canonical = canonicalizeImplementationPlanAcceptanceCriteria(handoff.implementationPlan, requiredAcceptanceCriteria);
      if (canonical.normalized) {
        // The Technical Lead review must approve the exact plan that is compiled.
        // A late canonicalization here would mutate a plan after sddReview was
        // authored/projected, so fail closed and let the next task attempt repair
        // the plan before the review projection instead of silently rewriting it.
        await store.event(plan.runId, taskPlan.taskId, "implementation_plan.acceptance_criteria_rejected_after_review", {
          omittedIds: canonical.omittedIds,
          extraIds: canonical.extraIds,
          mutatedIds: canonical.mutatedIds,
          authority: "product-owner-acceptance-criteria",
        });
        throw new Error(`technical_lead_reviewed_noncanonical_plan:omitted=${canonical.omittedIds.join(",")}:extra=${canonical.extraIds.join(",")}:mutated=${canonical.mutatedIds.join(",")}`);
      }
      compileImplementationDag({
        registry, plan, technicalLeadHandoff: handoff, schemas,
        requiredAcceptanceCriteria,
      });
    } catch (error) {
      return { code: "implementation_plan_invalid", message: error.message, retryable: true, category: "contract", repairExhausted: true };
    }
  }
  if (isSddReviewStage(stage)) {
    const effectiveBrief = brief ?? { agentId: taskPlan.agentId, sdd: { role: taskPlan.sddRole ?? taskPlan.role ?? taskPlan.agentId, stage, reviewedRevision: 1 } };
    const contract = validateSddReviewContract({ brief: effectiveBrief, handoff });
    if (!contract.valid) {
      const missingDecision = ["review_missing", "review_decision_invalid"].includes(contract.code);
      return {
        code: stage === "product-acceptance"
          ? (missingDecision ? "product_not_accepted" : "product_review_contract_invalid")
          : (missingDecision ? "review_not_approved" : "review_contract_invalid"),
        message: contract.message,
        retryable: handoff.sddReview?.decision !== "blocked",
        category: "review",
        reviewDecision: handoff.sddReview?.decision ?? null,
        repairExhausted: handoff.sddReview?.decision === "changes_requested",
      };
    }
    const expected = requiredReviewDecision(stage);
    if (handoff.sddReview.decision !== expected) {
      return {
        code: stage === "product-acceptance" ? "product_not_accepted" : "review_not_approved",
        message: `Stage ${stage} requires sddReview.decision=${expected}`,
        retryable: handoff.sddReview.decision !== "blocked",
        category: "review",
        reviewDecision: handoff.sddReview.decision,
        repairExhausted: handoff.sddReview.decision === "changes_requested",
      };
    }
  }
  return null;
}

async function loadDockerProfiles(repositoryRoot) {
  try {
    const profilesPath = join(repositoryRoot, ".agents", "docker-profiles.json");
    if (!(await exists(profilesPath))) return null;
    return await readJson(profilesPath);
  } catch {
    return null;
  }
}

export async function executeTask({ repositoryRoot, runDirectory, plan, taskPlan, registry, schemas, store, options }) {
  if (!options?.policyEngine) {
    const error = new Error("runtime_policy_engine_required:execute-task");
    error.code = "runtime_policy_engine_required";
    throw error;
  }
  const taskRow = await store.getTask(taskPlan.taskId);
  const reasoning = await resolveTaskReasoning({
    plan,
    taskPlan,
    taskRow,
    store,
    baseContextBudgetBytes: options.contextBudgetBytes,
  });
  const attempt = reasoning.attempt;
  const startedAt = nowIso();
  await store.updateTask(taskPlan.taskId, {
    status: "running",
    attempt,
    started_at: startedAt,
    error_code: null,
    error_message: null,
    reasoning_level: reasoning.level,
    reasoning_source: reasoning.source,
    reasoning_reasons_json: JSON.stringify(reasoning.reasons),
  });
  await store.event(plan.runId, taskPlan.taskId, "reasoning.selected", reasoning);
  if (reasoning.level !== reasoning.baseLevel) {
    await store.event(plan.runId, taskPlan.taskId, "reasoning.promoted", {
      from: reasoning.baseLevel,
      to: reasoning.level,
      reasons: reasoning.reasons,
      attempt,
    });
  }
  await store.event(plan.runId, taskPlan.taskId, "task.running", { agentId: taskPlan.agentId, attempt, reasoningLevel: reasoning.level });
  const upstreamArtifacts = (await store.listArtifacts(plan.runId))
    .filter((artifact) => JSON.parse(taskRow.dependencies_json).includes(artifact.task_id) && artifact.accepted)
    .map((artifact) => ({ artifactId: artifact.artifact_id, version: artifact.version, producer: artifact.task_id, path: artifact.path }));
  const { packet, path: contextPath, metrics: contextMetrics } = await buildContextPacket({ repositoryRoot, registry, plan, task: taskPlan, schemas, budgetBytes: reasoning.contextBudgetBytes, upstreamArtifacts, contextProvider: options.contextProvider ?? null });
  const { brief, path: briefPath } = await buildTaskBrief({ repositoryRoot, registry, plan, task: taskPlan, contextPacket: packet, schemas, maxAttempts: options.maxAttempts, reasoning });
  await store.updateTask(taskPlan.taskId, {
    model_id: brief.modelRouting.model,
    model_variant: brief.modelRouting.variant ?? null,
    reasoning_effort: brief.modelRouting.reasoningEffort,
    steps_limit: brief.modelRouting.stepsLimit,
  });
  const executionTopology = resolveTaskExecutionTopology(brief);
  await store.event(plan.runId, taskPlan.taskId, "model.route.selected", brief.modelRouting);
  await store.event(plan.runId, taskPlan.taskId, "execution.topology.selected", {
    orchestrationRole: executionTopology.orchestrationRole,
    interactiveMode: executionTopology.interactiveMode,
    sessionRole: executionTopology.sessionRole,
    compatibility: executionTopology.compatibility ?? null,
  });
  const taskDirectory = join(runDirectory, "tasks", runtimeTaskDirectoryName(taskPlan.taskId, taskPlan.agentId));
  const handoffPath = join(taskDirectory, `handoff-attempt-${attempt}.json`);
  const logPath = join(taskDirectory, `executor-attempt-${attempt}.log`);
  await mkdir(taskDirectory, { recursive: true });
  let liveLog = null;
  const workspace = await createIsolatedWorkspace({ repositoryRoot, runDirectory, task: taskPlan, mode: options.workspaceMode });
  await store.updateTask(taskPlan.taskId, {
    brief_path: briefPath,
    context_path: contextPath,
    handoff_path: handoffPath,
    workspace_path: workspace.path,
    context_bytes: packet.usedBytes,
    context_documents: packet.references.filter((reference) => reference.included).length,
    estimated_tokens: packet.estimatedTokens,
  });
  await persistContextReady({
    store,
    runId: plan.runId,
    taskId: taskPlan.taskId,
    attempt: reasoning.attempt,
    packId: packet.contextEngine?.packId ?? null,
    packetId: packet.packetId ?? null,
    payload: {
      attempt: reasoning.attempt,
      bytes: packet.usedBytes,
      documents: packet.references.length,
      included: packet.references.filter((reference) => reference.included).length,
      packetEstimatedTokens: packet.estimatedTokens,
      runtimeBudgetBytes: contextMetrics?.runtimeBudgetBytes ?? reasoning.contextBudgetBytes,
      runtimeBudgetTokensEstimate: contextMetrics?.runtimeBudgetTokensEstimate ?? Math.ceil(reasoning.contextBudgetBytes / 4),
      contextEngineStatus: packet.contextEngine?.status ?? "unknown",
      cacheStatus: packet.contextEngine?.cacheStatus ?? null,
      packId: packet.contextEngine?.packId ?? null,
      contextEngineMetrics: contextMetrics?.contextEngine ?? null,
    },
  });

  const command = commandFromTemplate(options.executorCommand, {
    agentId: taskPlan.agentId,
    runId: plan.runId,
    taskId: taskPlan.taskId,
    taskBrief: briefPath,
    contextPacket: contextPath,
    workspace: workspace.path,
    handoff: handoffPath,
    repository: repositoryRoot,
    reasoningLevel: reasoning.level,
    reasoningMode: reasoning.mode,
    reasoningSource: reasoning.source,
    model: brief.modelRouting.model,
    variant: brief.modelRouting.variant ?? "",
    reasoningEffort: brief.modelRouting.reasoningEffort,
    stepsLimit: brief.modelRouting.stepsLimit,
  });
  const taskAbort = new AbortController();
  const forwardAbort = () => taskAbort.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  let cancellationCheckActive = false;
  const cancellationPoll = setInterval(async () => {
    if (cancellationCheckActive) return;
    cancellationCheckActive = true;
    try {
      if ((await store.getRun(plan.runId))?.status === "cancelled") taskAbort.abort("run_cancelled");
    } finally {
      cancellationCheckActive = false;
    }
  }, 250);
  cancellationPoll.unref();

  let executorHeartbeat = null;
  let executorHeartbeatActive = false;
  let executorStartedMs = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let lastOutputAt = null;
  let opencodeSpawned = false;
  const backgroundWrites = new Set();
  const scheduleStoreWrite = (promise) => {
    backgroundWrites.add(promise);
    promise.finally(() => backgroundWrites.delete(promise)).catch(() => {});
  };
  const recordTaskActivity = async (type, payload) => {
    const idempotentRepairEvent = (type.startsWith("repair.") || type === "retry.full_attempt_avoided") && payload?.effectKey;
    if (idempotentRepairEvent && typeof store.eventOnce === "function") await store.eventOnce(plan.runId, taskPlan.taskId, type, payload, payload.effectKey);
    else await store.event(plan.runId, taskPlan.taskId, type, payload);
    return await store.touchTask(taskPlan.taskId);
  };
  const runtimeEvents = createRuntimeEventDecoder((event) => {
    if (event.type === "opencode.spawned") opencodeSpawned = true;
    const payload = { ...(event.payload ?? {}), source: "opencode-task-executor" };
    scheduleStoreWrite(recordTaskActivity(event.type, payload));
    if (event.type === "opencode.session.observed" && payload.sessionId) {
      scheduleStoreWrite(store.updateTask(taskPlan.taskId, { opencode_session_id: String(payload.sessionId) }));
    }
  });

  // ---------- Docker Lifecycle Integration ----------
  let lifecycleManager = null;
  let lifecycleEnv = null;
  let dockerBlocked = null;
  let removeSignalTraps = null;

  if (isDockerValidationEnabled()) {
    const dockerProfiles = await loadDockerProfiles(repositoryRoot);

    // Resolve profile: if agent has dockerProfile = "dynamic", compute union from all run tasks
    const agentEntry = registry.agents?.find((a) => a.id === taskPlan.agentId);
    const isDynamic = agentEntry?.dockerProfile === "dynamic";

    const dockerProfile = isDynamic
      ? resolveRunDockerProfile({
          taskPlans: new Map(plan.tasks.map((t) => [t.taskId, t])),
          registry,
          dockerProfiles,
        })
      : resolveAgentDockerProfile({
          agentId: taskPlan.agentId,
          registry,
          dockerProfiles,
        });

    if (dockerProfile) {
      const lifecycleResult = await orchestrateDockerLifecycle({
        repositoryRoot,
        runId: plan.runId,
        taskId: taskPlan.taskId,
        profile: dockerProfile,
        timeoutMs: options.dockerHealthTimeoutMs ?? 600_000,
        signal: taskAbort.signal,
      });

      lifecycleManager = lifecycleResult.lifecycleManager;
      lifecycleEnv = lifecycleResult.lifecycleEnv;

      if (lifecycleResult.status === "blocked") {
        dockerBlocked = {
          code: lifecycleResult.code ?? "docker_blocked",
          message: `Docker lifecycle blocked: ${lifecycleResult.code}`,
          retryable: false,
          blocked: true,
          category: "environmental",
        };
        await store.event(plan.runId, taskPlan.taskId, "docker.lifecycle.blocked", {
          code: dockerBlocked.code,
          profile: dockerProfile.name,
        });
      } else {
        await store.event(plan.runId, taskPlan.taskId, "docker.lifecycle.ready", {
          profile: dockerProfile.name,
          services: dockerProfile.services,
        });
      }

      // Register signal traps for graceful teardown
      if (lifecycleManager) {
        removeSignalTraps = lifecycleManager.registerSignalTraps();
      }
    }
  }

  let result;
  let preTeardownHealth = null;
  try {
    // Skip execution if Docker lifecycle blocked
    if (dockerBlocked) {
      result = {
        status: 1,
        signal: null,
        stdout: "",
        stderr: dockerBlocked.message,
        error: null,
        timedOut: false,
        aborted: false,
      };
    } else {
      liveLog = createWriteStream(logPath, { flags: "w" });
      liveLog.write(`${JSON.stringify({ event: "executor.prepared", at: nowIso(), agentId: taskPlan.agentId, modelId: brief.modelRouting.model, attempt })}\n`);
      executorStartedMs = Date.now();
      await recordTaskActivity("executor.launching", {
        modelId: brief.modelRouting.model,
        variant: brief.modelRouting.variant ?? null,
        reasoningEffort: brief.modelRouting.reasoningEffort,
        stepsLimit: brief.modelRouting.stepsLimit,
        attempt,
      });
      executorHeartbeat = setInterval(() => {
        if (executorHeartbeatActive) return;
        executorHeartbeatActive = true;
        const heartbeatWrite = recordTaskActivity("executor.heartbeat", {
          elapsedMs: Date.now() - executorStartedMs,
          modelId: brief.modelRouting.model,
          stdoutBytes,
          stderrBytes,
          lastOutputAt,
          opencodeSpawned,
        }).finally(() => { executorHeartbeatActive = false; });
        scheduleStoreWrite(heartbeatWrite);
      }, EXECUTOR_HEARTBEAT_INTERVAL_MS);
      executorHeartbeat.unref();
      result = await runProcess(command, [], {
        cwd: workspace.path,
        shell: true,
        timeoutMs: options.taskTimeoutMs,
        signal: taskAbort.signal,
        env: {
          ...process.env,
          ...(lifecycleEnv ?? {}),
          AGENT_HARNESS_AGENT_ID: taskPlan.agentId,
          AGENT_HARNESS_AGENT_RUN_ID: plan.runId,
          AGENT_HARNESS_AGENT_TASK_ID: taskPlan.taskId,
          AGENT_HARNESS_AGENT_TASK_BRIEF: briefPath,
          AGENT_HARNESS_AGENT_CONTEXT_PACKET: contextPath,
          AGENT_HARNESS_AGENT_HANDOFF: handoffPath,
          AGENT_HARNESS_AGENT_WORKSPACE: workspace.path,
          AGENT_HARNESS_AGENT_REASONING_LEVEL: reasoning.level,
          AGENT_HARNESS_AGENT_REASONING_MODE: reasoning.mode,
          AGENT_HARNESS_AGENT_REASONING_SOURCE: reasoning.source,
          AGENT_HARNESS_AGENT_MODEL: brief.modelRouting.model,
          AGENT_HARNESS_AGENT_MODEL_VARIANT: brief.modelRouting.variant ?? "",
          AGENT_HARNESS_AGENT_REASONING_EFFORT: brief.modelRouting.reasoningEffort,
          AGENT_HARNESS_AGENT_STEPS_LIMIT: String(brief.modelRouting.stepsLimit),
          AGENT_HARNESS_AGENT_ORCHESTRATION_ROLE: executionTopology.orchestrationRole,
          AGENT_HARNESS_AGENT_INTERACTIVE_MODE: executionTopology.interactiveMode,
          AGENT_HARNESS_AGENT_SESSION_ROLE: executionTopology.sessionRole,
        },
        onSpawn: ({ pid }) => {
          liveLog.write(`${JSON.stringify({ event: "executor.spawned", at: nowIso(), pid })}\n`);
          scheduleStoreWrite(recordTaskActivity("executor.spawned", { pid, modelId: brief.modelRouting.model }));
        },
        onStdout: (chunk) => {
          stdoutBytes += Buffer.byteLength(chunk);
          lastOutputAt = nowIso();
          liveLog.write(chunk);
        },
        onStderr: (chunk) => {
          stderrBytes += Buffer.byteLength(chunk);
          lastOutputAt = nowIso();
          liveLog.write(chunk);
          runtimeEvents.push(chunk);
        },
      });
      runtimeEvents.flush();
      if (executorHeartbeat) clearInterval(executorHeartbeat);
      executorHeartbeat = null;
      if (backgroundWrites.size > 0) await Promise.allSettled([...backgroundWrites]);
      await recordTaskActivity("executor.completed", {
        status: result.status,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        elapsedMs: Date.now() - executorStartedMs,
        stdoutBytes,
        stderrBytes,
        opencodeSpawned,
      });
    }

    // Check service health before teardown (for failure classification)
    if (lifecycleManager && !dockerBlocked) {
      try {
        preTeardownHealth = await lifecycleManager.checkHealth();
      } catch {
        // Health check failed — will fall back to code classification
      }
    }
  } finally {
    if (executorHeartbeat) clearInterval(executorHeartbeat);
    runtimeEvents.flush();
    if (backgroundWrites.size > 0) await Promise.allSettled([...backgroundWrites]);
    if (liveLog) await closeWritable(liveLog);
    // Docker teardown (guaranteed on all exit paths)
    if (lifecycleManager) {
      try {
        await lifecycleManager.down();
      } catch {
        // Best-effort: teardown failure should not mask execution result
      }
    }
    if (removeSignalTraps) {
      try {
        removeSignalTraps();
      } catch {
        // Best-effort
      }
    }
    clearInterval(cancellationPoll);
    options.signal?.removeEventListener("abort", forwardAbort);
  }

  // If Docker lifecycle blocked the run, handle it as a failure
  if (dockerBlocked) {
    const completedAt = nowIso();
    const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
    await store.updateTask(taskPlan.taskId, {
      status: "blocked",
      completed_at: completedAt,
      duration_ms: durationMs,
      error_code: dockerBlocked.code,
      error_message: dockerBlocked.message,
    });
    await store.event(plan.runId, taskPlan.taskId, "task.blocked", {
      attempt,
      code: dockerBlocked.code,
      retryable: false,
    });
    await cleanupWorkspace(repositoryRoot, workspace);
    return { status: "blocked", failure: dockerBlocked };
  }

  const postExecutionActivity = createPostExecutionActivityHeartbeat({ record: recordTaskActivity });
  postExecutionActivity.start();
  try {
    await postExecutionActivity.setPhase("executor-artifacts", {
      executorStatus: result.status,
      handoffPresent: await exists(handoffPath),
    });
    await writeFile(logPath, `${result.stdout}\n--- STDERR ---\n${result.stderr}`, "utf8");
    await store.addArtifact({ runId: plan.runId, taskId: taskPlan.taskId, kind: "executor-log", version: `attempt-${attempt}`, path: logPath, sha256: sha256(await readFile(logPath)) });

    await postExecutionActivity.setPhase("handoff-validation", { handoffPresent: await exists(handoffPath) });
    let handoff = null;
  let failure = null;
  if (result.aborted) {
    failure = { code: "executor_cancelled", message: "Executor cancelled", retryable: false, cancelled: true, category: "code" };
  } else if (result.status !== 0) {
    failure = classifyValidationFailure({
      result,
      preTeardownHealth,
      dockerBlocked: null, // dockerBlocked case already handled above
      lifecycleUsed: lifecycleManager != null,
    });
  } else if (!(await exists(handoffPath))) {
    failure = { code: "handoff_missing", message: `Executor exited successfully without writing ${handoffPath}`, retryable: true };
  } else {
    try {
      handoff = await readJson(handoffPath);
      const normalizedContract = normalizeModelHandoffContract({ handoff, brief, attempt });
      handoff = normalizedContract.handoff;
      if (normalizedContract.changed) {
        await store.event(plan.runId, taskPlan.taskId, "handoff.contract_normalized", {
          remappedFields: normalizedContract.remappedFields,
          removedFields: normalizedContract.removedFields,
          defaultedFields: normalizedContract.defaultedFields,
          droppedValidationEntries: normalizedContract.droppedValidationEntries,
          authority: "semantic-control-plane",
        });
        await writeJson(handoffPath, handoff);
      }
      const normalizedTelemetry = sanitizeHandoffTelemetryShape(handoff);
      handoff = normalizedTelemetry.handoff;
      if (normalizedTelemetry.removedMetricKeys.length || normalizedTelemetry.removedExecutionTelemetryKeys.length) {
        await store.event(plan.runId, taskPlan.taskId, "handoff.telemetry_normalized", {
          removedMetricKeys: normalizedTelemetry.removedMetricKeys,
          removedExecutionTelemetryKeys: normalizedTelemetry.removedExecutionTelemetryKeys,
          authority: "runtime-owned-telemetry-envelope",
        });
        await writeJson(handoffPath, handoff);
      }
      assertSchema(handoff, schemas.handoffResult, "handoffResult");
      if (handoff.runId !== plan.runId || handoff.taskId !== taskPlan.taskId || handoff.agentId !== taskPlan.agentId) {
        throw new Error("handoff_identity_mismatch");
      }
    } catch (error) {
      failure = classifyHandoffValidationError(error);
    }
  }

  if (handoff) {
    for (const finding of handoff.findings ?? []) {
      await store.event(plan.runId, taskPlan.taskId, "handoff.finding", finding);
      if (finding?.type === "runtime_repair") {
        const repairEvent = finding.status === "candidate" ? "repair.started"
          : finding.status === "completed" ? "repair.completed"
          : finding.status === "exhausted" ? "repair.exhausted"
          : finding.status === "failed" ? "repair.failed"
          : null;
        const repairIdentity = { taskAttempt: finding.taskAttempt ?? attempt ?? null };
        if (repairEvent) {
          const effectKey = finding.effectKey ?? repairEffectKey({
            runId: plan.runId, taskId: taskPlan.taskId, taskAttempt: repairIdentity.taskAttempt, repairKind: finding.repairKind,
            repairPass: finding.repairPass ?? finding.repairPasses ?? 0, sourceRevision: finding.sourceRevision ?? 0, eventType: repairEvent,
          });
          const payload = { ...finding, ...repairIdentity, effectKey, authoritative: true };
          if (typeof store.eventOnce === "function") await store.eventOnce(plan.runId, taskPlan.taskId, repairEvent, payload, effectKey);
          else await store.event(plan.runId, taskPlan.taskId, repairEvent, payload);
        }
        if (finding.status === "completed" && finding.avoidedFullRetry === true) {
          const avoidedEffectKey = repairEffectKey({
            runId: plan.runId, taskId: taskPlan.taskId, taskAttempt: repairIdentity.taskAttempt, repairKind: finding.repairKind,
            repairPass: finding.repairPass ?? 0, sourceRevision: finding.sourceRevision ?? 0, eventType: "retry.full_attempt_avoided",
          });
          const avoidedPayload = {
            failureCode: finding.failureCode ?? (finding.repairKind === "technical-review-semantic" ? "review_not_approved" : "handoff_schema_invalid"),
            ...repairIdentity, repairPass: finding.repairPass ?? null, estimatedAvoidedMs: finding.estimatedAvoidedMs ?? null,
            estimateClass: finding.estimateClass ?? "counterfactual", effectKey: avoidedEffectKey,
          };
          if (typeof store.eventOnce === "function") await store.eventOnce(plan.runId, taskPlan.taskId, "retry.full_attempt_avoided", avoidedPayload, avoidedEffectKey);
          else await store.event(plan.runId, taskPlan.taskId, "retry.full_attempt_avoided", avoidedPayload);
        }
      }
    }
    await store.updateTask(taskPlan.taskId, {
      used_context_documents: handoff.usedContextPaths?.length ?? null,
      input_tokens: handoff.metrics?.inputTokens ?? null,
      output_tokens: handoff.metrics?.outputTokens ?? null,
      cached_input_tokens: handoff.metrics?.cachedInputTokens ?? null,
      cost_usd: handoff.metrics?.costUsd ?? null,
      model_id: handoff.executionTelemetry?.modelId ?? brief.modelRouting.model,
      model_variant: handoff.executionTelemetry?.variant ?? brief.modelRouting.variant ?? null,
      reasoning_effort: handoff.executionTelemetry?.reasoningEffort ?? brief.modelRouting.reasoningEffort,
      steps_limit: handoff.executionTelemetry?.stepsLimit ?? brief.modelRouting.stepsLimit,
      steps_used: handoff.executionTelemetry?.stepsUsed ?? null,
      step_limit_reached: handoff.executionTelemetry?.stepLimitReached ?? null,
      stop_reason: handoff.executionTelemetry?.stopReason ?? null,
      opencode_session_id: handoff.executionTelemetry?.sessionId ?? null,
    });
    // Inject Docker lifecycle evidence into handoff
    if (lifecycleManager) {
      handoff.dockerValidation = lifecycleManager.getEvidence();
    }
    handoff.executionTelemetry = {
      ...(handoff.executionTelemetry ?? {}),
      modelId: brief.modelRouting.model,
      variant: brief.modelRouting.variant ?? null,
      reasoningEffort: brief.modelRouting.reasoningEffort,
      stepsLimit: brief.modelRouting.stepsLimit,
      stepsUsed: handoff.executionTelemetry?.stepsUsed ?? null,
      stepLimitReached: handoff.executionTelemetry?.stepLimitReached ?? null,
      stopReason: handoff.executionTelemetry?.stopReason ?? (result.status === 0 ? "executor_exit_0" : "executor_nonzero"),
      attempt,
    };
    await writeJson(handoffPath, handoff);
    await store.event(plan.runId, taskPlan.taskId, "model.usage.observed", {
      attempt,
      modelId: handoff.executionTelemetry.modelId,
      inputTokens: Number(handoff.metrics?.inputTokens ?? 0),
      outputTokens: Number(handoff.metrics?.outputTokens ?? 0),
      cachedInputTokens: Number(handoff.metrics?.cachedInputTokens ?? 0),
      costUsd: Number(handoff.metrics?.costUsd ?? 0),
      stepsLimit: handoff.executionTelemetry.stepsLimit ?? null,
      stepsUsed: handoff.executionTelemetry.stepsUsed ?? null,
      auxiliaryInvocationCount: Array.isArray(handoff.auxiliaryInvocations) ? handoff.auxiliaryInvocations.length : 0,
    });
    await store.updateTask(taskPlan.taskId, {
      input_tokens: handoff.metrics?.inputTokens ?? null,
      output_tokens: handoff.metrics?.outputTokens ?? null,
      cached_input_tokens: handoff.metrics?.cachedInputTokens ?? null,
      cost_usd: handoff.metrics?.costUsd ?? null,
      model_id: handoff.executionTelemetry.modelId,
      model_variant: handoff.executionTelemetry.variant,
      reasoning_effort: handoff.executionTelemetry.reasoningEffort,
      steps_limit: handoff.executionTelemetry.stepsLimit,
      steps_used: handoff.executionTelemetry.stepsUsed,
      step_limit_reached: handoff.executionTelemetry.stepLimitReached,
      stop_reason: handoff.executionTelemetry.stopReason,
      opencode_session_id: handoff.executionTelemetry.sessionId ?? null,
    });
    if (handoff.status === "blocked") failure = { code: "agent_blocked", message: handoff.residualRisks.join("; ") || "agent blocked", retryable: false, blocked: true };
    else if (handoff.status === "cancelled") failure = { code: "agent_cancelled", message: "agent cancelled", retryable: false, cancelled: true };
    else if (handoff.status === "failed") failure = { code: "agent_failed", message: handoff.residualRisks.join("; ") || "agent failed", retryable: handoff.retryable === true };
  }

  if (!failure && handoff) {
    await postExecutionActivity.setPhase("completion-gate", { stage: taskPlan.stage });
    const stageFailure = await stageContractFailure(taskPlan, handoff, schemas, registry, plan, store, brief);
    if (stageFailure) failure = stageFailure;
    const completion = evaluateCompletion({ taskBrief: brief, handoff });
    if (!failure && !completion.accepted) {
      failure = { code: completion.code, message: completion.violations.join("; ") || "Completion was not proven", retryable: completion.retryable !== false, category: completion.category ?? "contract", repairExhausted: completion.repairExhausted === true, failureClass: completion.failureClass ?? null };
    }
    if (!failure) {
      await store.event(plan.runId, taskPlan.taskId, "completion.proven", { criteria: brief.acceptanceCriteria.map((criterion) => criterion.id), stage: taskPlan.stage, model: brief.modelRouting.model });
    } else {
      await store.event(plan.runId, taskPlan.taskId, "completion.rejected", { code: failure.code, stage: taskPlan.stage, model: brief.modelRouting.model });
    }
  }

  if (!failure && handoff) {
    await postExecutionActivity.setPhase("workspace-inspection", { workspaceMode: workspace.mode });
    const inspection = await inspectWorkspaceChanges(workspace, taskPlan);
    const disposition = await reconcileHandoffPathDisposition({
      workspace,
      task: taskPlan,
      inspection,
      handoff,
      changedPaths: handoff.changedPaths ?? [],
      reusedPaths: handoff.reusedPaths ?? [],
      contextReferencePaths: brief.readOnlyContextPaths ?? [],
    });
    if (inspection.toolingSideEffects.length > 0) {
      await store.event(plan.runId, taskPlan.taskId, "workspace.tooling_side_effects", { paths: inspection.toolingSideEffects });
    }
    const reusedSet = new Set(disposition.reusedPaths);
    const contextOnlySet = new Set(disposition.contextOnlyPaths ?? []);
    const fromChangedToReused = disposition.ghostDeclarations.filter((path) => reusedSet.has(path));
    const fromChangedToContext = disposition.ghostDeclarations.filter((path) => contextOnlySet.has(path));
    const fromReusedToChanged = disposition.reclassifiedReusedToChanged ?? [];
    if (fromChangedToReused.length > 0 || fromChangedToContext.length > 0 || fromReusedToChanged.length > 0) {
      await store.event(plan.runId, taskPlan.taskId, "handoff.path_disposition_normalized", {
        fromChangedToReused,
        fromChangedToContext,
        fromReusedToChanged,
        reason: fromReusedToChanged.length > 0 ? "workspace_change_authoritative" : "baseline_byte_identical",
      });
    }
    if (disposition.reusedPathFingerprints.length > 0) {
      await store.event(plan.runId, taskPlan.taskId, "workspace.reused_paths_verified", {
        paths: disposition.reusedPathFingerprints,
      });
    }
    if ((disposition.contextOnlyPathFingerprints ?? []).length > 0) {
      await store.event(plan.runId, taskPlan.taskId, "workspace.context_paths_verified", {
        paths: disposition.contextOnlyPathFingerprints,
      });
      handoff.usedContextPaths = [...new Set([...(handoff.usedContextPaths ?? []), ...disposition.contextOnlyPaths])].sort();
    }
    if ((disposition.droppedPhantomReusedPaths ?? []).length > 0) {
      await store.event(plan.runId, taskPlan.taskId, "workspace.phantom_reused_paths_dropped", {
        paths: disposition.droppedPhantomReusedPaths,
        authority: "workspace_and_baseline_absence",
        scope: "zero-file-governance-review-non-evidentiary-bookkeeping",
      });
    }
    if (disposition.invalidReused.length > 0) {
      failure = {
        code: "handoff_reused_paths_invalid",
        message: disposition.invalidReused.map((entry) => `${entry.path}:${entry.reason}`).join(","),
        retryable: false,
      };
    } else if (disposition.missingDeclaredChanges.length > 0) {
      const ignoredTooling = inspection.toolingSideEffects.length > 0 ? ` ignored_tooling=${inspection.toolingSideEffects.join(",")}` : "";
      failure = {
        code: "handoff_changed_paths_mismatch",
        message: `declared=${disposition.changedPaths.join(",")} actual=${inspection.changedPaths.join(",")} undeclared=${disposition.missingDeclaredChanges.join(",")}${ignoredTooling}`,
        retryable: false,
      };
    } else {
      handoff.changedPaths = disposition.changedPaths;
      handoff.reusedPaths = disposition.reusedPaths;
      await writeJson(handoffPath, handoff);
    }

    if (!failure) {
      try {
        await postExecutionActivity.setPhase("integration", { integrate: options.integrate, workspaceMode: workspace.mode });
        const finalInspection = options.integrate
          ? await integrateWorkspace({ repositoryRoot, workspace, task: taskPlan, store, runId: plan.runId })
          : inspection;
        const fingerprint = await fileFingerprint(handoffPath);
        const artifactId = await store.addArtifact({ runId: plan.runId, taskId: taskPlan.taskId, kind: "handoff", version: handoff.artifactVersion, path: handoffPath, sha256: fingerprint?.sha256 ?? null, accepted: true });
        const completedAt = nowIso();
        const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
        const terminalStatus = taskPlan.role === "verification" ? "verified" : "integrated";
        await store.updateTask(taskPlan.taskId, { status: terminalStatus, completed_at: completedAt, duration_ms: durationMs });
        await store.event(plan.runId, taskPlan.taskId, "task.integrated", { artifactId, changedPaths: finalInspection.changedPaths, reusedPaths: handoff.reusedPaths ?? [], toolingSideEffects: finalInspection.toolingSideEffects, durationMs, verification: taskPlan.role === "verification" });
        await postExecutionActivity.setPhase("workspace-cleanup", { terminalStatus });
        await cleanupWorkspace(repositoryRoot, workspace);
        return { status: terminalStatus, handoff, changedPaths: finalInspection.changedPaths };
      } catch (error) {
        failure = { code: "integration_failed", message: error.message, retryable: false };
      }
    }
  }

  const completedAt = nowIso();
  const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
  const retryBudgetState = deriveRetryBudgetState(await store.listEvents(plan.runId), { taskId: taskPlan.taskId, startedAtMs: Date.parse(startedAt) });
  const retryDecision = options.policyEngine.evaluateRetry({ failure, attempt, maxAttempts: options.maxAttempts, retryBudgetState });
  await recordPolicyDecision(store, { runId: plan.runId, taskId: taskPlan.taskId, operation: "retry", decision: retryDecision });
  const canRetry = retryDecision.allowed === true;
  const retryAfterMs = canRetry ? Math.max(0, Number(retryDecision.retryAfterMs ?? 0)) : null;
  const retryNotBefore = canRetry ? new Date(Date.now() + retryAfterMs).toISOString() : null;
  const status = failure.cancelled ? "cancelled" : failure.blocked ? "blocked" : canRetry ? "retrying" : "failed";
  await store.updateTask(taskPlan.taskId, {
    status,
    completed_at: canRetry ? null : completedAt,
    duration_ms: durationMs,
    error_code: failure.code,
    error_message: failure.message,
    retry_not_before: retryNotBefore,
  });
  await store.event(plan.runId, taskPlan.taskId, canRetry ? "task.retry_scheduled" : `task.${status}`, {
    attempt,
    code: failure.code,
    message: failure.message,
    failureCategory: failure.category ?? null,
    retryable: canRetry,
    retryAfterMs,
    retryNotBefore,
    retryDisposition: retryDecision.details?.retryDisposition ?? null,
    backoffApplied: retryAfterMs > 0,
    policyCode: retryDecision.code ?? null,
  });
  if (canRetry) {
    const retryDisposition = retryDecision.details?.retryDisposition ?? null;
    await store.event(plan.runId, taskPlan.taskId, "retry.true_scheduled", {
      attempt,
      failureCode: failure?.code ?? "execution_failed",
      failureCategory: failure?.category ?? null,
      failureMessage: String(failure?.message ?? "Execution failed").slice(0, 4_000),
      retryDisposition,
      retryAfterMs,
      retryNotBefore,
      backoffApplied: retryAfterMs > 0,
      repairExhausted: failure?.repairExhausted === true,
    });
    if (retryAfterMs > 0) await store.event(plan.runId, taskPlan.taskId, "retry.backoff_applied", { attempt, failureCode: failure?.code ?? "execution_failed", retryDisposition, retryAfterMs });
  }
  await postExecutionActivity.setPhase("workspace-cleanup", { terminalStatus: status, failureCode: failure.code });
  await cleanupWorkspace(repositoryRoot, workspace);
  if (canRetry) {
    await sleep(retryAfterMs);
    await store.updateTask(taskPlan.taskId, { status: "routed", retry_not_before: null });
  }
  return { status, failure };
  } finally {
    postExecutionActivity.stop();
  }
}

export async function finalizeExecution({ repositoryRoot, plan, schemas, store, policyEngine = null, peakParallel = null }) {
  const runDirectory = join(repositoryRoot, ".runtime", "agents", "runs", plan.runId);
  await mkdir(runDirectory, { recursive: true });
  const priorArtifact = (await store.listArtifacts(plan.runId))
    .find((artifact) => artifact.kind === "integration-decision" && artifact.version === "v2");
  if (priorArtifact && await exists(priorArtifact.path)) {
    const persistedRun = await store.getRun(plan.runId);
    const persistedStatus = persistedRun?.status ?? "closed";
    const duplicateTerminalEvidence = {
      status: persistedStatus,
      completedAt: persistedRun?.completed_at ?? null,
      duplicateFinalization: true,
      planPhase: plan.phase,
    };
    await snapshotTerminalReplayCapsule({ repositoryRoot, plan, schemas, store, terminal: duplicateTerminalEvidence });
    const duplicateWake = await store.materializeContinuationWake?.(plan.runId, { status: persistedStatus });
    await snapshotTerminalReplayCapsule({
      repositoryRoot,
      plan,
      schemas,
      store,
      terminal: {
        ...duplicateTerminalEvidence,
        continuationEvidenceCaptured: true,
        continuationDeliveryId: duplicateWake?.delivery?.delivery_id ?? duplicateWake?.delivery?.deliveryId ?? null,
        continuationEffectKey: duplicateWake?.delivery?.effect_key ?? duplicateWake?.delivery?.effectKey ?? null,
        continuationGeneration: duplicateWake?.delivery?.generation ?? null,
      },
    });
    return {
      status: persistedStatus,
      plan,
      integrationDecision: await readJson(priorArtifact.path),
      tasks: await store.listTasks(plan.runId),
      duplicatePrevented: true,
    };
  }

  const tasks = await store.listTasks(plan.runId);

  // Compile dockerValidation from task handoffs BEFORE determining run status
  const handoffArtifacts = (await store.listArtifacts(plan.runId)).filter((artifact) => artifact.kind === "handoff");
  const handoffs = new Map();
  for (const artifact of handoffArtifacts) {
    try {
      const handoff = await readJson(artifact.path);
      handoffs.set(artifact.task_id, handoff);
    } catch {
      // Handoff file may be missing or corrupt; skip
    }
  }
  const dockerValidation = compileDockerValidation(tasks, handoffs);

  // Determine run status using Docker-aware logic
  let status = determineRunStatusWithDocker(tasks, dockerValidation);
  const productAcceptancePlan = plan.tasks.find((task) => task.stage === "product-acceptance");
  const productAcceptanceRow = productAcceptancePlan ? tasks.find((task) => task.task_id === productAcceptancePlan.taskId) : null;
  if (plan.phase !== "compiled") status = "failed";
  if (!productAcceptanceRow || !["verified", "integrated"].includes(productAcceptanceRow.status)) {
    if (!["blocked", "cancelled"].includes(status)) status = "failed";
  }
  const failed = tasks.filter((task) => task.status === "failed");
  const blocked = tasks.filter((task) => task.status === "blocked");
  const cancelled = tasks.filter((task) => task.status === "cancelled");
  if (policyEngine) {
    const qaPlans = plan.tasks.filter((task) => task.stage === "quality-assurance");
    const readinessPlans = plan.tasks.filter((task) => task.stage === "operational-readiness");
    const successful = (taskPlan) => {
      const row = tasks.find((task) => task.task_id === taskPlan.taskId);
      return ["verified", "integrated"].includes(row?.status);
    };
    const promotionDecision = policyEngine.evaluatePromotion({
      qaAccepted: qaPlans.length > 0 && qaPlans.every(successful),
      readinessAccepted: readinessPlans.length === 0 || readinessPlans.every(successful),
      productAcceptanceAccepted: Boolean(productAcceptancePlan && successful(productAcceptancePlan)),
      blockingFailures: failed.length + blocked.length + cancelled.length,
    });
    await recordPolicyDecision(store, { runId: plan.runId, operation: "promotion", decision: promotionDecision });
    await store.event(plan.runId, null, "policy.promotion_decision", { ...promotionDecision, policyFingerprint: policyEngine.fingerprint });
    if (!promotionDecision.allowed && status === "closed") status = "failed";
  }
  const completedAt = nowIso();
  const observedPeak = peakParallel ?? Number((await store.getRun(plan.runId))?.peak_parallel ?? 0);
  await store.updateRun(plan.runId, { status, completed_at: completedAt, peak_parallel: observedPeak });
  await store.event(plan.runId, null, `run.${status}`, {
    failed: failed.length,
    blocked: blocked.length,
    cancelled: cancelled.length,
    dockerValidationSummary: compileDockerValidationSummary(dockerValidation, tasks),
    peakParallel: observedPeak,
    planPhase: plan.phase,
    productAcceptanceTaskId: productAcceptancePlan?.taskId ?? null,
  });

  const acceptanceHandoff = productAcceptancePlan ? handoffs.get(productAcceptancePlan.taskId) : null;
  const acceptanceResults = new Map((acceptanceHandoff?.criterionResults ?? []).map((item) => [item.criterionId, item]));
  const approvedCriteria = productAcceptancePlan?.acceptanceCriteria ?? [];
  const integrationDecision = {
    schemaVersion: 2,
    runId: plan.runId,
    status: status === "closed" ? "integrated" : status,
    createdAt: completedAt,
    planPhase: plan.phase,
    productAcceptanceTaskId: productAcceptancePlan?.taskId ?? null,
    acceptedArtifacts: (await store.listArtifacts(plan.runId)).filter((artifact) => artifact.accepted).map((artifact) => artifact.artifact_id),
    rejectedArtifacts: (await store.listArtifacts(plan.runId)).filter((artifact) => !artifact.accepted).map((artifact) => artifact.artifact_id),
    conflicts: (await store.listConflicts(plan.runId)).map((conflict) => ({ path: conflict.path, type: conflict.conflict_type, taskId: conflict.task_id })),
    sharedPaths: plan.sharedPathOwner,
    validation: plan.tasks.filter((task) => task.role === "verification").map((task) => ({
      taskId: task.taskId,
      stage: task.stage ?? "verification",
      status: tasks.find((row) => row.task_id === task.taskId)?.status ?? "missing",
    })),
    criteria: approvedCriteria.map((criterion) => {
      const result = acceptanceResults.get(criterion.id);
      return {
        id: criterion.id, source: criterion.source, statement: criterion.statement, blocking: criterion.blocking !== false,
        result: result?.result ?? "missing", evidence: result?.evidence ?? "",
      };
    }),
    dockerValidation,
  };
  assertSchema(integrationDecision, schemas.integrationDecision, "integrationDecision");
  const decisionPath = join(runDirectory, "integration-decision.json");
  await writeJson(decisionPath, integrationDecision);
  const integrationDecisionSha256 = sha256(await readFile(decisionPath));
  const integrationDecisionArtifactId = await store.addArtifact({
    runId: plan.runId,
    kind: "integration-decision",
    version: "v2",
    path: decisionPath,
    sha256: integrationDecisionSha256,
    accepted: status === "closed",
  });
  const terminalEvidence = {
    status,
    completedAt,
    planPhase: plan.phase,
    productAcceptanceTaskId: productAcceptancePlan?.taskId ?? null,
    failed: failed.length,
    blocked: blocked.length,
    cancelled: cancelled.length,
    policyFingerprint: policyEngine?.fingerprint ?? null,
    finalPlanFingerprint: stableFingerprint(plan),
    compiledPlanFingerprint: plan.phase === "compiled" ? stableFingerprint(plan) : null,
    integrationDecisionArtifactId,
    integrationDecisionSha256,
  };
  // Persist a terminal replay snapshot before the wake becomes externally deliverable.
  await snapshotTerminalReplayCapsule({ repositoryRoot, plan, schemas, store, terminal: terminalEvidence });
  const continuationWake = await store.materializeContinuationWake?.(plan.runId, { status });
  // Refresh once after wake materialization so the immutable qualification capsule
  // can prove the exactly-once terminal effect without making replay authority a
  // prerequisite of continuation delivery. Duplicate finalization merges terminal
  // fields and reproduces the same canonical evidence.
  await snapshotTerminalReplayCapsule({
    repositoryRoot,
    plan,
    schemas,
    store,
    terminal: {
      ...terminalEvidence,
      continuationEvidenceCaptured: true,
      continuationDeliveryId: continuationWake?.delivery?.delivery_id ?? continuationWake?.delivery?.deliveryId ?? null,
      continuationEffectKey: continuationWake?.delivery?.effect_key ?? continuationWake?.delivery?.effectKey ?? null,
      continuationGeneration: continuationWake?.delivery?.generation ?? null,
    },
  });
  return { status, plan, integrationDecision, tasks: await store.listTasks(plan.runId), duplicatePrevented: false };
}

export async function executePlan({ repositoryRoot, registry, schemas, plan, store, options }) {
  if (!options?.policyEngine) {
    const error = new Error("runtime_policy_engine_required:execute-plan");
    error.code = "runtime_policy_engine_required";
    throw error;
  }
  if (plan?.phase === "bootstrap" && plan?.workflow?.bootstrapTopologyState === "provisional") {
    const error = new Error("legacy_execute_plan_requires_refined_bootstrap");
    error.code = "legacy_execute_plan_requires_refined_bootstrap";
    throw error;
  }
  const runDirectory = join(repositoryRoot, ".runtime", "agents", "runs", plan.runId);
  await mkdir(runDirectory, { recursive: true });
  if (!(await store.getRun(plan.runId))) await store.createRun(plan, options);
  await store.updateRun(plan.runId, { status: "running", started_at: nowIso(), executor: options.executorCommand, workspace_mode: options.workspaceMode, max_parallel: options.maxParallel });
  await store.event(plan.runId, null, "run.running", { workspaceMode: options.workspaceMode, maxParallel: options.maxParallel, integrate: options.integrate, reasoning: plan.reasoning ?? null });

  const taskPlans = new Map(plan.tasks.map((task) => [task.taskId, task]));
  const running = new Map();
  let peakParallel = 0;
  while (true) {
    // Cascade cancellation: loop until no more tasks can be cancelled.
    // When task A is cancelled, task B (which depends on A) must also be
    // cancelled in the same scheduler tick to avoid a false stall detection.
    let cascadeChanged = true;
    while (cascadeChanged) {
      cascadeChanged = false;
      const tasks = await store.listTasks(plan.runId);
      const states = await taskStateMap(store, plan.runId);
      for (const task of tasks) {
        if (task.status === "routed" && dependenciesFailed(task, states)) {
          await store.updateTask(task.task_id, { status: "cancelled", error_code: "dependency_failed", error_message: "Upstream task did not integrate" });
          await store.event(plan.runId, task.task_id, "task.cancelled", { reason: "dependency_failed" });
          cascadeChanged = true;
        }
      }
    }
    if (plan.phase === "bootstrap") {
      const currentRows = await store.listTasks(plan.runId);
      const technicalLeadRow = currentRows.find((task) => task.task_id === plan.workflow.technicalLeadTaskId);
      if (["integrated", "verified"].includes(technicalLeadRow?.status)) {
        const handoffArtifact = (await store.listArtifacts(plan.runId))
          .filter((artifact) => artifact.task_id === plan.workflow.technicalLeadTaskId && artifact.kind === "handoff" && Number(artifact.accepted) === 1)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
        if (!handoffArtifact) throw new Error("technical_lead_handoff_artifact_missing");
        const technicalLeadHandoff = await readJson(handoffArtifact.path);
        const poArtifact = (await store.listArtifacts(plan.runId))
          .filter((artifact) => artifact.task_id === plan.workflow.productOwnerTaskId && artifact.kind === "handoff" && Number(artifact.accepted) === 1)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
        if (!poArtifact) throw new Error("product_owner_handoff_artifact_missing");
        const poHandoff = await readJson(poArtifact.path);
        const validationIssues = collectImplementationPlanValidationIssues(technicalLeadHandoff?.implementationPlan, registry);
        const compileDecision = options.policyEngine.evaluateCompile({ phase: plan.phase, technicalLeadAccepted: true, validationIssues });
        await recordPolicyDecision(store, {
          runId: plan.runId,
          taskId: plan.workflow.technicalLeadTaskId,
          operation: "compile",
          decision: compileDecision,
        });
        assertPolicyAllowed(compileDecision, "runtime_policy_compile_denied");
        const compileStartedAt = Date.now();
        const compiledPlan = compileImplementationDag({
          registry, plan, technicalLeadHandoff, schemas,
          requiredAcceptanceCriteria: poHandoff.acceptanceCriteria ?? [],
        });
        const compileDurationMs = Date.now() - compileStartedAt;
        const materializationStartedAt = Date.now();
        const existingIds = new Set(currentRows.map((task) => task.task_id));
        const newTasks = compiledPlan.tasks.filter((task) => !existingIds.has(task.taskId));
        await store.addTasks(plan.runId, newTasks, { maxAttempts: options.maxAttempts, reasoningSource: compiledPlan.reasoning?.source ?? null });
        await store.replacePlan(plan.runId, compiledPlan);
        const refinedDagPath = await saveCompiledDag(repositoryRoot, compiledPlan);
        for (const task of newTasks) taskPlans.set(task.taskId, task);
        Object.assign(plan, compiledPlan);
        await store.event(plan.runId, null, "dag.compiled", {
          implementationPlanRevision: compiledPlan.workflow.implementationPlanRevision,
          taskCount: compiledPlan.tasks.length,
          newTaskIds: newTasks.map((task) => task.taskId),
          refinedDagPath,
          compileDurationMs,
          materializationDurationMs: Date.now() - materializationStartedAt,
        });
      }
    }

    const refreshed = await store.listTasks(plan.runId);
    const terminal = refreshed.every((task) => ["integrated", "verified", "failed", "blocked", "cancelled"].includes(task.status));
    if (terminal && running.size === 0) break;

    const currentStates = await taskStateMap(store, plan.runId);
    const ready = refreshed.filter((task) => task.status === "routed" && dependenciesSatisfied(task, currentStates));
    while (ready.length > 0 && running.size < options.maxParallel) {
      const row = ready.shift();
      const taskPlan = taskPlans.get(row.task_id);
      const persistedRun = await store.getRun(plan.runId);
      const dispatchDecision = options.policyEngine.evaluateDispatch({
        runStatus: persistedRun?.status ?? "running",
        taskStatus: row.status,
        dependenciesSatisfied: true,
        retryWindowOpen: true,
        topologyReady: bootstrapTopologyReadyForTask(plan, taskPlan),
      });
      await recordPolicyDecision(store, {
        runId: plan.runId,
        taskId: taskPlan.taskId,
        operation: "dispatch",
        decision: dispatchDecision,
      });
      assertPolicyAllowed(dispatchDecision, "runtime_policy_dispatch_denied");
      const promise = executeTask({ repositoryRoot, runDirectory, plan, taskPlan, registry, schemas, store, options })
        .finally(() => running.delete(row.task_id));
      running.set(row.task_id, promise);
      peakParallel = Math.max(peakParallel, running.size);
      await store.updateRun(plan.runId, { peak_parallel: peakParallel });
    }
    if (running.size === 0) {
      const allTasks = await store.listTasks(plan.runId);
      const stalled = allTasks.filter((task) => !["integrated", "verified", "failed", "blocked", "cancelled"].includes(task.status));
      if (stalled.length > 0) {
        await store.updateRun(plan.runId, { status: "failed", error_code: "scheduler_stalled", error_message: stalled.map((task) => task.task_id).join(",") });
        throw new Error(`agent_scheduler_stalled:${stalled.map((task) => task.task_id).join(",")}`);
      }
      break;
    }
    await Promise.race(running.values());
  }

  return await finalizeExecution({ repositoryRoot, plan, schemas, store, policyEngine: options.policyEngine ?? null, peakParallel });
}
