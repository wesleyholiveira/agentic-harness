import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export class QualificationHold extends Error {
  constructor(gate, classification, message, evidence = {}) {
    super(message);
    this.name = "QualificationHold";
    this.gate = gate;
    this.classification = classification;
    this.evidence = evidence;
  }
}

export class QualificationReport {
  constructor({ runId, outputDir, harnessRoot }) {
    this.runId = runId;
    this.outputDir = outputDir;
    this.harnessRoot = harnessRoot;
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.gates = [];
    this.firstDivergence = null;
    this.identity = {};
    this.resources = {};
    this.notes = [];
  }

  beginGate(name) {
    const gate = { name, result: "RUNNING", startedAt: new Date().toISOString(), finishedAt: null, evidence: {} };
    this.gates.push(gate);
    return gate;
  }

  pass(gate, evidence = {}) {
    gate.result = "PASS";
    gate.finishedAt = new Date().toISOString();
    gate.evidence = evidence;
  }

  hold(gate, hold) {
    gate.result = "HOLD";
    gate.finishedAt = new Date().toISOString();
    gate.evidence = hold.evidence ?? {};
    this.firstDivergence ??= {
      gate: hold.gate || gate.name,
      classification: hold.classification || "UNRESOLVED",
      message: hold.message,
      evidence: hold.evidence ?? {},
    };
  }

  skip(name, reason = "blocked by first divergence") {
    this.gates.push({ name, result: "NOT RUN", startedAt: null, finishedAt: null, evidence: { reason } });
  }

  finish() {
    this.finishedAt = new Date().toISOString();
  }

  toJSON() {
    return {
      contractVersion: "agentic-harness-standalone-qualification/v1",
      runId: this.runId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      verdict: this.firstDivergence ? "HOLD" : "PASS",
      harnessRoot: this.harnessRoot,
      outputDir: this.outputDir,
      gates: this.gates,
      firstDivergence: this.firstDivergence,
      identity: this.identity,
      resources: this.resources,
      notes: this.notes,
    };
  }

  write() {
    mkdirSync(this.outputDir, { recursive: true });
    const jsonPath = resolve(this.outputDir, "qualification-report.json");
    const markdownPath = resolve(this.outputDir, "qualification-report.md");
    const data = this.toJSON();
    writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    const rows = data.gates.map((gate) => `| ${gate.name} | ${gate.result} | ${summarize(gate.evidence)} |`).join("\n");
    const first = data.firstDivergence
      ? `\n## First divergence\n\n- Gate: ${data.firstDivergence.gate}\n- Classification: ${data.firstDivergence.classification}\n- Message: ${data.firstDivergence.message}\n`
      : "\n## First divergence\n\nNone.\n";
    const markdown = `# Agentic Harness standalone qualification\n\n**Run:** ${data.runId}  \n**Verdict:** AGENTIC HARNESS v1.0.0 PROMOTION ${data.verdict}\n\n| Gate | Result | Evidence |\n|---|---|---|\n${rows}\n${first}\n## Source identity\n\n\`\`\`json\n${JSON.stringify(data.identity, null, 2)}\n\`\`\`\n`;
    writeFileSync(markdownPath, markdown, "utf8");
    return { jsonPath, markdownPath };
  }
}

function summarize(value) {
  if (!value || typeof value !== "object") return String(value ?? "").replaceAll("|", "\\|");
  const keys = Object.keys(value);
  if (keys.length === 0) return "—";
  return keys.slice(0, 6).map((key) => `${key}=${short(value[key])}`).join("; ").replaceAll("|", "\\|");
}

function short(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value.length > 90 ? `${value.slice(0, 87)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  return "{...}";
}
