import { join } from "node:path";
import { assertSchema } from "./schema-validator.mjs";
import { anyPatternMatches, nowIso, writeJson } from "./utils.mjs";
import {
  implementationProofCriteria,
  qaProofCriteria,
  databaseReadinessProofCriteria,
  infrastructureReadinessProofCriteria,
  aiReadinessProofCriteria,
} from "./acceptance-criteria.mjs";
import {
  implementationValidationDirectiveFromRequest,
  invalidValidationCommands,
  isExecutableValidationCommand,
  validationScopeCompatibilityIssue,
} from "./validation-command.mjs";
import { modelRequirementsForTask } from "./model-capabilities.mjs";

const IMPLEMENTATION_EXECUTION_ROLES = new Set(["implementation", "platform"]);

function unique(values) { return [...new Set(values)]; }
function slug(value) { return String(value).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase(); }
function levelForComplexity(value) { return ({ low: "medium", medium: "high", high: "high", critical: "max" })[value] ?? "high"; }


function patternsMayOverlap(a, b) {
  if (a === b) return true;
  if (!a.includes("*") && !b.includes("*")) return false;
  const staticPrefix = (value) => value.slice(0, value.indexOf("*") >= 0 ? value.indexOf("*") : value.length);
  const ap = staticPrefix(a);
  const bp = staticPrefix(b);
  return ap.startsWith(bp) || bp.startsWith(ap) || anyPatternMatches([a], b) || anyPatternMatches([b], a);
}

function agentOwnedPatterns(agent) {
  return unique([...(agent.primaryPaths ?? []), ...(agent.sharedPaths ?? []), ...(agent.collaborativePaths ?? [])]);
}

function collectCycleIssues(workItems) {
  const byId = new Map();
  for (const item of workItems ?? []) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const issues = [];
  const seenCycles = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    const item = byId.get(id);
    if (!item) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of item.dependencies ?? []) {
      if (!byId.has(dependency)) continue;
      if (visiting.has(dependency)) {
        const index = stack.indexOf(dependency);
        const cycle = [...stack.slice(Math.max(0, index)), dependency];
        const signature = cycle.join("->");
        if (!seenCycles.has(signature)) {
          seenCycles.add(signature);
          issues.push(`implementation_plan_cycle:${signature}`);
        }
        continue;
      }
      visit(dependency);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of workItems ?? []) visit(item.id);
  return issues;
}

function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }

function criterionAuthorityShape(criterion) {
  return {
    id: String(criterion?.id ?? ""),
    source: String(criterion?.source ?? ""),
    statement: String(criterion?.statement ?? ""),
    blocking: criterion?.blocking !== false,
    verification: String(criterion?.verification ?? ""),
    proofStage: criterion?.proofStage ?? null,
  };
}

export function canonicalizeImplementationPlanAcceptanceCriteria(implementationPlan, requiredAcceptanceCriteria = []) {
  const plan = cloneJson(implementationPlan ?? {});
  if (!Array.isArray(requiredAcceptanceCriteria) || requiredAcceptanceCriteria.length === 0) {
    return { plan, normalized: false, omittedIds: [], extraIds: [], mutatedIds: [] };
  }

  const supplied = Array.isArray(plan.acceptanceCriteria) ? plan.acceptanceCriteria : [];
  const requiredById = new Map(requiredAcceptanceCriteria.map((criterion) => [String(criterion.id), criterion]));
  const suppliedById = new Map(supplied.map((criterion) => [String(criterion?.id ?? ""), criterion]));
  const omittedIds = [...requiredById.keys()].filter((id) => !suppliedById.has(id));
  const extraIds = [...suppliedById.keys()].filter((id) => id && !requiredById.has(id));
  const mutatedIds = [...requiredById.entries()]
    .filter(([id, required]) => suppliedById.has(id)
      && JSON.stringify(criterionAuthorityShape(suppliedById.get(id))) !== JSON.stringify(criterionAuthorityShape(required)))
    .map(([id]) => id);

  // Product Owner acceptance criteria are upstream authority. The Technical Lead
  // owns decomposition (workItems -> criterion IDs), not a second serialized copy
  // of the criterion catalog. Canonicalizing here prevents a structurally incomplete
  // duplicate catalog from burning a full retry while still rejecting any truly
  // unknown criterion referenced by a work item in validateCoverage().
  plan.acceptanceCriteria = cloneJson(requiredAcceptanceCriteria);
  return {
    plan,
    normalized: omittedIds.length > 0 || extraIds.length > 0 || mutatedIds.length > 0
      || supplied.length !== requiredAcceptanceCriteria.length,
    omittedIds,
    extraIds,
    mutatedIds,
  };
}

function registryAgent(registry, agentId) {
  if (registry?.byId?.get) return registry.byId.get(agentId) ?? null;
  return (registry?.agents ?? []).find((agent) => agent.id === agentId) ?? null;
}

function inspectImplementationPlan(plan, registry, { validationDirective = null } = {}) {
  const issues = [];
  const criteria = new Map();
  for (const criterion of plan.acceptanceCriteria ?? []) {
    if (criteria.has(criterion.id)) {
      issues.push(`implementation_plan_duplicate_acceptance_criterion:${criterion.id}`);
      continue;
    }
    criteria.set(criterion.id, criterion);
  }
  const implementationCriteria = implementationProofCriteria(plan.acceptanceCriteria ?? []);
  const implementationCriterionIds = new Set(implementationCriteria.map((item) => item.id));
  const coverage = new Map(implementationCriteria.map((item) => [item.id, 0]));
  const pathOwners = new Map();
  const claimedPaths = [];
  const workIds = new Set();
  const workItems = Array.isArray(plan.workItems) ? plan.workItems : [];
  const focusedValidationCommands = validationDirective?.mode === "focused"
    ? unique((validationDirective.commands ?? []).map((command) => String(command).trim()).filter(isExecutableValidationCommand))
    : [];
  const focusedValidationSet = new Set(focusedValidationCommands);

  for (const item of workItems) {
    if (workIds.has(item.id)) issues.push(`implementation_plan_duplicate_work_item:${item.id}`);
    else workIds.add(item.id);

    for (const invalid of invalidValidationCommands(item.validation ?? [])) {
      issues.push(`validation_command_not_executable:implementationPlan.workItems.${item.id}.validation[${invalid.index}]=${JSON.stringify(invalid.command)}`);
    }
    const declaredValidationScope = item.validationExecutionScope ?? "workspace";
    for (const [index, command] of (item.validation ?? []).entries()) {
      const scopeIssue = validationScopeCompatibilityIssue({ taskStage: "implementation", declaredScope: declaredValidationScope, command });
      if (scopeIssue) issues.push(`implementation_plan_${scopeIssue}:${item.id}:validation[${index}]`);
      if (focusedValidationSet.size > 0 && !focusedValidationSet.has(command)) {
        issues.push(`implementation_plan_focused_validation_extra:${item.id}:validation[${index}]=${JSON.stringify(command)}`);
      }
    }

    const agent = registryAgent(registry, item.ownerAgentId);
    if (!agent) {
      issues.push(`implementation_plan_agent_unknown:${item.ownerAgentId}`);
    } else if (!IMPLEMENTATION_EXECUTION_ROLES.has(agent.executionRole)) {
      issues.push(`implementation_plan_agent_not_implementer:${item.ownerAgentId}`);
    }

    const allowed = agent ? agentOwnedPatterns(agent) : [];
    for (const path of item.ownedPaths ?? []) {
      if (agent && !anyPatternMatches(allowed, path)) {
        issues.push(`implementation_plan_path_outside_agent_ownership:${item.id}:${item.ownerAgentId}:${path}`);
      }
      for (const prior of claimedPaths) {
        if (prior.ownerAgentId !== item.ownerAgentId && patternsMayOverlap(prior.path, path)) {
          issues.push(`implementation_plan_path_overlap:${prior.path}:${prior.ownerAgentId}:${path}:${item.ownerAgentId}`);
        }
      }
      claimedPaths.push({ path, ownerAgentId: item.ownerAgentId });

      const owner = pathOwners.get(path);
      if (owner && owner !== item.ownerAgentId) {
        issues.push(`implementation_plan_path_multi_owner:${path}:${owner}:${item.ownerAgentId}`);
      } else if (!owner) {
        pathOwners.set(path, item.ownerAgentId);
      }
    }

    const executionMode = item.executionMode ?? "agent";
    if (executionMode === "deterministic-reuse") {
      if (item.contractChange === true) issues.push(`implementation_plan_deterministic_reuse_contract_change:${item.id}`);
      if (item.migration === true) issues.push(`implementation_plan_deterministic_reuse_migration:${item.id}`);
      if ((item.validationExecutionScope ?? "workspace") !== "workspace") issues.push(`implementation_plan_deterministic_reuse_scope:${item.id}`);
      if ((item.validation ?? []).length === 0) issues.push(`implementation_plan_deterministic_reuse_validation_missing:${item.id}`);
      for (const path of item.ownedPaths ?? []) {
        if (/[*!?\[\]{}]/.test(path)) issues.push(`implementation_plan_deterministic_reuse_exact_path_required:${item.id}:${path}`);
      }
      for (const criterionId of item.acceptanceCriteria ?? []) {
        const criterion = criteria.get(criterionId);
        if (!criterion || !implementationCriterionIds.has(criterionId)) continue;
        const verification = String(criterion.verification ?? "").trim();
        if (!isExecutableValidationCommand(verification)) {
          issues.push(`implementation_plan_deterministic_reuse_non_executable_criterion:${item.id}:${criterionId}`);
        } else if (!(item.validation ?? []).includes(verification)) {
          issues.push(`implementation_plan_deterministic_reuse_criterion_validation_missing:${item.id}:${criterionId}:${JSON.stringify(verification)}`);
        }
      }
    }

    let assignedImplementationCriteria = 0;
    for (const criterionId of item.acceptanceCriteria ?? []) {
      if (!criteria.has(criterionId)) {
        issues.push(`implementation_plan_unknown_criterion:${item.id}:${criterionId}`);
        continue;
      }
      if (!implementationCriterionIds.has(criterionId)) continue;
      assignedImplementationCriteria += 1;
      coverage.set(criterionId, (coverage.get(criterionId) ?? 0) + 1);
      const criterionVerification = String(criteria.get(criterionId)?.verification ?? "").trim();
      if (isExecutableValidationCommand(criterionVerification) && !(item.validation ?? []).includes(criterionVerification)) {
        issues.push(`implementation_plan_criterion_verification_missing:${item.id}:${criterionId}:${JSON.stringify(criterionVerification)}`);
      }
    }
    if (assignedImplementationCriteria === 0) {
      issues.push(`implementation_plan_work_item_without_implementation_criterion:${item.id}`);
    }
  }

  for (const item of workItems) {
    for (const dependency of item.dependencies ?? []) {
      if (!workIds.has(dependency)) {
        issues.push(`implementation_plan_dependency_unknown:${item.id}:${dependency}`);
      }
    }
  }
  issues.push(...collectCycleIssues(workItems));

  for (const criterion of implementationCriteria) {
    if (criterion.blocking !== false && (coverage.get(criterion.id) ?? 0) === 0) {
      issues.push(`implementation_plan_uncovered_criterion:${criterion.id}`);
    }
  }

  if (focusedValidationCommands.length > 0) {
    const suppliedValidation = new Set(workItems.flatMap((item) => item.validation ?? []));
    for (const command of focusedValidationCommands) {
      if (!suppliedValidation.has(command)) {
        issues.push(`implementation_plan_focused_validation_missing:${JSON.stringify(command)}`);
      }
    }
  }

  return {
    issues: unique(issues),
    criteria,
    pathOwners,
    implementationCriterionIds,
  };
}

export function collectImplementationPlanValidationIssues(plan, registry, options = {}) {
  return inspectImplementationPlan(plan ?? { acceptanceCriteria: [], workItems: [] }, registry, options).issues;
}

function validateCoverage(plan, registry, options = {}) {
  const inspection = inspectImplementationPlan(plan, registry, options);
  if (inspection.issues.length > 0) {
    throw new Error(`implementation_plan_validation_failed:${inspection.issues.join(" | ")}`);
  }
  return {
    criteria: inspection.criteria,
    pathOwners: inspection.pathOwners,
    implementationCriterionIds: inspection.implementationCriterionIds,
  };
}

function implementationTask({ runId, technicalLeadTaskId, item, criteria, implementationCriterionIds, registry }) {
  const agent = registry.byId.get(item.ownerAgentId);
  if (!agent) throw new Error(`implementation_plan_agent_unknown:${item.ownerAgentId}`);
  if (!IMPLEMENTATION_EXECUTION_ROLES.has(agent.executionRole)) throw new Error(`implementation_plan_agent_not_implementer:${item.ownerAgentId}`);
  const taskId = `${runId}:implementation:${slug(item.id)}`;
  const assignedCriteria = item.acceptanceCriteria.filter((id) => implementationCriterionIds.has(id)).map((id) => criteria.get(id));
  if (assignedCriteria.length === 0) throw new Error(`implementation_plan_work_item_without_implementation_criterion:${item.id}`);
  return {
    taskId,
    agentId: item.ownerAgentId,
    objective: item.objective,
    dependencies: unique([technicalLeadTaskId, ...item.dependencies.map((id) => `${runId}:implementation:${slug(id)}`)]),
    ownedPaths: unique(item.ownedPaths),
    role: agent.executionRole ?? "implementation",
    sddRole: agent.role ?? "developer",
    stage: "implementation",
    workItemId: item.id,
    reasoningLevel: levelForComplexity(item.complexity),
    acceptanceCriteria: assignedCriteria,
    validation: item.validation,
    validationExecutionScope: item.validationExecutionScope ?? "workspace",
    complexity: item.complexity,
    estimatedFiles: item.estimatedFiles,
    contractChange: item.contractChange,
    migration: item.migration,
    executionMode: item.executionMode ?? "agent",
    executionRequirements: {
      capabilityId: `implementation.${agent.id}`,
      ...modelRequirementsForTask({
        stage: "implementation",
        role: agent.executionRole ?? "implementation",
        sddRole: agent.role ?? "developer",
        reasoningLevel: levelForComplexity(item.complexity),
        complexity: item.complexity,
        contractChange: item.contractChange,
        migration: item.migration,
        ownedPaths: item.ownedPaths,
      }),
      modelBinding: "runtime-route",
    },
  };
}

function runtimeReadinessCriterion(id, statement, verification) {
  return { id, source: "runtime", statement, blocking: true, verification };
}

function readinessValidation(_agent, _domainCriteria) {
  // Runtime-generated Operational Readiness is an evidence/review stage, not a
  // second repository-wide test runner. Registry validationCommands are a catalog
  // owned by the agent definition; they are not task authority and may require a
  // completely different execution environment (for example the ML container).
  //
  // Until the implementation-plan schema carries an explicit task-scoped
  // readinessValidation contract, the compiler must not infer executable commands
  // merely because Product Discovery assigned a database/infra/AI proof criterion.
  // QA already owns implementation validation. Readiness owns the scoped criteria
  // plus accepted QA/review evidence and therefore compiles with no implicit
  // commands.
  return [];
}

function verificationTask({ runId, agent, stage, suffix, objective, dependencies, criteria, role = "verification", validation = null }) {
  return {
    taskId: `${runId}:${stage}${suffix ? `:${suffix}` : ""}`,
    agentId: agent.id,
    objective,
    dependencies: unique(dependencies),
    ownedPaths: unique([...(agent.primaryPaths ?? []), ...(agent.collaborativePaths ?? []), ...(agent.sharedPaths ?? [])]),
    role,
    sddRole: agent.role,
    stage,
    workItemId: `${runId}:${stage}`,
    reasoningLevel: "high",
    acceptanceCriteria: criteria,
    validation: validation ?? agent.validationCommands ?? [],
    complexity: "high",
    estimatedFiles: 0,
    contractChange: false,
    migration: false,
    executionRequirements: {
      capabilityId: `verification.${stage}.${agent.id}`,
      ...modelRequirementsForTask({ stage, role, sddRole: agent.role, reasoningLevel: "high", ownedPaths: agent.primaryPaths ?? [] }),
      modelBinding: "runtime-route",
    },
  };
}

export function compileImplementationDag({ registry, plan, technicalLeadHandoff, schemas, requiredAcceptanceCriteria = [], compiledAt = null }) {
  if (!technicalLeadHandoff.implementationPlan) throw new Error("technical_lead_implementation_plan_missing");
  const canonical = canonicalizeImplementationPlanAcceptanceCriteria(technicalLeadHandoff.implementationPlan, requiredAcceptanceCriteria);
  const implementationPlan = canonical.plan;
  // Keep the in-memory handoff canonical so the persisted artifact and later DAG
  // compilation use the exact same Product Owner criterion authority.
  technicalLeadHandoff.implementationPlan = implementationPlan;
  assertSchema(implementationPlan, schemas.implementationPlan, "implementationPlan");
  const authoritativePlan = implementationPlan;
  const validationDirective = implementationValidationDirectiveFromRequest(plan.request);
  const { criteria, pathOwners, implementationCriterionIds } = validateCoverage(authoritativePlan, registry, { validationDirective });

  const implementationTasks = implementationPlan.workItems.map((item) => implementationTask({
    runId: plan.runId,
    technicalLeadTaskId: plan.workflow.technicalLeadTaskId,
    item,
    criteria,
    implementationCriterionIds,
    registry,
  }));
  const qa = registry.byId.get(plan.workflow.qualityAgentId);
  const productOwner = registry.byId.get("product-owner");
  const database = registry.byId.get("database-administration");
  const devOps = registry.byId.get("devops-engineering");
  const aiLlmOps = registry.byId.get("ai-llmops");
  if (!qa || !productOwner) throw new Error("compiled_dag_process_agent_missing");
  const databaseReviewTask = plan.tasks.find((task) => task.stage === "database-review") ?? null;
  const infrastructureReviewTask = plan.tasks.find((task) => task.stage === "infrastructure-review") ?? null;
  const aiOperationsReviewTask = plan.tasks.find((task) => task.stage === "ai-operations-review") ?? null;
  const allCriteria = authoritativePlan.acceptanceCriteria;
  const qaCriteria = qaProofCriteria(allCriteria);
  const databaseCriteria = databaseReadinessProofCriteria(allCriteria);
  const infrastructureCriteria = infrastructureReadinessProofCriteria(allCriteria);
  const aiCriteria = aiReadinessProofCriteria(allCriteria);
  const implementationValidation = unique(implementationPlan.workItems.flatMap((item) => item.validation));
  // QA is the independent proof stage for both implementation evidence and
  // Product Owner criteria whose proofStage=quality-assurance. R16 intentionally
  // projects only direct dependency handoffs into AgentInputManifest/v1, so every
  // authoritative bootstrap producer that QA may be asked to inspect must be a
  // direct dependency. These edges do not lengthen the critical path because all
  // bootstrap reviews and Product Discovery are already ancestors of Technical
  // Refinement; they only make their bounded projections/lazy refs manifest-visible
  // to QA instead of forcing an out-of-band MCP/repository discovery path.
  const bootstrapEvidenceTaskIds = plan.tasks
    .filter((task) => ["product-discovery", "architecture-review", "database-review", "infrastructure-review", "ai-operations-review"].includes(task.stage))
    .map((task) => task.taskId);
  const qaTask = verificationTask({
    runId: plan.runId, agent: qa, stage: "quality-assurance",
    objective: `Independently prove every blocking acceptance criterion for: ${plan.request}`,
    dependencies: [...bootstrapEvidenceTaskIds, plan.workflow.technicalLeadTaskId, ...implementationTasks.map((task) => task.taskId)],
    criteria: qaCriteria,
    validation: implementationValidation,
  });
  const readiness = [];
  if (plan.workflow.requiresDatabase) {
    if (!database) throw new Error("database_agent_missing");
    readiness.push(verificationTask({
      runId: plan.runId, agent: database, stage: "operational-readiness", suffix: "database",
      objective: `Prove scoped database readiness or explicitly prove no database impact for: ${plan.request}`,
      dependencies: unique([qaTask.taskId, ...(databaseReviewTask ? [databaseReviewTask.taskId] : [])]),
      criteria: [...databaseCriteria, runtimeReadinessCriterion(
        "PROC-DB-READY-1",
        "Database readiness is explicit for the integrated increment: assigned database criteria pass or scoped no-impact is proven.",
        "inspect accepted QA evidence and the upstream database review; approve only with database readiness or explicit no-impact evidence",
      )],
      validation: readinessValidation(database, databaseCriteria),
    }));
  }
  if (plan.workflow.requiresDevOps) {
    if (!devOps) throw new Error("devops_agent_missing");
    readiness.push(verificationTask({
      runId: plan.runId, agent: devOps, stage: "operational-readiness", suffix: "devops",
      objective: `Prove scoped infrastructure readiness or explicitly prove no infrastructure impact for: ${plan.request}`,
      dependencies: unique([qaTask.taskId, ...(infrastructureReviewTask ? [infrastructureReviewTask.taskId] : [])]),
      criteria: [...infrastructureCriteria, runtimeReadinessCriterion(
        "PROC-INFRA-READY-1",
        "Infrastructure readiness is explicit for the integrated increment: assigned infrastructure criteria pass or scoped no-impact is proven.",
        "inspect accepted QA evidence and the upstream infrastructure review; approve only with deploy/rollback readiness or explicit no-impact evidence",
      )],
      validation: readinessValidation(devOps, infrastructureCriteria),
    }));
  }
  if (plan.workflow.requiresAiLlmOps) {
    if (!aiLlmOps) throw new Error("ai_llmops_agent_missing");
    readiness.push(verificationTask({
      runId: plan.runId, agent: aiLlmOps, stage: "operational-readiness", suffix: "ai-llmops",
      objective: `Prove scoped AI/ML readiness or explicitly prove no AI/ML impact for: ${plan.request}`,
      dependencies: unique([qaTask.taskId, ...(aiOperationsReviewTask ? [aiOperationsReviewTask.taskId] : [])]),
      criteria: [...aiCriteria, runtimeReadinessCriterion(
        "PROC-AI-READY-1",
        "AI/ML readiness is explicit for the integrated increment: assigned AI criteria pass or scoped no-impact is proven.",
        "inspect accepted QA evidence and the upstream AI review; approve only with quality/rollback readiness or explicit no-impact evidence",
      )],
      validation: readinessValidation(aiLlmOps, aiCriteria),
    }));
  }
  const acceptance = verificationTask({
    runId: plan.runId, agent: productOwner, stage: "product-acceptance",
    objective: `Accept or reject the increment against every approved product criterion for: ${plan.request}`,
    // Product Acceptance signs the full product catalog. Keep QA as a direct
    // dependency even when readiness exists so its independent evidence is in the
    // authoritative Context Packet instead of being available only transitively.
    dependencies: unique([qaTask.taskId, ...readiness.map((task) => task.taskId)]),
    criteria: allCriteria,
    validation: [],
  });

  const sharedPathOwner = Object.fromEntries(pathOwners.entries());
  const compiled = {
    ...plan,
    phase: "compiled",
    sharedPathOwner: { ...plan.sharedPathOwner, ...sharedPathOwner },
    workflow: { ...plan.workflow, implementationPlanRevision: implementationPlan.revision, compiledAt: compiledAt ?? nowIso() },
    tasks: [...plan.tasks, ...implementationTasks, qaTask, ...readiness, acceptance],
  };
  assertSchema(compiled, schemas.executionPlan, "executionPlan");
  return compiled;
}

export async function saveCompiledDag(repositoryRoot, plan) {
  const path = join(repositoryRoot, ".runtime", "agents", "runs", plan.runId, "refined-dag.json");
  await writeJson(path, plan);
  return path;
}
