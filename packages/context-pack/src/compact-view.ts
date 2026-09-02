import { estimateTokens } from "./budget-optimizer";
import type { ContextPack, CompactContextPack, ContextReference } from "./types";
import type { ContextReferenceStore } from "./reference-store";

function briefDecision(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return {
    id: record.id,
    title: record.title,
    rationale: record.rationale,
    files: record.files,
    symbols: record.symbols,
  };
}

function briefSymbol(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return {
    qualified_name: record.qualified_name,
    label: record.label,
    file: record.file,
    lines: record.lines,
    in_degree: record.in_degree,
    out_degree: record.out_degree,
  };
}

function externalDocDescriptor(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return { library: record.library, query: record.query };
}

export async function toCompactContextPack(pack: ContextPack, store: ContextReferenceStore): Promise<CompactContextPack> {
  const references: ContextReference[] = [];
  const add = async (source: string, content: unknown): Promise<void> => {
    if (Array.isArray(content) && content.length === 0) return;
    if (typeof content === "string" && content.length === 0) return;
    references.push(await store.put(source, content));
  };

  await add("previous_decisions", pack.previous_decisions);
  await add("symbols", pack.symbols);
  await add("architecture", pack.architecture);
  for (const artifact of pack.static_artifacts) {
    references.push(
      await store.put(`static-artifact:${artifact.path}`, artifact, [
        { path: artifact.path, hash: artifact.content_hash },
      ]),
    );
  }
  await add("summaries", pack.summaries);
  if (pack.dependencies.callers.length || pack.dependencies.callees.length || pack.dependencies.tests.length) {
    await add("dependencies", pack.dependencies);
  }
  await add("external_docs", pack.external_docs);

  const packId = await store.putPack(pack);
  const fullTokens = estimateTokens(pack);
  const compact: CompactContextPack = {
    pack_id: packId,
    task_analysis: pack.task_analysis,
    focus: {
      decisions: pack.previous_decisions.slice(0, 3).map(briefDecision),
      symbols: pack.symbols.slice(0, 8).map(briefSymbol),
      static_artifacts: pack.static_artifacts.map((artifact) => ({
        ref: references.find((reference) => reference.source === `static-artifact:${artifact.path}`)?.ref ?? "",
        path: artifact.path,
        kind: artifact.kind,
        title: artifact.title,
        content_hash: artifact.content_hash,
        token_cost: artifact.token_cost,
        relevance_score: artifact.relevance_score,
      })),
      external_docs: pack.external_docs.slice(0, 5).map(externalDocDescriptor),
    },
    references,
    metadata: {
      ...pack.metadata,
      delivery_mode: "compact",
      full_tokens: fullTokens,
      delivered_tokens: 0,
      delivery_tokens_saved: 0,
      delivery_savings_percent: 0,
    },
  };
  if (pack.architecture) {
    compact.focus.architecture_preview = pack.architecture.replace(/\s+/g, " ").trim().slice(0, 240);
  }

  // Two passes make the self-referential token counters converge enough for deterministic reporting.
  for (let index = 0; index < 2; index++) {
    const delivered = estimateTokens(compact);
    const saved = Math.max(0, fullTokens - delivered);
    compact.metadata.delivered_tokens = delivered;
    compact.metadata.delivery_tokens_saved = saved;
    compact.metadata.delivery_savings_percent = fullTokens === 0 ? 0 : (saved / fullTokens) * 100;
  }
  return compact;
}
