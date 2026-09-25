import { createHash } from "node:crypto";

const KNOWN_VALIDATION_EXECUTABLES = new Set([
  "bash", "biome", "bun", "cargo", "cd", "cmake", "cmd", "cmd.exe", "corepack", "ctest",
  "deno", "docker", "docker-compose", "dotnet", "env", "eslint", "export", "git", "go", "gradle",
  "gradlew", "java", "javac", "jest", "make", "mvn", "mvnw", "mypy", "node", "npm", "npx", "nx",
  "pip", "pip3", "pipx", "pnpm", "poetry", "powershell", "powershell.exe", "pwsh", "py", "pytest",
  "python", "python3", "ruff", "rustc", "set", "sh", "tsc", "tox", "turbo", "uv", "vitest", "yarn", "zsh",
]);

const REPOSITORY_RELATIVE_VALIDATION_SCRIPT_EXTENSIONS = String.raw`(?:sh|bash|zsh|fish|ps1|cmd|bat|exe|com|py|pyw|js|mjs|cjs|ts|mts|cts|rb|pl|php|jar)`;
const REPOSITORY_RELATIVE_VALIDATION_PATH_PATTERN_SOURCE = String.raw`(?:(?:[^\\/\s]+[\\/])*(?:scripts|bin|tools)[\\/][^\s]+|(?:[^\\/\s]+[\\/])+[^\\/\s]+\.\${REPOSITORY_RELATIVE_VALIDATION_SCRIPT_EXTENSIONS})`;

// Structured-output schema pattern: require a command-shaped first executable rather than
// accepting arbitrary prose. A bare token merely containing "/" is NOT enough: product
// verification prose such as "HTTP/BFF/ML identity tests including N06." must remain prose,
// while explicit paths, script-like repository-relative paths and scripts/bin/tools entries
// remain valid. Complex validations can always be wrapped in `bash -lc`, `sh -lc`,
// `pwsh -Command`, etc.
export const VALIDATION_COMMAND_PATTERN_SOURCE = String.raw`^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)\s+)*(?:(?:\.{0,2}[\\/]|~[\\/]|[A-Za-z]:[\\/])[^\s]*|\${REPOSITORY_RELATIVE_VALIDATION_PATH_PATTERN_SOURCE}|(?:bash|biome|bun|cargo|cd|cmake|cmd(?:\.exe)?|corepack|ctest|deno|docker(?:-compose)?|dotnet|env|eslint|export|git|go|gradle|gradlew|java|javac|jest|make|mvn|mvnw|mypy|node|npm|npx|nx|pip|pip3|pipx|pnpm|poetry|powershell(?:\.exe)?|pwsh|py|pytest|python|python3|ruff|rustc|set|sh|tsc|tox|turbo|uv|vitest|yarn|zsh))(?:\s|$)`;


export const VALIDATION_EXECUTION_SCOPES = Object.freeze(["workspace", "container", "authoritative-host", "live"]);


const FOCUSED_VALIDATION_CONTEXT_PATTERN = /(?:valida(?:ç|c)[aã]o\s+focad[ao]|focused\s+validation|validation\s+focused)(?:\s+(?:em|com|using|to))?\s*[:=\-]?\s*$/iu;

/**
 * Extract an explicit focused implementation-validation directive from a request.
 *
 * A focused directive is intentionally narrow: only executable commands placed in
 * an inline-code span immediately after wording such as `validação focada` or
 * `focused validation` become authority. Other code spans remain ordinary request
 * prose and never silently become Runtime gates.
 */
export function implementationValidationDirectiveFromRequest(request) {
  const text = String(request ?? "");
  const commands = [];
  const inline = /`([^`\r\n]+)`/g;
  let match;
  while ((match = inline.exec(text)) !== null) {
    const command = String(match[1] ?? "").trim();
    if (!isExecutableValidationCommand(command)) continue;
    const before = text.slice(Math.max(0, Number(match.index ?? 0) - 160), Number(match.index ?? 0));
    if (!FOCUSED_VALIDATION_CONTEXT_PATTERN.test(before)) continue;
    if (!commands.includes(command)) commands.push(command);
  }
  return commands.length > 0
    ? { mode: "focused", commands }
    : { mode: "none", commands: [] };
}

function normalizeValidationExecutionScope(value) {
  const scope = String(value ?? "workspace").trim().toLowerCase();
  return VALIDATION_EXECUTION_SCOPES.includes(scope) ? scope : "workspace";
}

/**
 * Classify the narrowest execution authority required by a validation command.
 * This is deliberately conservative for commands that are explicitly tied to
 * the host-side OpenCode continuation/TUI qualification surface. Everything
 * else remains workspace scoped unless the Technical Plan declares a broader
 * scope and a downstream readiness gate owns it.
 */
export function classifyValidationExecutionScope(command) {
  const text = String(command ?? "").trim().toLowerCase();
  if (!text) return "workspace";
  if (/runtime:agent-live-projector:probe|\bopencode\s+attach\b|runtime-progress-observation/.test(text)) return "live";
  if (/runtime:agent-authoritative:readiness/.test(text)) return "authoritative-host";
  if (/runtime:agent-harness:validate/.test(text) && /--mode(?:=|\s+)authoritative/.test(text)) return "authoritative-host";
  if (/agent_harness_opencode_continuation_host_probe_url|127\.0\.0\.1:4096|localhost:4096/.test(text)) return "authoritative-host";
  const normalizedPaths = text.replaceAll("\\", "/");
  // `.runtime/agents/**` is Runtime-owned ephemeral state. It is deliberately
  // absent from isolated implementation workspaces/worktrees, so validation
  // that depends on replay capsules or run/task state requires host authority.
  if (/(?:^|[\s"'=/])\.runtime\/agents\//.test(normalizedPaths)) return "authoritative-host";
  return "workspace";
}

export function validationScopeCompatibilityIssue({ taskStage, declaredScope = "workspace", command } = {}) {
  const stage = String(taskStage ?? "").trim().toLowerCase();
  const declared = normalizeValidationExecutionScope(declaredScope);
  const inferred = classifyValidationExecutionScope(command);
  if (stage === "implementation") {
    if (declared !== "workspace") return `validation_scope_forbidden_for_stage:implementation:${declared}`;
    if (inferred !== "workspace") return `validation_scope_exceeds_task:implementation:${declared}:${inferred}`;
  }
  return null;
}

function stripQuotes(value) {
  const text = String(value ?? "");
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

function firstExecutableToken(command) {
  const text = String(command ?? "").trim();
  if (!text || /[\r\n]/.test(text)) return null;
  const tokens = text.split(/\s+/);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=\S+$/.test(tokens[index])) index += 1;
  if (index >= tokens.length) return null;
  return stripQuotes(tokens[index]);
}

function looksLikeValidationProse(command) {
  const text = String(command ?? "").trim();
  if (!text) return false;

  // A Product criterion may start with a real executable while still being an
  // English assertion about the command, e.g. "npm test exits with code 0.".
  // Such prose is evidence semantics, not shell authority.
  if (/\s(?:exits?|returns?)\s+(?:with\s+)?(?:exit\s+)?(?:code|status)\b/iu.test(text)) return true;
  if (/\s(?:passes?|succeeds?|fails?|completes?)\s*(?:successfully|cleanly|with\s+(?:success|failure))?[.!?]?$/iu.test(text)) return true;
  return false;
}

// `test` is intentionally not accepted as a direct validation executable.
// It is both a POSIX shell builtin and an ordinary English verb/noun, so prose
// such as "Test file is present and npm test executes successfully." would be
// indistinguishable from a command if we classified only by the first token.
// Use `bash -lc "test ..."` or `sh -lc "test ..."` when POSIX `test` semantics
// are actually required. This keeps criterion.verification prose non-authoritative
// while preserving an explicit shell-command escape hatch.
export function isExecutableValidationCommand(command) {
  const root = firstExecutableToken(command);
  if (!root || looksLikeValidationProse(command)) return false;
  const normalized = root.toLowerCase();
  if (KNOWN_VALIDATION_EXECUTABLES.has(normalized)) return true;
  if (/^(?:\.{0,2}[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(root)) return true;

  // A slash by itself is ambiguous with domain prose such as HTTP/BFF/ML. For
  // repository-relative commands require either a script/binary-looking suffix
  // or an explicit scripts/bin/tools segment. Extensionless executables outside
  // those conventional directories remain available through an unambiguous ./path.
  const repositoryRelative = root.replaceAll("\\", "/");
  if (/^[^\s/]+(?:\/[^\s/]+)+$/.test(repositoryRelative)) {
    const parts = repositoryRelative.split("/");
    const basename = parts.at(-1) ?? "";
    const scriptExtension = new RegExp(
      `\\.(?:${REPOSITORY_RELATIVE_VALIDATION_SCRIPT_EXTENSIONS})import { createHash } from "node:crypto";

const KNOWN_VALIDATION_EXECUTABLES = new Set([
  "bash", "biome", "bun", "cargo", "cd", "cmake", "cmd", "cmd.exe", "corepack", "ctest",
  "deno", "docker", "docker-compose", "dotnet", "env", "eslint", "export", "git", "go", "gradle",
  "gradlew", "java", "javac", "jest", "make", "mvn", "mvnw", "mypy", "node", "npm", "npx", "nx",
  "pip", "pip3", "pipx", "pnpm", "poetry", "powershell", "powershell.exe", "pwsh", "py", "pytest",
  "python", "python3", "ruff", "rustc", "set", "sh", "tsc", "tox", "turbo", "uv", "vitest", "yarn", "zsh",
]);

const REPOSITORY_RELATIVE_VALIDATION_SCRIPT_EXTENSIONS = String.raw`(?:sh|bash|zsh|fish|ps1|cmd|bat|exe|com|py|pyw|js|mjs|cjs|ts|mts|cts|rb|pl|php|jar)`;
const REPOSITORY_RELATIVE_VALIDATION_PATH_PATTERN_SOURCE = String.raw`(?:(?:[^\\/\s]+[\\/])*(?:scripts|bin|tools)[\\/][^\s]+|(?:[^\\/\s]+[\\/])+[^\\/\s]+\.\${REPOSITORY_RELATIVE_VALIDATION_SCRIPT_EXTENSIONS})`;

// Structured-output schema pattern: require a command-shaped first executable rather than
// accepting arbitrary prose. A bare token merely containing "/" is NOT enough: product
// verification prose such as "HTTP/BFF/ML identity tests including N06." must remain prose,
// while explicit paths, script-like repository-relative paths and scripts/bin/tools entries
// remain valid. Complex validations can always be wrapped in `bash -lc`, `sh -lc`,
// `pwsh -Command`, etc.
export const VALIDATION_COMMAND_PATTERN_SOURCE = String.raw`^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)\s+)*(?:(?:\.{0,2}[\\/]|~[\\/]|[A-Za-z]:[\\/])[^\s]*|\${REPOSITORY_RELATIVE_VALIDATION_PATH_PATTERN_SOURCE}|(?:bash|biome|bun|cargo|cd|cmake|cmd(?:\.exe)?|corepack|ctest|deno|docker(?:-compose)?|dotnet|env|eslint|export|git|go|gradle|gradlew|java|javac|jest|make|mvn|mvnw|mypy|node|npm|npx|nx|pip|pip3|pipx|pnpm|poetry|powershell(?:\.exe)?|pwsh|py|pytest|python|python3|ruff|rustc|set|sh|tsc|tox|turbo|uv|vitest|yarn|zsh))(?:\s|$)`;


export const VALIDATION_EXECUTION_SCOPES = Object.freeze(["workspace", "container", "authoritative-host", "live"]);


const FOCUSED_VALIDATION_CONTEXT_PATTERN = /(?:valida(?:ç|c)[aã]o\s+focad[ao]|focused\s+validation|validation\s+focused)(?:\s+(?:em|com|using|to))?\s*[:=\-]?\s*$/iu;

/**
 * Extract an explicit focused implementation-validation directive from a request.
 *
 * A focused directive is intentionally narrow: only executable commands placed in
 * an inline-code span immediately after wording such as `validação focada` or
 * `focused validation` become authority. Other code spans remain ordinary request
 * prose and never silently become Runtime gates.
 */
export function implementationValidationDirectiveFromRequest(request) {
  const text = String(request ?? "");
  const commands = [];
  const inline = /`([^`\r\n]+)`/g;
  let match;
  while ((match = inline.exec(text)) !== null) {
    const command = String(match[1] ?? "").trim();
    if (!isExecutableValidationCommand(command)) continue;
    const before = text.slice(Math.max(0, Number(match.index ?? 0) - 160), Number(match.index ?? 0));
    if (!FOCUSED_VALIDATION_CONTEXT_PATTERN.test(before)) continue;
    if (!commands.includes(command)) commands.push(command);
  }
  return commands.length > 0
    ? { mode: "focused", commands }
    : { mode: "none", commands: [] };
}

function normalizeValidationExecutionScope(value) {
  const scope = String(value ?? "workspace").trim().toLowerCase();
  return VALIDATION_EXECUTION_SCOPES.includes(scope) ? scope : "workspace";
}

/**
 * Classify the narrowest execution authority required by a validation command.
 * This is deliberately conservative for commands that are explicitly tied to
 * the host-side OpenCode continuation/TUI qualification surface. Everything
 * else remains workspace scoped unless the Technical Plan declares a broader
 * scope and a downstream readiness gate owns it.
 */
export function classifyValidationExecutionScope(command) {
  const text = String(command ?? "").trim().toLowerCase();
  if (!text) return "workspace";
  if (/runtime:agent-live-projector:probe|\bopencode\s+attach\b|runtime-progress-observation/.test(text)) return "live";
  if (/runtime:agent-authoritative:readiness/.test(text)) return "authoritative-host";
  if (/runtime:agent-harness:validate/.test(text) && /--mode(?:=|\s+)authoritative/.test(text)) return "authoritative-host";
  if (/agent_harness_opencode_continuation_host_probe_url|127\.0\.0\.1:4096|localhost:4096/.test(text)) return "authoritative-host";
  const normalizedPaths = text.replaceAll("\\", "/");
  // `.runtime/agents/**` is Runtime-owned ephemeral state. It is deliberately
  // absent from isolated implementation workspaces/worktrees, so validation
  // that depends on replay capsules or run/task state requires host authority.
  if (/(?:^|[\s"'=/])\.runtime\/agents\//.test(normalizedPaths)) return "authoritative-host";
  return "workspace";
}

export function validationScopeCompatibilityIssue({ taskStage, declaredScope = "workspace", command } = {}) {
  const stage = String(taskStage ?? "").trim().toLowerCase();
  const declared = normalizeValidationExecutionScope(declaredScope);
  const inferred = classifyValidationExecutionScope(command);
  if (stage === "implementation") {
    if (declared !== "workspace") return `validation_scope_forbidden_for_stage:implementation:${declared}`;
    if (inferred !== "workspace") return `validation_scope_exceeds_task:implementation:${declared}:${inferred}`;
  }
  return null;
}

function stripQuotes(value) {
  const text = String(value ?? "");
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

function firstExecutableToken(command) {
  const text = String(command ?? "").trim();
  if (!text || /[\r\n]/.test(text)) return null;
  const tokens = text.split(/\s+/);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=\S+$/.test(tokens[index])) index += 1;
  if (index >= tokens.length) return null;
  return stripQuotes(tokens[index]);
}

function looksLikeValidationProse(command) {
  const text = String(command ?? "").trim();
  if (!text) return false;

  // A Product criterion may start with a real executable while still being an
  // English assertion about the command, e.g. "npm test exits with code 0.".
  // Such prose is evidence semantics, not shell authority.
  if (/\s(?:exits?|returns?)\s+(?:with\s+)?(?:exit\s+)?(?:code|status)\b/iu.test(text)) return true;
  if (/\s(?:passes?|succeeds?|fails?|completes?)\s*(?:successfully|cleanly|with\s+(?:success|failure))?[.!?]?$/iu.test(text)) return true;
  return false;
}

// `test` is intentionally not accepted as a direct validation executable.
// It is both a POSIX shell builtin and an ordinary English verb/noun, so prose
// such as "Test file is present and npm test executes successfully." would be
// indistinguishable from a command if we classified only by the first token.
// Use `bash -lc "test ..."` or `sh -lc "test ..."` when POSIX `test` semantics
// are actually required. This keeps criterion.verification prose non-authoritative
// while preserving an explicit shell-command escape hatch.
export function isExecutableValidationCommand(command) {
  const root = firstExecutableToken(command);
  if (!root || looksLikeValidationProse(command)) return false;
  const normalized = root.toLowerCase();
,
      "iu",
    );
    const conventionalExecutableDirectory = parts
      .slice(0, -1)
      .some((segment) => ["scripts", "bin", "tools"].includes(segment.toLowerCase()));
    if (scriptExtension.test(basename) || conventionalExecutableDirectory) return true;
  }
  return false;
}

export function invalidValidationCommands(commands = []) {
  if (!Array.isArray(commands)) return [{ index: -1, command: commands, reason: "validation_not_array" }];
  return commands
    .map((command, index) => ({ index, command }))
    .filter(({ command }) => !isExecutableValidationCommand(command))
    .map(({ index, command }) => ({ index, command, reason: "validation_command_not_executable" }));
}

export function assertExecutableValidationCommands(commands = [], { label = "validation" } = {}) {
  const invalid = invalidValidationCommands(commands);
  if (invalid.length === 0) return commands;
  const details = invalid
    .map((entry) => `${label}[${entry.index}]=${JSON.stringify(entry.command)}`)
    .join("; ");
  throw new Error(`validation_command_not_executable:${details}`);
}

export function validationCommandId(command) {
  const normalized = String(command ?? "").trim();
  if (!isExecutableValidationCommand(normalized)) throw new Error(`validation_command_id_invalid:${JSON.stringify(command)}`);
  return `vcmd:sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

export function validationCommandProjectionIssues({ commandIds = [], commands = [] } = {}) {
  if (!Array.isArray(commandIds) || !Array.isArray(commands)) return ["validation_command_projection_not_array"];
  if (commandIds.length !== commands.length) return ["validation_command_projection_length_mismatch"];
  const issues = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = String(commands[index] ?? "").trim();
    let expected;
    try { expected = validationCommandId(command); } catch { issues.push(`validation_command_projection_command_invalid:${index}`); continue; }
    if (commandIds[index] !== expected) issues.push(`validation_command_projection_id_mismatch:${index}`);
  }
  return issues;
}
