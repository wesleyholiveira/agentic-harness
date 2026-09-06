import pg from "pg";
import { runtimeLog } from "./runtime-log.mjs";
import { OrchestrationStore } from "./store.mjs";
import { reconcileRun } from "./event-driven-reconciler.mjs";
import { RuntimePresentationService } from "./presentation-plane.mjs";

const { Client } = pg;
const WAKE_CHANNEL = "agent_harness_runtime_wakeup";

function safeRunId(payload) {
  const value = String(payload ?? "").trim();
  return value && value.length <= 200 ? value : null;
}

export class AgentRuntimeEventDriver {
  constructor({ repositoryRoot, databaseUrl, databaseSchema, registry, schemas, contextProvider, optionsFactory, presentationPlane = null, presentationService = null, progressProjector = null, repairIntervalMs = 30_000, reconcileParallel = 2 }) {
    this.repositoryRoot = repositoryRoot;
    this.databaseUrl = databaseUrl;
    this.databaseSchema = databaseSchema;
    this.registry = registry;
    this.schemas = schemas;
    this.contextProvider = contextProvider;
    this.optionsFactory = optionsFactory;
    this.presentationPlane = presentationPlane ?? (progressProjector ? { projectRun: (store, runId) => progressProjector.projectRun(store, runId) } : null);
    const selectedPresentationPlane = this.presentationPlane;
    this.presentationService = presentationService ?? (selectedPresentationPlane ? new RuntimePresentationService({
      maxParallel: 2,
      project: (runId) => this.withStore((store) => selectedPresentationPlane.projectRun(store, runId)),
      onError: async (runId, error) => {
        await this.withStore(async (store) => {
          const run = await store.getRun(runId);
          if (run) await store.event(runId, null, "presentation.service_projection_failed", {
            error: error instanceof Error ? error.message : String(error),
            authoritative: false,
          });
        }).catch(() => {});
      },
    }) : null);
    this.repairIntervalMs = Math.max(5_000, Number(repairIntervalMs) || 30_000);
    this.reconcileParallel = Math.max(1, Math.min(8, Number(reconcileParallel) || 2));
    this.pending = new Set();
    this.draining = false;
    this.drainScheduled = false;
    this.drainInFlight = null;
    this.started = false;
    this.listener = null;
    this.store = null;
    this.repairTimer = null;
    this.repairSweepInFlight = null;
    this.lastErrors = new Map();
  }

  async start() {
    if (this.started) return;
    this.started = true;
    runtimeLog("info", "semantic_driver.starting", { repairIntervalMs: this.repairIntervalMs, reconcileParallel: this.reconcileParallel }, "agent-runtime.driver");
    // Keep one process-scoped PostgreSQL pool for the semantic controller. The
    // previous implementation created/validated/closed a Pool for every wake,
    // reconcile and presentation callback, causing avoidable connection churn,
    // schema queries and CPU under event bursts.
    try {
      this.store = await new OrchestrationStore(this.databaseUrl, { schema: this.databaseSchema }).open();
    } catch (error) {
      this.started = false;
      runtimeLog("error", "semantic_driver.store_open_failed", { error: error instanceof Error ? error.message : String(error) }, "agent-runtime.driver");
      throw error;
    }
    this.listener = new Client({
      connectionString: this.databaseUrl,
      options: `-c search_path=${this.databaseSchema},public`,
    });
    this.listener.on("notification", (notification) => {
      if (notification.channel !== WAKE_CHANNEL) return;
      const runId = safeRunId(notification.payload);
      if (runId) this.wake(runId);
    });
    this.listener.on("error", (error) => {
      this.lastListenerError = error;
    });
    try {
      await this.listener.connect();
      await this.listener.query(`LISTEN ${WAKE_CHANNEL}`);
      runtimeLog("info", "semantic_driver.listener_ready", { channel: WAKE_CHANNEL }, "agent-runtime.driver");
    } catch (error) {
      this.lastListenerError = error;
      runtimeLog("error", "semantic_driver.listener_failed", { error: error instanceof Error ? error.message : String(error) }, "agent-runtime.driver");
      await this.listener.end().catch(() => {});
      this.listener = null;
    }
    await this.repairSweep();
    this.scheduleRepairSweep();
  }

  isStarted() { return this.started; }

  wake(runId) {
    const normalized = safeRunId(runId);
    if (!normalized || !this.started) return;
    this.pending.add(normalized);
    runtimeLog("debug", "semantic_driver.wake", { runId: normalized, pendingRuns: this.pending.size }, "agent-runtime.driver");
    this.scheduleDrain();
  }

  async withStore(callback) {
    if (!this.store) throw new Error("semantic_driver_store_not_open");
    return await callback(this.store);
  }

  scheduleDrain() {
    if (!this.started || this.draining || this.drainScheduled || this.pending.size === 0) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain().catch(() => {});
    });
  }

  scheduleRepairSweep() {
    if (!this.started) return;
    if (this.repairTimer) clearTimeout(this.repairTimer);
    this.repairTimer = setTimeout(async () => {
      this.repairTimer = null;
      try { await this.repairSweep(); }
      catch (error) {
        runtimeLog("error", "semantic_driver.repair_sweep_failed", { error: error instanceof Error ? error.message : String(error) }, "agent-runtime.driver");
      } finally {
        this.scheduleRepairSweep();
      }
    }, this.repairIntervalMs);
    this.repairTimer.unref?.();
  }

  async repairSweep() {
    if (!this.started) return;
    if (this.repairSweepInFlight) return await this.repairSweepInFlight;
    this.repairSweepInFlight = (async () => {
      const { runs, repairedContinuationDeliveryIds } = await this.withStore(async (store) => ({
        runs: await store.listRunnableRuns(200),
        repairedContinuationDeliveryIds: await store.repairTerminalContinuationWakes?.(200) ?? [],
      }));
      runtimeLog("debug", "semantic_driver.repair_sweep", {
        runnableRuns: runs.length,
        repairedContinuationDeliveries: repairedContinuationDeliveryIds.length,
      }, "agent-runtime.driver");
      for (const run of runs) this.pending.add(run.run_id);
      await this.drain();
    })();
    try { return await this.repairSweepInFlight; }
    finally { this.repairSweepInFlight = null; }
  }

  async reconcileOne(runId) {
    const startedAt = Date.now();
    runtimeLog("info", "semantic_driver.reconcile_started", { runId }, "agent-runtime.driver");
    try {
      await this.withStore(async (store) => {
        const run = await store.getRun(runId);
        if (!run) return;
        const plan = JSON.parse(run.plan_json);
        const taskRows = await store.listTasks(runId);
        const persistedMaxAttempts = taskRows.reduce((max, task) => Math.max(max, Number(task.max_attempts ?? 0)), 0);
        const options = this.optionsFactory({
          workspaceMode: run.workspace_mode,
          maxParallel: Number(run.max_parallel) || undefined,
          maxAttempts: persistedMaxAttempts || undefined,
          contextBudgetBytes: Number(run.context_budget_bytes) || undefined,
          taskTimeoutMs: Number(run.task_timeout_ms) || undefined,
          integrate: run.auto_integrate !== false,
        }, this.contextProvider);
        await reconcileRun({
          repositoryRoot: this.repositoryRoot,
          registry: this.registry,
          schemas: this.schemas,
          plan,
          store,
          options,
          ownerId: `context-engine:${process.pid}`,
        });
      });
      const previousError = this.lastErrors.get(runId) ?? null;
      this.lastErrors.delete(runId);
      if (previousError) {
        await this.withStore(async (store) => {
          const run = await store.getRun(runId);
          if (run) await store.event(runId, null, "runtime.reconcile_recovered", {
            previousMessage: previousError.message ?? null,
            failedAt: previousError.at ?? null,
          });
        }).catch(() => {});
      }
      runtimeLog("info", "semantic_driver.reconcile_completed", { runId, durationMs: Date.now() - startedAt, recovered: Boolean(previousError) }, "agent-runtime.driver");
      const presentationService = this.presentationService;
      if (presentationService) presentationService.notify(runId);
    } catch (error) {
      this.lastErrors.set(runId, { at: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) });
      runtimeLog("error", "semantic_driver.reconcile_failed", { runId, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }, "agent-runtime.driver");
      await this.withStore(async (store) => {
        const run = await store.getRun(runId);
        if (run) await store.event(runId, null, "runtime.reconcile_failed", {
          code: error && typeof error === "object" && "code" in error ? String(error.code ?? "") || null : null,
          message: error instanceof Error ? error.message : String(error),
        });
      }).catch(() => {});
      const presentationService = this.presentationService;
      if (presentationService) presentationService.notify(runId);
    }
  }

  async drain() {
    if (this.drainInFlight) return await this.drainInFlight;
    if (!this.started) return;
    this.drainInFlight = (async () => {
      this.draining = true;
      try {
        while (this.pending.size > 0 && this.started) {
          const batch = [...this.pending].slice(0, this.reconcileParallel);
          for (const runId of batch) this.pending.delete(runId);
          await Promise.all(batch.map((runId) => this.reconcileOne(runId)));
        }
      } finally {
        this.draining = false;
      }
    })();
    try {
      return await this.drainInFlight;
    } finally {
      this.drainInFlight = null;
      // A notification can arrive between the final empty check and clearing the
      // draining flag. Re-schedule a drain instead of waiting for the repair sweep.
      this.scheduleDrain();
    }
  }

  snapshot() {
    return {
      started: this.started,
      pendingRuns: this.pending.size,
      reconcileParallel: this.reconcileParallel,
      repairIntervalMs: this.repairIntervalMs,
      listenerConnected: Boolean(this.listener),
      listenerError: this.lastListenerError ? String(this.lastListenerError.message ?? this.lastListenerError) : null,
      reconcileErrors: this.lastErrors.size,
      presentation: this.presentationService?.snapshot?.() ?? null,
    };
  }

  async stop() {
    runtimeLog("info", "semantic_driver.stopping", { pendingRuns: this.pending.size }, "agent-runtime.driver");
    this.started = false;
    if (this.repairTimer) clearTimeout(this.repairTimer);
    this.repairTimer = null;
    await this.listener?.end().catch(() => {});
    this.listener = null;
    this.pending.clear();
    this.presentationService?.stop?.();
    // The process-scoped store cannot be closed while an already-started
    // reconcile/repair/presentation callback is still using it. Drain only
    // in-flight work; stopped=true prevents new work from being scheduled.
    await Promise.allSettled([
      ...(this.repairSweepInFlight ? [this.repairSweepInFlight] : []),
      ...(this.drainInFlight ? [this.drainInFlight] : []),
      ...(this.presentationService?.idle ? [this.presentationService.idle()] : []),
    ]);
    await this.store?.close().catch(() => {});
    this.store = null;
  }
}

export { WAKE_CHANNEL as AGENT_RUNTIME_WAKE_CHANNEL };
