const OUTER_GATE_PATTERN = /\b(?:R-0|R-1|R-2P?|H-8|H-9R?)\b/gi;
const SOURCE_GATE_PATTERN = /(?<![A-Za-z0-9_-])SOURCE(?![A-Za-z0-9_-])/g;

const EXECUTION_INTENT_PATTERNS = [
  /\b(?:execute|executar|executa|rode|rodar|run|qualify|qualifique|qualificar)\b/i,
];

const RUNBOOK_EXECUTION_PATTERN = /\b(?:execute|executar|executa|rode|rodar|run)\b[^\n]{0,160}\brunbook\b|\brunbook\b[^\n]{0,160}\b(?:execute|executar|executa|rode|rodar|run)\b/i;
const PROMOTION_VERDICT_PATTERN = /\bPROMOTION\s+(?:PASS|FAIL|HOLD)\b/i;
const QUALIFICATION_CONTROLLER_PATH_PATTERN = /docs[\\/]+operations[\\/]+prompts[\\/]+agent-runtime-v2-[^\s`"']*(?:qualification|validation)[^\s`"']*-agent-prompt\.md/i;

function normalizedRequest(request) {
  return String(request ?? "").replace(/\r\n?/g, "\n").trim();
}

function distinctOuterGates(text) {
  const matches = text.match(OUTER_GATE_PATTERN) ?? [];
  const sourceMatches = text.match(SOURCE_GATE_PATTERN) ?? [];
  return [...new Set([...matches.map((value) => value.toUpperCase()), ...sourceMatches])];
}

function withoutNegatedExecutionIntent(text) {
  return text
    .replace(/\bsem\s+(?:executar|executa|rodar|rode|qualificar|qualifique)\b/gi, "")
    .replace(/\b(?:do\s+not|don't|without)\s+(?:execute|run|qualify|running)\b/gi, "");
}

function executionLinkedOuterGates(text) {
  const linked = new Set();
  const clauses = text.split(/[\n.!?;]+/g);

  for (const clause of clauses) {
    const gates = distinctOuterGates(clause);
    if (gates.length < 2) continue;
    const intentText = withoutNegatedExecutionIntent(clause);
    if (!EXECUTION_INTENT_PATTERNS.some((pattern) => pattern.test(intentText))) continue;
    for (const gate of gates) linked.add(gate);
  }

  return [...linked];
}

export function inspectQualificationMetaRunRequest(request) {
  const text = normalizedRequest(request);
  if (!text) return { blocked: false, reason: null, outerGates: [] };

  const outerGates = distinctOuterGates(text);
  const intentText = withoutNegatedExecutionIntent(text);
  const hasExecutionIntent = EXECUTION_INTENT_PATTERNS.some((pattern) => pattern.test(intentText));
  const runbookExecution = RUNBOOK_EXECUTION_PATTERN.test(intentText);
  const promotionVerdict = PROMOTION_VERDICT_PATTERN.test(text);
  const qualificationControllerPath = QUALIFICATION_CONTROLLER_PATH_PATTERN.test(text);
  const executionLinkedGates = executionLinkedOuterGates(text);

  // Qualification controller prompts/runbooks are host/operator authority and must
  // never be recursively executed as Runtime workloads. Keep this path detection
  // version-neutral so new qualification revisions cannot bypass the guard.
  if (qualificationControllerPath && hasExecutionIntent) {
    return {
      blocked: true,
      reason: "qualification_controller_artifact_execution_requested_inside_runtime",
      outerGates,
    };
  }

  if (runbookExecution && /\b(?:qualification|qualifica[cç][aã]o|Runtime\s+V2)\b/i.test(text)) {
    return {
      blocked: true,
      reason: "runbook_execution_requested_inside_runtime",
      outerGates,
    };
  }

  // R17.3: gate-name detection must distinguish the canonical uppercase SOURCE
  // gate from ordinary prose such as "tracked repository source". In addition,
  // execution intent is correlated with gates clause-locally instead of globally:
  // a workload may mention outer-controller R-0 evidence while separately asking
  // the Runtime to execute normal validation work without becoming a meta-run.
  if (executionLinkedGates.length >= 2 || (promotionVerdict && outerGates.length >= 2)) {
    return {
      blocked: true,
      reason: "outer_qualification_gates_requested_inside_runtime",
      outerGates,
    };
  }

  return { blocked: false, reason: null, outerGates };
}

export function assertQualificationMetaRunAdmission(request) {
  const inspection = inspectQualificationMetaRunRequest(request);
  if (!inspection.blocked) return inspection;
  const gates = inspection.outerGates.length > 0 ? `:${inspection.outerGates.join(",")}` : "";
  throw new Error(`agent_runtime_qualification_meta_run_forbidden:${inspection.reason}${gates}`);
}
