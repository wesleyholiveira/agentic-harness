import { z } from "zod";
import type { ContextPackBuilder, ContextReferenceStore } from "@agent-harness/context-pack";
import { isSemanticDependencyUnavailableErrorLike } from "@agent-harness/context-semantic-cache";
import type { StatsCollector } from "../stats.js";
import { buildTaskContext, cacheSummary } from "../task-context-service.js";
import type { Visibility } from "../visibility.js";

export function registerGetTaskContext(
  visibility: Visibility,
  builder: ContextPackBuilder,
  references?: ContextReferenceStore,
  stats?: StatsCollector,
): void {
  visibility.registerVisibleTool(
    "context_get_task_context",
    {
      description:
        "Build a Context Pack for a task. Compact mode (default) returns focus + content-addressed references; full mode returns all selected content inline. Semantic scope is optional and is used only after an exact cache miss.",
      inputSchema: {
        task: z.string().describe("Natural language task description"),
        budget: z.number().optional().describe("Token budget (default 18000)"),
        mode: z.enum(["compact", "full"]).optional().describe("Delivery mode (default compact)"),
        projectId: z.string().optional().describe("Semantic cache project scope; defaults to Context Engine configuration"),
        branch: z.string().optional().describe("Semantic cache branch/worktree lineage; defaults to repository branch"),
        role: z.string().optional().describe("Semantic cache logical SDD/agent role"),
        stage: z.string().optional().describe("Semantic cache DAG/SDD stage"),
        schemaVersion: z.string().optional().describe("Semantic candidate schema version; normally runtime-owned"),
      },
    },
    async (args) => {
      const semanticScope = Object.fromEntries(
        Object.entries({
          projectId: args.projectId,
          branch: args.branch,
          role: args.role,
          stage: args.stage,
          schemaVersion: args.schemaVersion,
        }).filter(([, value]) => typeof value === "string" && value.length > 0),
      );
      let result: Awaited<ReturnType<typeof buildTaskContext>>;
      try {
        result = await buildTaskContext(
          builder,
          references,
          stats,
          args.task,
          args.budget ?? 18_000,
          args.mode ?? "compact",
          Object.keys(semanticScope).length > 0 ? { semanticScope } : {},
        );
      } catch (error) {
        if (!isSemanticDependencyUnavailableErrorLike(error)) throw error;
        const payload = {
          error_code: "context_semantic_dependency_unavailable",
          dependency: error.dependency ?? "unknown",
          cause_code: error.causeCode ?? null,
          retryable: error.retryable !== false,
          message: typeof error.message === "string" ? error.message : String(error),
        };
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          _meta: {
            status: "semantic-dependency-unavailable",
            error_code: payload.error_code,
            dependency: payload.dependency,
            cause_code: payload.cause_code,
            retryable: payload.retryable,
          },
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.payload, null, 2) }],
        _meta: {
          status: result.cacheStatus,
          summary: cacheSummary(result),
          cache_hit: result.cacheHit,
          ...(result.cacheTier ? { cache_tier: result.cacheTier } : {}),
          component_cache: result.componentCache,
          ...(result.semanticCache ? { semantic_cache: result.semanticCache } : {}),
          sources: result.sources,
          warnings: result.warnings,
          delivery_mode: result.mode,
          budget: result.budget,
          raw_tokens: result.rawTokens,
          full_tokens: result.rawTokens,
          delivered_tokens: result.deliveredTokens,
          tokens_saved: result.tokensSaved,
          savings_percent: result.savingsPercent,
          static_artifact_count: result.staticArtifactCount,
        },
      };
    },
  );
}
