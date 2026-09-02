import { resolve } from "node:path";
import { readJson } from "../../.agents/runtime/utils.mjs";
import { loadAgentCatalog } from "../../.agents/runtime/agent-catalog.mjs";
import { loadSchemas } from "../../.agents/runtime/schema-validator.mjs";
import { loadRuntimePolicyDocument, RuntimePolicyEngine } from "../../.agents/runtime/policy-engine.mjs";
import {
  buildReplayCapsule,
  replayCapsulePath,
  verifyReplayCapsule,
} from "../../.agents/runtime/run-replay.mjs";
import { createExecutionPlan } from "../../.agents/runtime/planner.mjs";
import { provisionalizeBootstrapPlan } from "../../.agents/runtime/bootstrap-topology-refiner.mjs";
import { evaluateHarnessLiveEvidence } from "../../.agents/runtime/harness-live-evidence.mjs";

function parseArgs(argv) {
  const out = { repository: process.cwd(), selfTest: false, json: false, capsule: null, runId: null, harnessLiveEvidence: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repository") out.repository = argv[++index];
    else if (arg === "--capsule") out.capsule = argv[++index];
    else if (arg === "--run-id") out.runId = argv[++index];
    else if (arg === "--self-test") out.selfTest = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--harness-live-evidence") out.harnessLiveEvidence = true;
    else throw new Error(`unknown_argument:${arg}`);
  }
  const selectors = [out.selfTest, Boolean(out.capsule), Boolean(out.runId)].filter(Boolean).length;
  if (selectors !== 1) {
    throw new Error("usage: npm run runtime:agent-replay -- (--self-test | --capsule <path> | --run-id <runId>) [--repository <path>] [--harness-live-evidence] [--json]");
  }
  if (out.selfTest && out.harnessLiveEvidence) throw new Error("harness_live_evidence_requires_terminal_capsule");
  return out;
}

function selfTestAssessment() {
  return {
    mode: "adaptive",
    source: "explicit",
    initialLevel: "medium",
    confidence: 1,
    rationale: "deterministic replay CLI self-test",
    fallbackReason: null,
    recommendedAgents: [],
    requiresArchitecture: false,
    signals: {
      complexity: "low",
      ambiguity: 0,
      estimatedFiles: 1,
      estimatedDomains: 1,
      riskFactors: [],
    },
    routingEvidence: [],
    assessmentPath: null,
    bootstrapFactRequirements: [],
  };
}

const args = parseArgs(process.argv.slice(2));
const repositoryRoot = resolve(args.repository);
const [registry, schemas, policy] = await Promise.all([
  loadAgentCatalog(repositoryRoot),
  loadSchemas(repositoryRoot),
  loadRuntimePolicyDocument(repositoryRoot),
]);
const policyEngine = new RuntimePolicyEngine({ document: policy });

let capsule;
let source;
if (args.selfTest) {
  const candidate = createExecutionPlan({
    registry,
    schemas,
    request: "Replay CLI deterministic self-test",
    reasoningAssessment: selfTestAssessment(),
    identity: { runId: "run-replay-cli-self-test", createdAt: "2026-08-21T00:00:00.000Z" },
    policyEngine,
  });
  const plan = provisionalizeBootstrapPlan(candidate, schemas);
  capsule = buildReplayCapsule({ plan, registry, schemas, policyEngine, explicitAgents: [] });
  source = "self-test";
} else {
  const selectedPath = args.capsule
    ? resolve(args.capsule)
    : replayCapsulePath(repositoryRoot, args.runId);
  capsule = await readJson(selectedPath);
  source = selectedPath;
}

const verification = verifyReplayCapsule({ capsule, registry, schemas, policyEngine });
const liveEvidence = args.harnessLiveEvidence ? evaluateHarnessLiveEvidence(capsule) : null;
const result = {
  contractVersion: "agent-runtime-replay-cli/v1",
  source,
  runId: capsule?.runId ?? args.runId ?? null,
  policyFingerprint: policyEngine.fingerprint,
  replay: verification,
  liveEvidence,
  ok: verification.ok && (liveEvidence?.ok ?? true),
  violations: [
    ...(verification.violations ?? []),
    ...(liveEvidence?.violations ?? []),
  ],
  capsuleFingerprint: verification.capsuleFingerprint ?? null,
};
console.log(JSON.stringify(result, null, args.json ? 0 : 2));
if (!result.ok) process.exitCode = 1;
