import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256File } from "./util.mjs";

export const FIXTURE_FILES = Object.freeze({
  ".gitignore": `.runtime/\n.agent-harness/\n`,
  "README.md": `# Agentic Harness qualification consumer\n\nSynthetic consumer used only for standalone Agentic Harness qualification.\n`,
  "package.json": `{
  "name": "agentic-harness-qualification-consumer",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}\n`,
  "src/format-name.mjs": `export function formatName(name) {\n  return String(name).trim();\n}\n`,
  "test/format-name.test.mjs": `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { formatName } from "../src/format-name.mjs";\n\ntest("trims surrounding whitespace", () => {\n  assert.equal(formatName("  Wesley  "), "Wesley");\n});\n`,
  "docs/adr/0001-example.md": `# ADR 0001 — Keep the synthetic consumer dependency-free\n\nStatus: Accepted\n\nThe synthetic consumer uses Node.js built-ins only.\n\nProduction code must not introduce third-party dependencies.\nTests use the built-in \`node:test\` runner.\n`,
  "docs/specs/example/PRD.md": `# Example PRD — Anonymous fallback for blank display names\n\n## Context\n\nThe consumer already exposes \`formatName(name)\`, which converts the input to a string and removes surrounding whitespace.\n\nA blank display name is currently returned as an empty string.\n\n## Goal\n\nChange \`formatName(name)\` so that an input which becomes empty after trimming returns the literal string \`Anonymous\`.\n\n## Functional requirements\n\nFR-1. Trim surrounding whitespace exactly as the current implementation does.\n\nFR-2. If the trimmed value is non-empty, return that trimmed value unchanged.\n\nFR-3. If the trimmed value is empty, return exactly \`Anonymous\`.\n\nFR-4. Inputs containing only whitespace count as empty after trimming.\n\nFR-5. Preserve the existing \`String(name)\` conversion behavior.\n\n## Acceptance criteria\n\nAC-1. \`formatName("  Wesley  ") === "Wesley"\`\n\nAC-2. \`formatName("   ") === "Anonymous"\`\n\nAC-3. \`formatName("") === "Anonymous"\`\n\nAC-4. Existing behavior for non-empty values remains covered by tests.\n\nAC-5. Add automated tests covering both blank-string and whitespace-only fallback.\n\nAC-6. \`npm test\` exits with code 0.\n\nAC-7. No external runtime or test dependency is introduced.\n\nAC-8. Changes remain confined to the consumer repository.\n\n## Non-goals\n\n- no API;\n- no database;\n- no UI;\n- no infrastructure change;\n- no dependency upgrade;\n- no modification of the Agentic Harness itself.\n\n## Validation command\n\n\`npm test\`\n`,
  "docs/specs/qualification/r10/PRD.md": `# R-10 PRD — Stable slug helper\n\n## Context\n\nThe qualification consumer already exposes formatting helpers in \`src/format-name.mjs\`. R-10 needs one small, real implementation slice so the continuation-outage fault is armed only after Technical Refinement has produced an executable implementation plan.\n\n## Goal\n\nAdd an exported \`formatSlug(name)\` helper without changing the behavior of existing helpers.\n\n## Functional requirements\n\nFR-1. Convert the input with \`String(name)\` and trim surrounding whitespace.\n\nFR-2. If the trimmed value is empty, return exactly \`anonymous\`.\n\nFR-3. For a non-empty value, split on one-or-more whitespace characters, discard empty words, join the words with a single hyphen, and lowercase the result with \`toLowerCase()\`.\n\nFR-4. Preserve \`formatName\` and \`formatInitials\` behavior.\n\nFR-5. Do not add runtime or test dependencies.\n\n## Acceptance criteria\n\nAC-R10-1. \`formatSlug("  Wesley Oliveira  ") === "wesley-oliveira"\`.\n\nAC-R10-2. \`formatSlug("Wesley") === "wesley"\`.\n\nAC-R10-3. \`formatSlug("   ") === "anonymous"\`.\n\nAC-R10-4. Existing \`formatName\` and \`formatInitials\` tests remain green.\n\nAC-R10-5. Add automated \`node:test\` coverage for the slug helper.\n\nAC-R10-6. \`npm test\` exits with code 0.\n\nAC-R10-7. Changes remain confined to the consumer repository.\n\n## Non-goals\n\n- no README-only change;\n- no API, database, UI or infrastructure work;\n- no dependency upgrade;\n- no modification of the Agentic Harness itself.\n\n## Validation command\n\n\`npm test\`\n`,
});

export function materializeFixture(consumerRoot) {
  for (const [relativePath, contents] of Object.entries(FIXTURE_FILES)) {
    const target = resolve(consumerRoot, relativePath);
    if (!target.startsWith(resolve(consumerRoot))) throw new Error(`qualification_fixture_path_escape:${relativePath}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  return fixtureIdentity(consumerRoot);
}

export function fixtureIdentity(consumerRoot) {
  return Object.fromEntries(Object.keys(FIXTURE_FILES).map((relativePath) => [relativePath, sha256File(resolve(consumerRoot, relativePath))]));
}

export function assertFixtureComplete(consumerRoot) {
  const prd = readFileSync(resolve(consumerRoot, "docs/specs/example/PRD.md"), "utf8");
  for (const section of ["## Context", "## Goal", "## Functional requirements", "## Acceptance criteria", "## Non-goals", "## Validation command"]) {
    if (!prd.includes(section)) throw new Error(`qualification_fixture_prd_section_missing:${section}`);
  }
  const frCount = (prd.match(/\bFR-\d+\./gu) ?? []).length;
  const acCount = (prd.match(/\bAC-\d+\./gu) ?? []).length;
  if (frCount < 5 || acCount < 6) throw new Error(`qualification_fixture_prd_incomplete:${frCount}:${acCount}`);
  return { frCount, acCount, identity: fixtureIdentity(consumerRoot) };
}

export function assertR10FixtureComplete(consumerRoot) {
  const prd = readFileSync(resolve(consumerRoot, "docs/specs/qualification/r10/PRD.md"), "utf8");
  for (const section of ["## Context", "## Goal", "## Functional requirements", "## Acceptance criteria", "## Non-goals", "## Validation command"]) {
    if (!prd.includes(section)) throw new Error(`qualification_r10_fixture_prd_section_missing:${section}`);
  }
  const frCount = (prd.match(/\bFR-\d+\./gu) ?? []).length;
  const acCount = (prd.match(/\bAC-R10-\d+\./gu) ?? []).length;
  if (frCount < 5 || acCount < 7) throw new Error(`qualification_r10_fixture_prd_incomplete:${frCount}:${acCount}`);
  return { frCount, acCount, sha256: sha256File(resolve(consumerRoot, "docs/specs/qualification/r10/PRD.md")) };
}
