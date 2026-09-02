import { z } from "zod";
import type { SemanticContextCache } from "@agent-harness/context-semantic-cache";
import type { AgentRuntimeControlAdapter } from "../agent-runtime-control.js";
import type { StatsCollector } from "../stats.js";
import type { Visibility } from "../visibility.js";
import { normalizeSemanticIncidentStats } from "./get-stats.js";
import { getContextEngineRequestContext } from "../request-context.js";

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

export function registerGetEfficiency(
  visibility: Visibility,
  stats: StatsCollector,
  semanticCache?: Pick<SemanticContextCache, "getStats">,
  control?: Pick<AgentRuntimeControlAdapter, "efficiency" | "assertObservationAllowed"> | null,
): void {
  visibility.registerVisibleTool(
    "context_efficiency",
    {
      description:
        `Measure Runtime V2/Context Engine token and budget efficiency without double counting. With runId, the authoritative primary scope is runScoped; processLifetime is diagnostic only and includes all Context Engine pack builds since process start, including prefetch. Separates observed delivery savings, exact-cache reuse, semantic estimates, provider cache reads, budget counterfactuals, and Runtime R17 phase/critical-path performance when available.`,
      inputSchema: {
        runId: z.string().min(1).max(160).optional(),
      },
    },
    async ({ runId }) => {
      const requestContext = getContextEngineRequestContext();
      const agentId = requestContext?.agentId ?? process.env.AGENT_HARNESS_AGENT_ID?.trim() ?? null;
      if (control && agentId === "main-orchestrator") {
        await control.assertObservationAllowed("context_efficiency", runId ?? null, {
          origin: requestContext?.invocationOrigin ?? "unknown",
          sessionId: requestContext?.invocationSessionId ?? null,
          callId: requestContext?.invocationCallId ?? null,
          userMessageId: requestContext?.invocationUserMessageId ?? null,
          provenanceSource: requestContext?.invocationProvenanceSource ?? "missing",
        });
      }
      const engine = stats.getStats();
      const semantic = semanticCache
        ? normalizeSemanticIncidentStats(semanticCache.getStats())
        : engine.semantic_cache
          ? normalizeSemanticIncidentStats(engine.semantic_cache)
          : null;
      const delivery = engine.delivery;
      const processAccounting = {
        observed: {
          contextDelivery: {
            rawTokens: delivery.full_tokens,
            deliveredTokens: delivery.delivered_tokens,
            tokensSaved: delivery.tokens_saved,
            savingsPercent: delivery.savings_percent,
          },
          exactCache: {
            packHits: delivery.pack_cache_hits,
            l1Hits: delivery.pack_cache_l1_hits,
            l2Hits: delivery.pack_cache_l2_hits,
            misses: delivery.pack_cache_misses,
            hitRate: delivery.pack_cache_hit_rate,
            directModelPromptTokensSaved: null,
          },
          budget: {
            requestedTokens: delivery.requested_budget_tokens,
            deliveredTokens: delivery.delivered_tokens,
            headroomTokens: delivery.budget_headroom_tokens,
            overflowTokens: delivery.budget_overflow_tokens,
            utilizationPercent: delivery.budget_utilization_percent,
          },
        },
        estimated: {
          semanticCache: semantic ? {
            tokensAvoidedEstimate: semantic.tokens_avoided_estimate,
            retrievalCallsAvoided: semantic.retrieval_calls_avoided,
            componentsReused: semantic.components_reused,
            acceptanceRate: semantic.candidate_acceptance_rate,
            reuseRate: semantic.semantic_reuse_rate,
          } : null,
        },
        accountingPolicy: {
          grandTotalTokensSaved: null,
          additive: false,
          reason: "Delivery compaction, semantic reuse, exact-cache work avoidance and budget headroom overlap. They are reported independently instead of summed into a misleading total.",
        },
      };

      let runtime = null;
      if (runId) {
        if (!control) throw new Error("context_efficiency_agent_runtime_unavailable");
        runtime = await control.efficiency(runId);
      }

      const result = {
        contractVersion: "context-efficiency/v2",
        generatedAt: new Date().toISOString(),
        scope: runId ? "run-primary-with-process-lifetime-diagnostics" : "context-engine-process-lifetime",
        runId: runId ?? null,
        primary: runId ? runtime : processAccounting,
        runScoped: runtime,
        processLifetime: {
          ...processAccounting,
          scope: "context-engine-process-lifetime",
          note: "These counters include every Context Engine pack build since this process started, including static prefetch and other runs. Do not describe them as run-scoped when runId is supplied.",
        },
        notes: {
          scopeAuthority: runId
            ? "When runId is supplied, summarize primary/runScoped for this run. processLifetime is secondary diagnostic context only."
            : "Without runId, primary is the Context Engine process lifetime.",
          exactCache: "Run-scoped execution exact-cache hits/misses live under runScoped.observed.exactCache. Prefetch cache lookups are reported separately there. Process-lifetime cache counts include prefetch and other requests.",
          semanticCache: "Semantic tokens avoided are an upstream estimate from accepted component reuse and are not added to observed delivery savings.",
          dagBudget: "Per-run DAG budget headroom is a counterfactual upper bound, not directly observed model-token savings.",
          performance: "When runScoped.performance is present, use it as the authoritative R17 wall-clock/critical-path view. A closed run can still be HARNESS PERFORMANCE HOLD when SLOs are exceeded.",
          processBudgetUtilizationPercent: percent(delivery.delivered_tokens, delivery.requested_budget_tokens),
        },
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        _meta: {
          efficiency_contract_version: result.contractVersion,
          run_id: runId ?? undefined,
        },
      };
    },
  );
}
