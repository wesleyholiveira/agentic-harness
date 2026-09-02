import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { repairEffectKey } from "./retry-efficiency.mjs";

export const RESUMABLE_REPAIR_CHECKPOINT_STATUSES = Object.freeze(["repair-started", "repair-completed", "repair-exhausted"]);

export function repairCheckpointPathForHandoff(handoffPath) {
  return `${handoffPath}.repair-checkpoint.json`;
}

export function repairResumeReceiptPathForHandoff(handoffPath) {
  return `${handoffPath}.repair-resume-receipt.json`;
}

export function isResumableRepairCheckpoint(checkpoint) {
  return Boolean(
    checkpoint
      && RESUMABLE_REPAIR_CHECKPOINT_STATUSES.includes(checkpoint.status)
      && checkpoint.handoff
      && Number.isInteger(Number(checkpoint.taskAttempt))
      && Number(checkpoint.taskAttempt) >= 1,
  );
}

export function repairResumeEffectKey({ runId, taskId, taskAttempt, dispatchGeneration, fencingToken } = {}) {
  const value = [runId, taskId, taskAttempt, dispatchGeneration, fencingToken, "repair.resume_checkpoint_loaded"]
    .map((item) => String(item ?? ""))
    .join("|");
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function readRepairCheckpoint(path, expected = {}) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.contractVersion !== "runtime-repair-checkpoint/v1") return null;
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (expectedValue != null && String(value?.[key] ?? "") !== String(expectedValue)) return null;
    }
    return value;
  } catch {
    return null;
  }
}

export async function writeRepairCheckpoint(path, input = {}) {
  const checkpoint = {
    contractVersion: "runtime-repair-checkpoint/v1",
    createdAt: new Date().toISOString(),
    ...input,
  };
  checkpoint.effectKey = checkpoint.effectKey ?? repairEffectKey({
    runId: checkpoint.runId,
    taskId: checkpoint.taskId,
    taskAttempt: checkpoint.taskAttempt,
    repairKind: checkpoint.repairKind,
    repairPass: checkpoint.repairPass,
    sourceRevision: checkpoint.sourceRevision,
    eventType: `checkpoint:${checkpoint.status ?? "unknown"}`,
  });
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await import("node:fs/promises").then(({ rename }) => rename(temporary, path));
  return checkpoint;
}

export async function readRepairResumeReceipt(path, expected = {}) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.contractVersion !== "runtime-repair-resume-receipt/v1") return null;
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (expectedValue != null && String(value?.[key] ?? "") !== String(expectedValue)) return null;
    }
    return value;
  } catch {
    return null;
  }
}

export async function writeRepairResumeReceipt(path, input = {}) {
  const receipt = {
    contractVersion: "runtime-repair-resume-receipt/v1",
    createdAt: new Date().toISOString(),
    ...input,
  };
  receipt.effectKey = receipt.effectKey ?? repairResumeEffectKey(receipt);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await import("node:fs/promises").then(({ rename }) => rename(temporary, path));
  return receipt;
}
