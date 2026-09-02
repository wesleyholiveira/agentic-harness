import { runtimeLog } from "./runtime-log.mjs";

function projectorId(projector, index) {
  return String(projector?.id ?? `projector-${index}`).trim();
}

export class RuntimePresentationPlane {
  constructor({ projectors = [], projectorTimeoutMs = 10_000 } = {}) {
    this.id = "runtime-presentation-plane";
    this.authoritative = false;
    this.projectors = [...projectors];
    this.projectorTimeoutMs = Math.max(50, Math.min(120_000, Number(projectorTimeoutMs) || 10_000));
    const seen = new Set();
    for (let index = 0; index < this.projectors.length; index += 1) {
      const id = projectorId(this.projectors[index], index);
      if (!id) throw new Error("presentation_projector_id_missing");
      if (seen.has(id)) throw new Error(`presentation_projector_duplicate:${id}`);
      seen.add(id);
      this.projectors[index].id ??= id;
    }
  }

  async projectRun(store, runId) {
    const outcomes = await Promise.all(this.projectors.map(async (projector) => {
      let timer = null;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`presentation_projector_timeout:${projector.id}`)), this.projectorTimeoutMs);
        });
        const result = await Promise.race([Promise.resolve().then(() => projector.projectRun(store, runId)), timeout]);
        return { ok: true, projectorId: projector.id, result };
      } catch (error) {
        const failure = {
          projectorId: projector.id,
          error: error instanceof Error ? error.message : String(error),
          authoritative: false,
        };
        runtimeLog("warn", "presentation.projector_failed", { runId, ...failure }, "agent-runtime.presentation");
        try { await store?.event?.(runId, null, "presentation.projector_failed", failure); } catch {}
        return { ok: false, failure };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));
    const failures = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.failure);
    const results = outcomes.filter((outcome) => outcome.ok).map(({ projectorId, result }) => ({ projectorId, result }));
    return {
      contractVersion: "runtime-presentation/v1",
      authoritative: false,
      projected: results.reduce((total, item) => total + Number(item.result?.projected ?? 0), 0),
      failures,
      results,
    };
  }
}

export function createRuntimePresentationPlane(projectors = [], options = {}) {
  return new RuntimePresentationPlane({ projectors, ...options });
}

function normalizeRunId(value) {
  const runId = String(value ?? "").trim();
  if (!runId) throw new Error("presentation_run_id_missing");
  return runId;
}

/**
 * Non-authoritative asynchronous presentation scheduler. `notify()` never awaits
 * projector I/O. Repeated notifications for the same run are coalesced; a
 * notification that arrives while a run is being projected marks the run dirty
 * and schedules one follow-up projection so the newest persisted state is not
 * lost.
 */
export class RuntimePresentationService {
  constructor({ project, maxParallel = 2, onError = null } = {}) {
    if (typeof project !== "function") throw new Error("presentation_project_function_required");
    this.project = project;
    this.maxParallel = Math.max(1, Math.min(8, Number(maxParallel) || 2));
    this.onError = typeof onError === "function" ? onError : null;
    this.pending = new Set();
    this.active = new Set();
    this.dirty = new Set();
    this.scheduled = false;
    this.stopped = false;
    this.lastErrors = new Map();
    this.waiters = new Set();
  }

  notify(runIdInput) {
    if (this.stopped) return false;
    const runId = normalizeRunId(runIdInput);
    if (this.active.has(runId)) this.dirty.add(runId);
    else this.pending.add(runId);
    this.schedule();
    return true;
  }

  schedule() {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  pump() {
    if (this.stopped) {
      this.resolveIdleIfReady();
      return;
    }
    while (this.active.size < this.maxParallel && this.pending.size > 0) {
      const runId = this.pending.values().next().value;
      this.pending.delete(runId);
      this.active.add(runId);
      Promise.resolve()
        .then(() => this.project(runId))
        .then(() => { this.lastErrors.delete(runId); })
        .catch(async (error) => {
          const normalized = error instanceof Error ? error.message : String(error);
          this.lastErrors.set(runId, { at: new Date().toISOString(), message: normalized });
          runtimeLog("warn", "presentation.service_projection_failed", { runId, error: normalized, authoritative: false }, "agent-runtime.presentation");
          try { await this.onError?.(runId, error); } catch {}
        })
        .finally(() => {
          this.active.delete(runId);
          if (this.dirty.delete(runId) && !this.stopped) this.pending.add(runId);
          this.pump();
          this.resolveIdleIfReady();
        });
    }
    this.resolveIdleIfReady();
  }

  isIdle() {
    return !this.scheduled && this.pending.size === 0 && this.active.size === 0;
  }

  idle() {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  resolveIdleIfReady() {
    if (!this.isIdle()) return;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  snapshot() {
    return {
      authoritative: false,
      stopped: this.stopped,
      pendingRuns: this.pending.size,
      activeRuns: this.active.size,
      dirtyRuns: this.dirty.size,
      maxParallel: this.maxParallel,
      projectionErrors: this.lastErrors.size,
    };
  }

  stop() {
    this.stopped = true;
    this.pending.clear();
    this.dirty.clear();
    this.resolveIdleIfReady();
  }
}

