import http from "node:http";
import { resolveDatabaseAppUrl } from "./database-config.mjs";
import { OrchestrationStore } from "./store.mjs";

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;

function escapeLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function sample(name, value, labels = {}) {
  const entries = Object.entries(labels);
  const suffix = entries.length > 0 ? `{${entries.map(([key, item]) => `${key}="${escapeLabel(item)}"`).join(",")}}` : "";
  return `${name}${suffix} ${Number(value) || 0}`;
}

function family(lines, name, help, type, samples) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
  lines.push(...samples);
}

export async function renderMetrics(store) {
  const aggregate = await store.aggregate();
  const lines = [];
  family(lines, "clip_compass_agent_runs_total", "Runs multiagente por estado.", "counter",
    aggregate.runsByStatus.map((row) => sample("clip_compass_agent_runs_total", row.count, { status: row.status })));
  family(lines, "clip_compass_agent_tasks_total", "Tarefas multiagente por agente e estado.", "counter",
    aggregate.tasksByAgentStatus.map((row) => sample("clip_compass_agent_tasks_total", row.count, { agent: row.agent_id, status: row.status })));
  family(lines, "clip_compass_agent_task_duration_seconds_sum", "Soma da duração das tarefas por agente.", "counter",
    aggregate.durationByAgent.map((row) => sample("clip_compass_agent_task_duration_seconds_sum", Number(row.sum_ms) / 1000, { agent: row.agent_id })));
  family(lines, "clip_compass_agent_task_duration_seconds_count", "Quantidade de tarefas com duração observada por agente.", "counter",
    aggregate.durationByAgent.map((row) => sample("clip_compass_agent_task_duration_seconds_count", row.count, { agent: row.agent_id })));
  family(lines, "clip_compass_agent_context_bytes_total", "Bytes de contexto enviados por agente.", "counter",
    aggregate.contextByAgent.map((row) => sample("clip_compass_agent_context_bytes_total", row.bytes, { agent: row.agent_id })));
  family(lines, "clip_compass_agent_context_documents_total", "Documentos de contexto enviados por agente.", "counter",
    aggregate.contextByAgent.map((row) => sample("clip_compass_agent_context_documents_total", row.documents, { agent: row.agent_id })));
  family(lines, "clip_compass_agent_context_estimated_tokens_total", "Tokens de contexto estimados por agente.", "counter",
    aggregate.contextByAgent.map((row) => sample("clip_compass_agent_context_estimated_tokens_total", row.tokens, { agent: row.agent_id })));
  family(lines, "clip_compass_agent_retries_total", "Retentativas de tarefas por agente.", "counter",
    aggregate.retriesByAgent.map((row) => sample("clip_compass_agent_retries_total", row.retries, { agent: row.agent_id })));
  family(lines, "clip_compass_agent_reasoning_tasks_total", "Tarefas por nível de raciocínio efetivamente selecionado.", "counter",
    aggregate.reasoningLevels.map((row) => sample("clip_compass_agent_reasoning_tasks_total", row.count, { level: row.reasoning_level })));
  family(lines, "clip_compass_agent_reasoning_promotions_total", "Promoções adaptativas de raciocínio entre níveis.", "counter",
    aggregate.reasoningPromotions.map((row) => sample("clip_compass_agent_reasoning_promotions_total", row.count, { from: row.from, to: row.to })));
  family(lines, "clip_compass_agent_conflicts_total", "Conflitos de integração por tipo.", "counter",
    aggregate.conflicts.map((row) => sample("clip_compass_agent_conflicts_total", row.count, { type: row.conflict_type })));
  family(lines, "clip_compass_agent_findings_total", "Achados reportados por handoffs.", "counter",
    [sample("clip_compass_agent_findings_total", aggregate.findings?.count ?? 0)]);
  family(lines, "clip_compass_agent_parallelism_peak", "Maior paralelismo observado entre runs.", "gauge",
    [sample("clip_compass_agent_parallelism_peak", aggregate.peakParallel?.value ?? 0)]);
  const graphEventCount = (type) => aggregate.graphEvents.find((row) => row.event_type === type)?.count ?? 0;
  family(lines, "clip_compass_agent_dag_compiles_total", "DAGs de implementação compilados a partir de implementationPlan aprovado.", "counter",
    [sample("clip_compass_agent_dag_compiles_total", graphEventCount("dag.compiled"))]);
  family(lines, "clip_compass_agent_completion_rejections_total", "Conclusões rejeitadas por falta de evidência ou gate final.", "counter",
    [sample("clip_compass_agent_completion_rejections_total", graphEventCount("completion.rejected"))]);
  family(lines, "clip_compass_agent_completion_proven_total", "Conclusões provadas pelo completion gate.", "counter",
    [sample("clip_compass_agent_completion_proven_total", graphEventCount("completion.proven"))]);
  family(lines, "clip_compass_agent_model_cost_usd_total", "Custo observado pelo OpenCode por modelo.", "counter",
    aggregate.modelUsage.map((row) => sample("clip_compass_agent_model_cost_usd_total", row.cost_usd, { model: row.model_id })));
  family(lines, "clip_compass_agent_model_input_tokens_total", "Tokens de entrada observados por modelo.", "counter",
    aggregate.modelUsage.map((row) => sample("clip_compass_agent_model_input_tokens_total", row.input_tokens, { model: row.model_id })));
  family(lines, "clip_compass_agent_model_cached_input_tokens_total", "Tokens de cache-read observados por modelo.", "counter",
    aggregate.modelUsage.map((row) => sample("clip_compass_agent_model_cached_input_tokens_total", row.cached_input_tokens, { model: row.model_id })));
  family(lines, "clip_compass_agent_model_output_tokens_total", "Tokens de saída observados por modelo.", "counter",
    aggregate.modelUsage.map((row) => sample("clip_compass_agent_model_output_tokens_total", row.output_tokens, { model: row.model_id })));
  family(lines, "clip_compass_agent_model_accepted_tasks_total", "Tasks provadas e integradas/verificadas por modelo.", "counter",
    aggregate.modelUsage.map((row) => sample("clip_compass_agent_model_accepted_tasks_total", row.accepted_tasks, { model: row.model_id })));
  family(lines, "clip_compass_agent_model_step_limit_reached_total", "Tasks que alcançaram o limite de steps por modelo.", "counter",
    aggregate.modelUsage.map((row) => sample("clip_compass_agent_model_step_limit_reached_total", row.step_limit_reached, { model: row.model_id })));
  family(lines, "clip_compass_agent_metrics_exporter_up", "Saúde do exporter de métricas multiagente.", "gauge",
    [sample("clip_compass_agent_metrics_exporter_up", 1)]);
  return `${lines.join("\n")}\n`;
}

function writeHealthEvent(response, payload, eventId) {
  response.write(`id: ${eventId}\n`);
  response.write("event: health\n");
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function serveMetrics({ databaseUrl, databaseSchema = "public", host = "0.0.0.0", port = 9464 }) {
  const resolvedDatabaseUrl = databaseUrl ?? resolveDatabaseAppUrl();
  if (!resolvedDatabaseUrl) throw new Error("database_app_url_required");
  const store = await new OrchestrationStore(resolvedDatabaseUrl, {
    readOnly: POSTGRES_URL.test(resolvedDatabaseUrl),
    schema: databaseSchema,
  }).open();
  const healthSnapshot = () => ({ status: "ok", databaseBackend: "postgres", databaseSchema, observedAt: new Date().toISOString() });
  const server = http.createServer(async (request, response) => {
    if (request.url === "/health/snapshot") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(healthSnapshot()));
      return;
    }
    if (request.url === "/health") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      response.flushHeaders?.();
      response.write("retry: 2000\n\n");
      const emit = () => {
        const payload = healthSnapshot();
        writeHealthEvent(response, payload, payload.observedAt);
      };
      emit();
      const interval = setInterval(emit, 10_000);
      const close = () => clearInterval(interval);
      request.once("close", close);
      response.once("close", close);
      return;
    }
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      response.end(await renderMetrics(store));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  let storeClosed = false;
  const closeStore = async () => {
    if (storeClosed) return;
    storeClosed = true;
    await store.close();
  };
  const shutdown = () => server.close();
  server.once("close", () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    void closeStore();
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
