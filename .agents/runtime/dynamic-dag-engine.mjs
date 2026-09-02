import { reconcileRun } from "./event-driven-reconciler.mjs";
import { invokeReasoning } from "./llm-reasoner.mjs";
import { createExecutionPlan } from "./planner.mjs";
import { provisionalizeBootstrapPlan } from "./bootstrap-topology-refiner.mjs";
import { buildSummary } from "./summary.mjs";
import { assertPolicyAllowed, loadRuntimePolicyDocument, recordPolicyDecision, RuntimePolicyEngine } from "./policy-engine.mjs";
import { buildReplayCapsule, recordReplayCapsuleArtifact, saveReplayCapsule } from "./run-replay.mjs";

const TERMINAL = new Set(["closed", "failed", "blocked", "cancelled"]);
const TERMINAL_TASK = new Set(["integrated", "verified", "failed", "blocked", "cancelled"]);

async function cancelRun(store, runId, source = "dynamic-dag") {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run_not_found:${runId}`);
  for (const task of await store.listTasks(runId)) {
    if (!TERMINAL_TASK.has(task.status)) {
      await store.updateTask(task.task_id, {
        status: "cancelled",
        completed_at: new Date().toISOString(),
        error_code: "manual_cancel",
        error_message: "Cancelled by operator",
      });
      if (task.workspace_path) await store.requestWorkspaceCleanup(task.task_id, { reason: "run_cancelled" }).catch(() => {});
    }
  }
  await store.updateRun(runId, { status: "cancelled", completed_at: new Date().toISOString() });
  await store.event(runId, null, "run.cancelled", { source });
  await store.materializeContinuationWake?.(runId, { status: "cancelled" });
  return { runId, status: "cancelled" };
}

export class DynamicDagAgentRuntimeEngine {
  constructor({ llmReasoner = null, policyEngine = null } = {}) {
    this.mode = "dynamic-dag-v2";
    this.llmReasoner = llmReasoner;
    this.policyEngine = policyEngine;
  }

  async resolvePolicyEngine(repositoryRoot) {
    if (this.policyEngine) return this.policyEngine;
    this.policyEngine = new RuntimePolicyEngine({ document: await loadRuntimePolicyDocument(repositoryRoot) });
    return this.policyEngine;
  }

  async plan({ repositoryRoot, registry, request, schemas, explicitAgents = [], store, options = {} }) {
    const reasoningAssessment = await invokeReasoning({ repositoryRoot, registry, request, schemas, explicitAgents, llmReasoner: this.llmReasoner });
    const policyEngine = await this.resolvePolicyEngine(repositoryRoot);
    const candidatePlan = createExecutionPlan({ registry, request, schemas, explicitAgents, reasoningAssessment, policyEngine });
    const plan = provisionalizeBootstrapPlan(candidatePlan, schemas, policyEngine);
    const policyDecision = plan.policy?.planDecision;
    if (!policyDecision) throw new Error("runtime_policy_plan_decision_missing");
    assertPolicyAllowed(policyDecision, "runtime_policy_plan_denied");
    await store.createRun(plan, { ...options, engine: this.mode, graphVersion: "technical-lead-compiled-dag.v2" });
    await recordPolicyDecision(store, { runId: plan.runId, operation: "plan", decision: policyDecision });

    const capsule = buildReplayCapsule({
      plan,
      events: await store.listEvents(plan.runId),
      artifacts: [],
      checkpoints: [],
      registry,
      schemas,
      policyEngine,
      explicitAgents,
    });
    const replayPath = await saveReplayCapsule(repositoryRoot, capsule, schemas);
    await recordReplayCapsuleArtifact(store, {
      runId: plan.runId,
      path: replayPath,
      capsule,
      stage: "bootstrap",
    });
    await store.event(plan.runId, null, "replay.capsule.materialized", {
      path: replayPath,
      capsuleFingerprint: capsule.capsuleFingerprint,
      planFingerprint: capsule.planFingerprint,
    });
    return { plan, reasoningAssessment, replayPath };
  }

  async execute(input) {
    const policyEngine = input.options?.policyEngine ?? await this.resolvePolicyEngine(input.repositoryRoot);
    return await reconcileRun({ ...input, options: { ...(input.options ?? {}), policyEngine } });
  }

  async resume(input) {
    const existing = await input.store.getRun(input.plan.runId);
    if (!existing) throw new Error(`run_not_found:${input.plan.runId}`);
    const authoritativePlan = JSON.parse(existing.plan_json);
    if (TERMINAL.has(existing.status)) return { status: existing.status, terminal: true, plan: authoritativePlan };
    await input.store.requestReconcile(authoritativePlan.runId, "engine_resume");
    return await this.execute({ ...input, plan: authoritativePlan });
  }

  async cancel({ store, runId }) { return await cancelRun(store, runId); }

  async inspect({ store, runId }) {
    const run = await store.getRun(runId);
    if (!run) throw new Error(`run_not_found:${runId}`);
    return {
      run,
      plan: JSON.parse(run.plan_json),
      tasks: await store.listTasks(runId),
      conflicts: await store.listConflicts(runId),
      artifacts: await store.listArtifacts(runId),
      checkpoints: await store.listCheckpoints(runId),
    };
  }

  async summarize({ store, runId = null }) { return await buildSummary(store, runId); }
}
