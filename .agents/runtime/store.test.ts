import { describe, expect, it, vi } from "vitest";
import { OrchestrationStore } from "./store.mjs";

const requiredTables = [
  "agent_artifacts",
  "agent_conflicts",
  "agent_events",
  "agent_integrated_paths",
  "agent_runs",
  "agent_tasks",
  "agent_runtime_outbox",
  "agent_task_checkpoints",
  "agent_execution_results",
  "agent_runtime_workers",
  "agent_workspace_cleanup_jobs",
  "agent_continuations",
  "agent_continuation_deliveries",
  "agent_runtime_inbox",
];

const requiredRunColumns = [
  "reconcile_generation", "reconcile_requested_at", "reconcile_lease_owner", "reconcile_lease_expires_at",
  "runtime_driver", "context_budget_bytes", "task_timeout_ms", "auto_integrate",
];

const requiredTaskColumns = [
  "model_id", "model_variant", "reasoning_effort", "steps_limit", "steps_used",
  "step_limit_reached", "stop_reason", "opencode_session_id", "input_tokens", "output_tokens",
  "cached_input_tokens", "cost_usd", "dispatch_generation", "fencing_token", "lease_owner",
  "lease_expires_at", "queued_at", "execution_descriptor_path", "execution_result_path", "cleanup_state",
  "cleanup_attempts", "cleanup_error", "activity_version", "last_activity_at",
];

function readyPool() {
  const query = vi.fn(async (statement: string) => {
    if (statement.includes("information_schema.tables")) {
      return { rows: requiredTables.map((table_name) => ({ table_name })), rowCount: requiredTables.length };
    }
    if (statement.includes("table_name='agent_runs'")) {
      return { rows: requiredRunColumns.map((column_name) => ({ column_name })), rowCount: requiredRunColumns.length };
    }
    if (statement.includes("table_name='agent_tasks'")) {
      return { rows: requiredTaskColumns.map((column_name) => ({ column_name })), rowCount: requiredTaskColumns.length };
    }
    if (statement.includes("information_schema.table_constraints")) return { rows: [], rowCount: 0 };
    return { rows: [{ "?column?": 1 }], rowCount: 1 };
  });
  return { query, connect: vi.fn(), end: vi.fn() };
}

describe("PostgresOrchestrationStore schema readiness", () => {
  it.each([true, false])("uses only read-only readiness queries when readOnly=%s", async (readOnly) => {
    const pool = readyPool();
    const store = new OrchestrationStore("postgresql://app:secret@postgres/agent_harness", {
      readOnly,
      schema: "agent_runtime",
      pool,
    });

    await store.open();

    const statements = pool.query.mock.calls.map(([statement]) => String(statement));
    expect(statements.some((statement) => /information_schema\.tables/i.test(statement))).toBe(true);
    expect(statements.every((statement) => /^\s*SELECT\b/i.test(statement))).toBe(true);
    expect(statements.join("\n")).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE)\b/i);
  });

  it("fails closed with schema_not_ready when a required table is absent", async () => {
    const pool = readyPool();
    pool.query.mockImplementation(async (statement: string) => {
      if (statement.includes("information_schema.tables")) {
        return {
          rows: requiredTables.slice(1).map((table_name) => ({ table_name })),
          rowCount: requiredTables.length - 1,
        };
      }
      return { rows: [{ "?column?": 1 }], rowCount: 1 };
    });
    const store = new OrchestrationStore("postgresql://app:super-secret@postgres/agent_harness", {
      schema: "agent_runtime",
      pool,
    });

    await expect(store.open()).rejects.toMatchObject({
      code: "schema_not_ready",
      schema: "agent_runtime",
      missing: ["agent_artifacts"],
    });
    await expect(store.open()).rejects.not.toThrow("super-secret");
  });
});
