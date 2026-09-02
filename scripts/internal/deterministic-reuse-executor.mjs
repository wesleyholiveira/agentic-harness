import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadAndVerifyAgentInputManifest, contentIdentity, resolveManifestEntryPath } from "../../.agents/runtime/agent-input-manifest.mjs";
import { isExecutableValidationCommand } from "../../.agents/runtime/validation-command.mjs";
import { runShellValidation } from "../../.agents/runtime/validation-evidence.mjs";
import { readJson, writeJson } from "../../.agents/runtime/utils.mjs";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function clipped(value, max = 12_000) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

async function fingerprint(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`deterministic_reuse_owned_path_not_file:${path}`);
  const bytes = await readFile(path);
  return { bytes: bytes.byteLength, contentHash: contentIdentity(bytes) };
}

function samePath(left, right) {
  const normalize = (value) => resolve(value).replaceAll("\\", "/").toLowerCase();
  return normalize(left) === normalize(right);
}

async function main() {
  const manifestPath = arg("agent-input-manifest");
  const taskBriefPath = arg("task-brief");
  const workspace = resolve(arg("workspace") ?? process.cwd());
  const handoffPath = arg("handoff");
  const expectedAgentId = arg("agent-id");
  if (!manifestPath || !taskBriefPath || !handoffPath || !expectedAgentId) throw new Error("deterministic_reuse_executor_arguments_required");

  const manifest = await loadAndVerifyAgentInputManifest(manifestPath);
  const brief = await readJson(taskBriefPath);
  if (manifest.taskId !== brief.taskId || manifest.runId !== brief.runId || manifest.agentId !== brief.agentId || brief.agentId !== expectedAgentId) {
    throw new Error("deterministic_reuse_identity_mismatch");
  }
  if (brief.sdd?.stage !== "implementation" || brief.executionMode !== "deterministic-reuse") {
    throw new Error(`deterministic_reuse_execution_mode_invalid:${brief.sdd?.stage}:${brief.executionMode}`);
  }
  const taskContract = (manifest.entries ?? []).find((entry) => entry.category === "task_contract" && entry.deliveryMode === "attachment");
  if (!taskContract) throw new Error("deterministic_reuse_task_contract_manifest_entry_missing");
  const manifestBriefPath = resolveManifestEntryPath(manifestPath, taskContract);
  if (!manifestBriefPath || !samePath(manifestBriefPath, taskBriefPath)) throw new Error("deterministic_reuse_task_contract_path_mismatch");
  const briefBytes = await readFile(taskBriefPath);
  if (contentIdentity(briefBytes) !== taskContract.contentHash) throw new Error("deterministic_reuse_task_contract_hash_mismatch");

  const ownedPaths = [...new Set(brief.ownedPaths ?? [])];
  if (ownedPaths.length === 0) throw new Error("deterministic_reuse_owned_paths_required");
  if (ownedPaths.some((path) => /[*!?\[\]{}]/.test(path))) throw new Error("deterministic_reuse_exact_owned_paths_required");
  const absoluteOwned = new Map(ownedPaths.map((path) => [path, resolve(workspace, path)]));
  const before = new Map();
  for (const [path, absolute] of absoluteOwned) before.set(path, await fingerprint(absolute));

  const commands = [...new Set(brief.validation ?? [])];
  if (commands.length === 0 || commands.some((command) => !isExecutableValidationCommand(command))) {
    throw new Error("deterministic_reuse_executable_validation_required");
  }
  for (const criterion of brief.acceptanceCriteria ?? []) {
    if (criterion.blocking === false) continue;
    const verification = String(criterion.verification ?? "").trim();
    if (!isExecutableValidationCommand(verification) || !commands.includes(verification)) {
      throw new Error(`deterministic_reuse_criterion_verification_not_authorized:${criterion.id}`);
    }
  }

  const validation = [];
  for (const command of commands) {
    const result = await runShellValidation(command, { workspace, timeoutMs: Number(process.env.AGENT_HARNESS_AGENT_VALIDATION_TIMEOUT_MS ?? 600_000) });
    const passed = !result.timedOut && result.exitCode === 0;
    validation.push({
      command,
      phase: "final",
      blocking: true,
      result: passed ? "passed" : "failed",
      evidence: [
        "runtime_deterministic_reuse_validation",
        `exitCode=${result.exitCode ?? "null"}`,
        `timedOut=${result.timedOut === true}`,
        result.stdout ? `stdout=${clipped(result.stdout)}` : "",
        result.stderr ? `stderr=${clipped(result.stderr)}` : "",
      ].filter(Boolean).join("; "),
      authority: "runtime",
      exitCode: result.exitCode ?? null,
      timedOut: result.timedOut === true,
      executedAt: new Date().toISOString(),
    });
  }
  const validationsPassed = validation.every((entry) => entry.result === "passed");
  const after = new Map();
  for (const [path, absolute] of absoluteOwned) after.set(path, await fingerprint(absolute));
  const mutated = ownedPaths.filter((path) => before.get(path)?.contentHash !== after.get(path)?.contentHash || before.get(path)?.bytes !== after.get(path)?.bytes);
  const byteIdentical = mutated.length === 0;
  const complete = validationsPassed && byteIdentical;
  const receiptByCommand = new Map(validation.map((entry) => [entry.command, entry]));
  const criterionResults = (brief.acceptanceCriteria ?? []).map((criterion) => {
    const receipt = receiptByCommand.get(String(criterion.verification ?? "").trim());
    const passed = complete && receipt?.result === "passed";
    return {
      criterionId: criterion.id,
      result: passed ? "passed" : "failed",
      evidence: passed
        ? `deterministic_reuse_byte_identical; validation=${receipt.command}; contentHash=${ownedPaths.map((path) => `${path}:${after.get(path).contentHash}`).join(",")}`
        : `deterministic_reuse_not_proven; validation=${receipt?.result ?? "missing"}; mutated=${mutated.join(",") || "none"}`,
    };
  });
  const handoff = {
    schemaVersion: 2,
    runId: brief.runId,
    taskId: brief.taskId,
    agentId: brief.agentId,
    status: complete ? "complete" : "failed",
    retryable: false,
    artifactVersion: "1",
    changedPaths: [],
    reusedPaths: byteIdentical ? ownedPaths : [],
    contractChanges: [],
    assumptions: [],
    criterionResults,
    validation,
    residualRisks: complete ? [] : [
      ...(validationsPassed ? [] : ["required_validation_failed"]),
      ...(byteIdentical ? [] : [`reuse_candidate_mutated:${mutated.join(",")}`]),
    ],
    followUps: [],
    findings: [{
      type: "runtime_deterministic_reuse",
      status: complete ? "succeeded" : "failed",
      reason: complete ? "byte_identity_and_required_validation_proven_without_llm" : "deterministic_reuse_proof_failed",
      manifestFingerprint: manifest.manifestFingerprint,
      ownedPaths: ownedPaths.map((path) => ({ path, before: before.get(path), after: after.get(path) })),
      validationCommands: commands,
      fullAgentInvocation: false,
    }],
  };
  await writeJson(handoffPath, handoff);
  process.stdout.write(`${JSON.stringify({ event: "runtime.deterministic_reuse.completed", runId: brief.runId, taskId: brief.taskId, success: complete, manifestFingerprint: manifest.manifestFingerprint })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
