import { normalizeModelHandoffContract } from "./handoff-contract.mjs";
import { validateAgainstSchema } from "./schema-validator.mjs";

const HANDOFF_STATUSES = new Set(["complete", "blocked", "failed", "cancelled"]);
const HANDOFF_DISTINCTIVE_FIELDS = new Set([
  "changedPaths", "reusedPaths", "usedContextPaths", "contractChanges", "assumptions",
  "criterionResults", "validation", "residualRisks", "followUps", "acceptanceCriteria",
  "implementationPlan", "bootstrapReviewAssessment", "sddReview", "dockerValidation", "findings",
]);

function stripAnsi(value) {
  return String(value ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

function balancedJsonValueStrings(value) {
  const source = String(value ?? "");
  const values = [];
  let cursor = 0;
  while (cursor < source.length) {
    const objectStart = source.indexOf("{", cursor);
    const arrayStart = source.indexOf("[", cursor);
    const starts = [objectStart, arrayStart].filter((index) => index >= 0);
    if (starts.length === 0) break;
    const start = Math.min(...starts);
    const balanced = balancedJsonValueAt(source, start);
    if (!balanced) break;
    values.push(balanced.text);
    cursor = balanced.end;
  }
  return values;
}

function balancedJsonValueAt(source, start) {
  const stack = [];
  let inString = false;
  let escape = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) return null;
      stack.pop();
      if (stack.length === 0) return { text: source.slice(start, index + 1), end: index + 1 };
    }
  }
  return null;
}

function prefixedSessionJsonDocument(value) {
  const source = String(value ?? "");
  let cursor = 0;
  while (cursor < source.length) {
    const objectStart = source.indexOf("{", cursor);
    const arrayStart = source.indexOf("[", cursor);
    const starts = [objectStart, arrayStart].filter((index) => index >= 0);
    if (starts.length === 0) return null;
    const start = Math.min(...starts);
    const balanced = balancedJsonValueAt(source, start);
    // Once a candidate root is unclosed, later braces belong to that truncated
    // value and must not be salvaged as an authoritative nested message.
    if (!balanced) return null;
    try {
      const parsed = JSON.parse(balanced.text);
      if (sessionMessages(parsed)) return parsed;
    } catch {}
    cursor = balanced.end;
  }
  return null;
}

function parseJsonDocuments(value) {
  const cleaned = stripAnsi(value);
  const documents = [];
  const seen = new Set();
  const add = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      const key = JSON.stringify(parsed);
      if (!seen.has(key)) { seen.add(key); documents.push(parsed); }
    } catch {}
  };
  if (!cleaned) return documents;
  add(cleaned);
  for (const line of cleaned.split(/\r?\n/)) {
    if (line.trim()) add(line);
  }
  // Compatibility with OpenCode export versions/wrappers that print a short
  // status prefix before the JSON payload. A parseable export remains the
  // authority; this merely recovers its JSON document.
  for (const candidate of balancedJsonValueStrings(cleaned)) add(candidate);
  return documents;
}

function sessionMessages(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Array.isArray(value.messages)) return value.messages;
  if (Array.isArray(value.data?.messages)) return value.data.messages;
  return null;
}

/**
 * Parse only a complete OpenCode session-export root.
 *
 * A truncated export can still contain complete nested message objects. Those
 * nested objects do not prove that the final assistant message was exported,
 * so they must never become the session-export authority on their own.
 */
export function sessionExportDocumentFromValue(value) {
  const cleaned = stripAnsi(value);
  if (!cleaned) return null;
  try {
    const direct = JSON.parse(cleaned);
    if (sessionMessages(direct)) return direct;
  } catch {}

  // A current OpenCode export may be preceded by a short status line. Parse only
  // the first complete JSON root after that prefix. Never search nested values:
  // a truncated root can contain complete stale messages but not the final one.
  return prefixedSessionJsonDocument(cleaned);
}

export function sessionExportIsUsable(value) {
  const document = sessionExportDocumentFromValue(value);
  return Boolean(document && finalAssistantResponseFromSessionDocument(document));
}

function visitJson(value, visitor) {
  if (!value || typeof value !== "object") return;
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, visitor);
    return;
  }
  for (const item of Object.values(value)) visitJson(item, visitor);
}

function roleOf(value) {
  const candidates = [
    value?.role,
    value?.info?.role,
    value?.message?.role,
    value?.message?.info?.role,
    value?.author?.role,
  ];
  return candidates.find((item) => typeof item === "string") ?? null;
}

function directTextParts(value) {
  const result = [];
  const add = (item) => {
    if (typeof item === "string" && item.trim()) result.push(item.trim());
  };
  add(value?.text);
  if (typeof value?.content === "string") add(value.content);
  const containers = [value?.parts, value?.content, value?.message?.parts, value?.message?.content];
  for (const container of containers) {
    if (!Array.isArray(container)) continue;
    for (const part of container) {
      if (!part || typeof part !== "object") continue;
      if (part.type && !["text", "output_text", "assistant_text"].includes(String(part.type))) continue;
      add(part.text);
      if (typeof part.content === "string") add(part.content);
    }
  }
  if (value?.part && typeof value.part === "object") {
    const part = value.part;
    if (!part.type || ["text", "output_text", "assistant_text"].includes(String(part.type))) {
      add(part.text);
      if (typeof part.content === "string") add(part.content);
    }
  }
  return [...new Set(result)];
}

function assistantTextsFromDocuments(documents) {
  const texts = [];
  for (const document of documents) {
    visitJson(document, (current) => {
      if (String(roleOf(current) ?? "").toLowerCase() !== "assistant") return;
      const parts = directTextParts(current);
      if (parts.length > 0) texts.push(parts.join("\n"));
    });
  }
  return texts.filter(Boolean);
}

function textEventsFromDocuments(documents) {
  const texts = [];
  for (const document of documents) {
    visitJson(document, (current) => {
      const type = String(current?.type ?? current?.part?.type ?? "").toLowerCase();
      if (!["text", "output_text", "assistant_text"].includes(type)) return;
      const parts = directTextParts(current);
      if (parts.length > 0) texts.push(parts.join("\n"));
    });
  }
  return texts.filter(Boolean);
}

function messageTimestamp(message) {
  const candidates = [
    message?.info?.time?.created, message?.time?.created, message?.createdAt,
    message?.created_at, message?.timestamp, message?.info?.createdAt,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

function finalAssistantResponseFromSessionDocument(document) {
  const messages = sessionMessages(document) ?? [];
  const assistant = [];
  for (const [index, message] of messages.entries()) {
    if (String(roleOf(message) ?? "").toLowerCase() !== "assistant") continue;
    const parts = directTextParts(message);
    if (parts.length === 0) continue;
    assistant.push({ text: parts.join("\n"), timestamp: messageTimestamp(message), index });
  }
  if (assistant.length > 0) {
    // Prefer explicit session timestamps when available. Some export revisions
    // have emitted messages out of array order after compaction/replay.
    const timestamped = assistant.filter((item) => item.timestamp !== null);
    if (timestamped.length > 0) {
      timestamped.sort((left, right) => left.timestamp - right.timestamp || left.index - right.index);
      return timestamped.at(-1).text;
    }
    return assistant.at(-1).text;
  }
  const textEvents = textEventsFromDocuments(messages);
  return textEvents.at(-1) ?? null;
}

export function finalAssistantResponseFromSessionExport(value) {
  const document = sessionExportDocumentFromValue(value);
  return document ? finalAssistantResponseFromSessionDocument(document) : null;
}

export function finalAssistantResponseFromJsonStream(value) {
  const documents = parseJsonDocuments(value);
  const assistantTexts = assistantTextsFromDocuments(documents);
  if (assistantTexts.length > 0) return assistantTexts.at(-1);
  const textEvents = textEventsFromDocuments(documents);
  return textEvents.at(-1) ?? null;
}

function balancedJsonObjectStrings(value) {
  const source = String(value ?? "");
  const objects = [];
  let start = null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== null) {
        objects.push(source.slice(start, index + 1));
        start = null;
      }
    }
  }
  return objects;
}

export function jsonObjectsFromFinalResponse(value) {
  const text = stripAnsi(value);
  if (!text) return [];
  try {
    const direct = JSON.parse(text);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return [direct];
  } catch {}
  // A linear scan preserves textual chronology across fenced and unfenced JSON
  // without recursively promoting nested objects.
  const raw = balancedJsonObjectStrings(text);
  const objects = [];
  const seen = new Set();
  for (const candidate of raw) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const key = JSON.stringify(parsed);
      if (seen.has(key)) continue;
      seen.add(key);
      objects.push(parsed);
    } catch {}
  }
  return objects;
}

function handoffCandidateScore(value, handoffSchema, brief) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !HANDOFF_STATUSES.has(value.status)) return null;
  const schemaKeys = new Set(Object.keys(handoffSchema?.properties ?? {}));
  const presentSchemaKeys = Object.keys(value).filter((key) => schemaKeys.has(key));
  const distinctiveFields = Object.keys(value).filter((key) => HANDOFF_DISTINCTIVE_FIELDS.has(key));
  const identityMatches = [["runId", brief?.runId], ["taskId", brief?.taskId], ["agentId", brief?.agentId]]
    .filter(([field, expected]) => typeof value[field] === "string" && value[field] === expected).length;
  // A status-only progress/summary object is not a Handoff. Two fenced identity
  // fields or one Handoff-distinctive envelope/evidence field is enough to retain
  // a genuinely partial final Handoff for deterministic normalization/projection.
  // Completeness is never used to prefer an earlier object over the later one.
  if (identityMatches < 2 && distinctiveFields.length === 0) return null;
  return presentSchemaKeys.length + distinctiveFields.length * 2 + identityMatches * 4 + (value.schemaVersion === 2 ? 2 : 0);
}

export function resolveAuthoritativeHandoff({ stdout, sessionExport = null, handoffSchema, brief, attempt = 1 }) {
  const hasSessionExport = typeof sessionExport === "string" && sessionExport.trim().length > 0;
  const exportUsable = hasSessionExport && sessionExportIsUsable(sessionExport);
  const source = exportUsable ? "session-export" : hasSessionExport ? "json-stream-fallback" : "json-stream";
  const finalResponse = exportUsable
    ? finalAssistantResponseFromSessionExport(sessionExport)
    : finalAssistantResponseFromJsonStream(stdout);
  if (!finalResponse) throw new Error(`opencode_${source.replaceAll("-", "_")}_final_assistant_response_not_found`);

  const objects = jsonObjectsFromFinalResponse(finalResponse);
  // Preserve response chronology: the last object that is recognizably a Handoff
  // is authoritative. Completeness is repaired/validated later; an earlier richer
  // object must never outrank a later task-authored Handoff. Status-only summaries
  // are still ignored by handoffCandidateScore.
  const selected = [...objects].reverse()
    .find((parsed) => handoffCandidateScore(parsed, handoffSchema, brief) !== null) ?? null;
  if (!selected) throw new Error(`opencode_handoff_not_found_in_${source.replaceAll("-", "_")}_final_response`);

  const normalized = normalizeModelHandoffContract({ handoff: selected, brief, attempt });
  if ((normalized.identityMismatches ?? []).length > 0) {
    const detail = normalized.identityMismatches
      .map(({ field, expected, actual }) => `${field}:expected=${expected}:actual=${actual}`)
      .join(",");
    throw new Error(`handoff_identity_mismatch:${detail}`);
  }
  const validation = validateAgainstSchema(normalized.handoff, handoffSchema, "handoffResult");
  return {
    handoff: normalized.handoff,
    authoritySource: source,
    sessionExportUsable: exportUsable,
    sessionExportFallbackReason: hasSessionExport && !exportUsable ? "session_export_incomplete_or_invalid" : null,
    finalResponse,
    schemaValid: validation.valid,
    schemaErrors: validation.errors,
    normalization: normalized,
  };
}
