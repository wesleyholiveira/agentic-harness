import { isAbsolute, resolve } from "node:path";
import { asInteger } from "../utils.mjs";

export function loadContextRetrievalConfig(repositoryRoot, environment = process.env) {
  const rawIndexPath = environment.AGENT_HARNESS_AGENT_CONTEXT_INDEX_PATH ?? ".runtime/agents/context-index";
  return {
    topK: asInteger(environment.AGENT_HARNESS_AGENT_CONTEXT_TOP_K, 20, { min: 1, max: 100 }),
    maxCandidateBytes: asInteger(environment.AGENT_HARNESS_AGENT_CONTEXT_MAX_CANDIDATE_BYTES, 400_000, { min: 10_000, max: 5_000_000 }),
    indexPath: isAbsolute(rawIndexPath) ? rawIndexPath : resolve(repositoryRoot, rawIndexPath),
    maxAgeSeconds: asInteger(environment.AGENT_HARNESS_AGENT_CONTEXT_INDEX_MAX_AGE_SECONDS, 300, { min: 0, max: 86_400 }),
  };
}
