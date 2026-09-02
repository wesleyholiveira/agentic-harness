import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { PersistentMcpToolClient, type PersistentMcpDiagnostics, type PersistentToolClient } from "./persistent-mcp-client.js";
import type {
  CodeSnippetResult,
  CoverageResult,
  IndexStatusResult,
  SymbolSearchResult,
  TracePathResult,
} from "./types";

const execFileAsync = promisify(execFile);

const CBM_BINARY = "codebase-memory-mcp";
const DEFAULT_PROJECT = "agentic-harness-project";

type CbmTransportMode = "persistent-mcp" | "cli";

export interface CBMAdapterOptions {
  transport?: CbmTransportMode;
  serverArgs?: string[];
  persistentClient?: PersistentToolClient;
}

export interface CbmReadyResult {
  status: IndexStatusResult;
  indexed: boolean;
}

export interface CbmReadyOptions {
  autoIndex?: boolean;
  probeTimeoutMs?: number;
  indexTimeoutMs?: number;
  mode?: "full" | "fast" | "moderate";
}

interface SearchGraphLegacyOutput {
  groups?: Array<{
    qn_prefix: string;
    file: string;
    rows: Array<[string, string, string, number, number]>;
  }>;
}

interface SearchGraphCurrentResult {
  name?: string;
  qualified_name?: string;
  label?: string;
  kind?: string;
  file_path?: string;
  file?: string;
  lines?: string;
  start_line?: number;
  end_line?: number;
  in_degree?: number;
  out_degree?: number;
  in?: number;
  out?: number;
}

interface SearchGraphCurrentOutput {
  results?: SearchGraphCurrentResult[];
}

type SearchGraphOutput = SearchGraphLegacyOutput & SearchGraphCurrentOutput;

interface TracePathGroup {
  qn_prefix: string;
  file: string;
  rows: Array<[string, number]>;
}

interface TracePathRaw {
  function: string;
  direction: string;
  callers_total?: number;
  callers?: { cols: string[]; groups: TracePathGroup[] };
  callees_total?: number;
  callees?: { cols: string[]; groups: TracePathGroup[] };
}

interface CbmProjectEntry {
  name: string;
  root_path?: string;
}

function normalizeRoot(path: string): string {
  return resolve(path).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}

function isPersistentTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/cbm_mcp_tool_error:/i.test(message)) return false;
  return /cbm_mcp_(?:failed|connect_failed).*?(connection|closed|not connected|transport|econn|epipe|request.*timeout|timed out|abort)/i.test(message)
    || /(connection|closed|not connected|transport|econn|epipe|request.*timeout|timed out|abort).*?cbm_mcp_(?:failed|connect_failed)/i.test(message);
}

function extractProjects(value: unknown): CbmProjectEntry[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(extractProjects);
  const record = value as Record<string, unknown>;
  const directName = typeof record.name === "string"
    ? record.name
    : typeof record.project === "string"
      ? record.project
      : null;
  if (directName) {
    return [{
      name: directName,
      ...(typeof record.root_path === "string" ? { root_path: record.root_path } : {}),
    }];
  }
  if (Array.isArray(record.projects)) {
    return record.projects.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      const name = typeof item.name === "string" ? item.name : typeof item.project === "string" ? item.project : null;
      if (!name) return [];
      return [{ name, ...(typeof item.root_path === "string" ? { root_path: item.root_path } : {}) }];
    });
  }
  if (Array.isArray(record.content)) {
    return record.content.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const text = (entry as Record<string, unknown>).text;
      if (typeof text !== "string") return [];
      try { return extractProjects(JSON.parse(text)); } catch { return []; }
    });
  }
  return [];
}

function normalizeSearchGraphOutput(output: string): SymbolSearchResult[] {
  const parsed = JSON.parse(output) as SearchGraphOutput;
  if (Array.isArray(parsed.results)) {
    return parsed.results.flatMap((result) => {
      const qualifiedName = typeof result.qualified_name === "string" && result.qualified_name.length > 0
        ? result.qualified_name
        : typeof result.name === "string" && result.name.length > 0
          ? result.name
          : null;
      const file = typeof result.file_path === "string"
        ? result.file_path
        : typeof result.file === "string"
          ? result.file
          : "";
      if (!qualifiedName || !file) return [];
      const hasLineRange = typeof result.start_line === "number" && Number.isFinite(result.start_line)
        && typeof result.end_line === "number" && Number.isFinite(result.end_line);
      const lines = typeof result.lines === "string"
        ? result.lines
        : hasLineRange
          ? `${result.start_line}-${result.end_line}`
          : "";
      return [{
        qualified_name: qualifiedName,
        label: typeof result.label === "string" ? result.label : typeof result.kind === "string" ? result.kind : "",
        file,
        lines,
        in_degree: typeof result.in_degree === "number" && Number.isFinite(result.in_degree)
          ? result.in_degree
          : typeof result.in === "number" && Number.isFinite(result.in) ? result.in : 0,
        out_degree: typeof result.out_degree === "number" && Number.isFinite(result.out_degree)
          ? result.out_degree
          : typeof result.out === "number" && Number.isFinite(result.out) ? result.out : 0,
      }];
    });
  }

  const results: SymbolSearchResult[] = [];
  for (const group of parsed.groups ?? []) {
    for (const row of group.rows ?? []) {
      results.push({
        qualified_name: `${group.qn_prefix}.${row[0]}`,
        label: row[1],
        file: group.file,
        lines: row[2],
        in_degree: row[3],
        out_degree: row[4],
      });
    }
  }
  return results;
}

function parseProjectList(output: string): CbmProjectEntry[] {
  try {
    const parsed = extractProjects(JSON.parse(output));
    if (parsed.length > 0) return parsed;
  } catch {
    // Some CBM builds render a human-readable list when not explicitly asked
    // for the raw MCP envelope. Fall through to a conservative line parser.
  }
  const projects: CbmProjectEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([^\s].*?)\s+\d+\s+nodes?\b/i);
    if (match?.[1]) projects.push({ name: match[1].trim() });
  }
  return projects;
}

export class CBMAdapter {
  private readonly transportMode: CbmTransportMode;
  private readonly serverArgs: string[];
  private readonly persistentClient: PersistentToolClient;
  private persistentCliFallbacks = 0;

  constructor(
    private projectName: string = DEFAULT_PROJECT,
    private binary: string = CBM_BINARY,
    private repositoryRoot?: string,
    options: CBMAdapterOptions = {},
  ) {
    this.transportMode = options.transport ?? (process.env.CONTEXT_ENGINE_CBM_TRANSPORT === "cli" ? "cli" : "persistent-mcp");
    this.serverArgs = [...(options.serverArgs ?? [])];
    this.persistentClient = options.persistentClient ?? new PersistentMcpToolClient(this.binary, this.serverArgs, this.repositoryRoot);
  }

  getRuntimeConfig(): {
    project: string;
    binary: string;
    repositoryRoot?: string;
    transport: CbmTransportMode;
    serverArgs: string[];
    persistent?: PersistentMcpDiagnostics;
    persistentCliFallbacks?: number;
  } {
    return {
      project: this.projectName,
      binary: this.binary,
      ...(this.repositoryRoot ? { repositoryRoot: this.repositoryRoot } : {}),
      transport: this.transportMode,
      serverArgs: [...this.serverArgs],
      ...(this.transportMode === "persistent-mcp" ? {
        persistent: this.persistentClient.getDiagnostics(),
        persistentCliFallbacks: this.persistentCliFallbacks,
      } : {}),
    };
  }

  async close(): Promise<void> {
    await this.persistentClient.close();
  }

  async runCli(args: string[], timeoutMs = Number(process.env.CBM_CLI_TIMEOUT_MS ?? 8_000)): Promise<string> {
    const tool = args[1] ?? "unknown";
    try {
      const result = await execFileAsync(this.binary, args, {
        maxBuffer: 50 * 1024 * 1024,
        encoding: "utf-8",
        timeout: Math.max(250, timeoutMs),
        windowsHide: true,
      });
      const stdout = result?.stdout;
      if (stdout === undefined || stdout === null) {
        throw new Error(`cbm_cli_stdout_missing:${tool}`);
      }
      return String(stdout).trim();
    } catch (error) {
      const details = error as Error & { stdout?: unknown; stderr?: unknown; code?: unknown; signal?: unknown; killed?: unknown };
      const stderr = details?.stderr === undefined || details?.stderr === null ? "" : String(details.stderr).trim();
      const stdout = details?.stdout === undefined || details?.stdout === null ? "" : String(details.stdout).trim();
      const reason = stderr || stdout || (error instanceof Error ? error.message : String(error));
      const code = details?.code === undefined ? "unknown" : String(details.code);
      const signal = details?.signal === undefined || details?.signal === null ? "none" : String(details.signal);
      throw new Error(`cbm_cli_failed:${tool}:code=${code}:signal=${signal}:${reason}`);
    }
  }

  private defaultToolTimeoutMs(): number {
    return this.transportMode === "persistent-mcp"
      ? Number(process.env.CBM_MCP_REQUEST_TIMEOUT_MS ?? 15_000)
      : Number(process.env.CBM_CLI_TIMEOUT_MS ?? 8_000);
  }

  private async executeCliTool(
    tool: string,
    flags: string[],
    input: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<string> {
    const startedAt = Date.now();
    try {
      return await this.runCli(["cli", tool, ...flags], timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/(trim|unknown|unexpected|argument|option|flag|usage)/i.test(message)) throw error;
      const remaining = Math.max(250, timeoutMs - (Date.now() - startedAt));
      return await this.runCli(["cli", tool, JSON.stringify(input)], remaining);
    }
  }

  private async executeTool(
    tool: string,
    flags: string[],
    input: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<string> {
    const effectiveTimeoutMs = timeoutMs ?? this.defaultToolTimeoutMs();
    if (this.transportMode === "persistent-mcp") {
      try {
        return await this.persistentClient.callTool(tool, input, effectiveTimeoutMs);
      } catch (error) {
        if (!isPersistentTransportFailure(error)) throw error;
        // R15.2: persistent stdio is the normal low-overhead path, but an
        // upstream MCP transport close must not permanently wedge Context Engine
        // readiness. One CLI invocation uses the same CBM_CACHE_DIR/allowed root
        // and coordination daemon, then later calls can retry persistent MCP.
        this.persistentCliFallbacks += 1;
        const cliTimeoutMs = Math.max(1_000, Math.min(
          Number(process.env.CBM_CLI_TIMEOUT_MS ?? 8_000),
          effectiveTimeoutMs,
        ));
        return await this.executeCliTool(tool, flags, input, cliTimeoutMs);
      }
    }

    return await this.executeCliTool(tool, flags, input, effectiveTimeoutMs);
  }

  private async discoverProject(timeoutMs = this.defaultToolTimeoutMs()): Promise<string | null> {
    let projects: CbmProjectEntry[] = [];
    try {
      projects = parseProjectList(await this.executeTool("list_projects", [], {}, timeoutMs));
    } catch {
      // list_projects declares no input schema. Do not pass a synthetic `{}`
      // argument: current CBM explicitly treats this tool as argument-less.
    }
    if (projects.length === 0) return null;

    if (this.repositoryRoot) {
      const expectedRoot = normalizeRoot(this.repositoryRoot);
      const byRoot = projects.find((project) => project.root_path && normalizeRoot(project.root_path) === expectedRoot);
      if (byRoot) return byRoot.name;
      const repositoryName = basename(resolve(this.repositoryRoot)).toLowerCase();
      const byName = projects.find((project) => project.name.toLowerCase().includes(repositoryName));
      if (byName) return byName.name;
    }
    if (projects.length === 1) return projects[0]?.name ?? null;
    return null;
  }

  private async runProjectOperation(operation: (project: string) => Promise<string>): Promise<string> {
    try {
      return await operation(this.projectName);
    } catch (originalError) {
      const discoveredProject = await this.discoverProject().catch(() => null);
      if (discoveredProject && discoveredProject !== this.projectName) {
        this.projectName = discoveredProject;
        return await operation(this.projectName);
      }
      throw originalError;
    }
  }

  async searchSymbols(pattern: string, label?: string): Promise<SymbolSearchResult[]> {
    const output = await this.runProjectOperation(async (project) => {
      const flags = [
        "--project", project,
        "--name-pattern", pattern,
        "--limit", "50",
        "--format", "json",
      ];
      if (label) flags.push("--label", label);
      return await this.executeTool(
        "search_graph",
        flags,
        { project, name_pattern: pattern, limit: 50, format: "json", ...(label ? { label } : {}) },
      );
    });
    return normalizeSearchGraphOutput(output);
  }

  async getArchitecture(): Promise<string> {
    return await this.runProjectOperation(async (project) =>
      await this.executeTool(
        "get_architecture",
        ["--project", project, "--aspects", "overview"],
        { project, aspects: "overview" },
      ),
    );
  }

  async tracePath(functionName: string, direction: string, depth = 3): Promise<TracePathResult> {
    const output = await this.runProjectOperation(async (project) =>
      await this.executeTool(
        "trace_path",
        [
          "--project", project,
          "--function-name", functionName,
          "--direction", direction,
          "--depth", String(depth),
          "--format", "json",
        ],
        { project, function_name: functionName, direction, depth },
      ),
    );
    const parsed = JSON.parse(output) as TracePathRaw;
    const isCallers = parsed.direction === "inbound";
    const total = isCallers ? (parsed.callers_total ?? 0) : (parsed.callees_total ?? 0);
    const data = isCallers ? parsed.callers : parsed.callees;
    const nodes = (data?.groups ?? []).flatMap((group) =>
      group.rows.map((row) => ({
        qualified_name: `${group.qn_prefix}.${row[0]}`,
        label: "",
        file: group.file,
        lines: "",
        depth: row[1],
      })),
    );
    return { direction: parsed.direction, nodes, total };
  }

  async getSnippet(qualifiedName: string): Promise<CodeSnippetResult> {
    const output = await this.runProjectOperation(async (project) =>
      await this.executeTool(
        "get_code_snippet",
        ["--project", project, "--qualified-name", qualifiedName],
        { project, qualified_name: qualifiedName },
      ),
    );
    const parsed = JSON.parse(output) as {
      qualified_name: string;
      file_path: string;
      start_line: number;
      end_line: number;
      source: string;
    };
    return {
      qualified_name: parsed.qualified_name,
      code: parsed.source,
      file: parsed.file_path,
      lines: `${parsed.start_line}-${parsed.end_line}`,
    };
  }

  async checkCoverage(paths: string[]): Promise<CoverageResult> {
    const output = await this.runProjectOperation(async (project) =>
      await this.executeTool(
        "check_index_coverage",
        ["--project", project, "--paths", JSON.stringify(paths)],
        { project, paths },
      ),
    );
    const parsed = JSON.parse(output) as {
      project: string;
      paths: Array<{
        path: string;
        status: string;
        coverage: Array<{
          path: string;
          kind: string;
          detail: string;
          match: string;
          ranges: Array<{ start: number; end: number }>;
        }>;
      }>;
    };
    const allCovered = parsed.paths.every((item) => item.status === "no_recorded_issue");
    const missedRanges = parsed.paths.flatMap((item) => item.coverage.map((coverage) => coverage.detail));
    return { covered: allCovered, missed_ranges: missedRanges };
  }

  private parseIndexStatus(output: string): IndexStatusResult {
    const parsed = JSON.parse(output) as {
      project: string;
      nodes: number;
      edges: number;
      status: string;
    };
    return {
      project: parsed.project,
      nodes: parsed.nodes,
      edges: parsed.edges,
      status: parsed.status,
    };
  }

  async probe(timeoutMs = Number(process.env.CONTEXT_ENGINE_HEALTH_CBM_TIMEOUT_MS ?? 5_000)): Promise<IndexStatusResult> {
    const startedAt = Date.now();
    const remaining = () => Math.max(250, timeoutMs - (Date.now() - startedAt));

    // Fast path: health should not enumerate all projects on every probe. The
    // configured project is authoritative when it is healthy, and index_status
    // is both cheaper and less failure-prone than list_projects on some Windows
    // CBM builds. Project discovery is only a recovery path.
    try {
      const output = await this.executeTool(
        "index_status",
        ["--project", this.projectName],
        { project: this.projectName },
        remaining(),
      );
      return this.parseIndexStatus(output);
    } catch (originalError) {
      if (Date.now() - startedAt >= timeoutMs) throw originalError;
      const discoveredProject = await this.discoverProject(remaining()).catch(() => null);
      if (!discoveredProject || discoveredProject === this.projectName) throw originalError;
      this.projectName = discoveredProject;
      const output = await this.executeTool(
        "index_status",
        ["--project", this.projectName],
        { project: this.projectName },
        remaining(),
      );
      return this.parseIndexStatus(output);
    }
  }

  async ensureIndexed({
    indexTimeoutMs = Number(process.env.CONTEXT_ENGINE_CBM_BOOTSTRAP_TIMEOUT_MS ?? 300_000),
    mode = (process.env.CONTEXT_ENGINE_CBM_BOOTSTRAP_MODE as CbmReadyOptions["mode"] | undefined) ?? "full",
  }: Pick<CbmReadyOptions, "indexTimeoutMs" | "mode"> = {}): Promise<IndexStatusResult> {
    if (!this.repositoryRoot) throw new Error("cbm_repository_root_required_for_index_bootstrap");
    const repoPath = resolve(this.repositoryRoot);
    const startedAt = Date.now();
    const remaining = () => Math.max(250, indexTimeoutMs - (Date.now() - startedAt));

    const indexOutput = await this.executeTool(
      "index_repository",
      ["--repo-path", repoPath, "--mode", mode],
      { repo_path: repoPath, mode },
      remaining(),
    );

    try {
      const indexedProject = extractProjects(JSON.parse(indexOutput))[0]?.name;
      if (indexedProject) this.projectName = indexedProject;
    } catch {
      // Older/current CBM frontends can return a human-readable summary.
      // Root-based discovery below remains the compatibility path.
    }
    const discoveredProject = await this.discoverProject(remaining()).catch(() => null);
    if (discoveredProject) this.projectName = discoveredProject;
    return await this.probe(remaining());
  }

  async ensureReady({
    autoIndex = process.env.CONTEXT_ENGINE_CBM_AUTO_INDEX !== "false",
    probeTimeoutMs = Number(process.env.CONTEXT_ENGINE_HEALTH_CBM_COLD_TIMEOUT_MS ?? 15_000),
    indexTimeoutMs = Number(process.env.CONTEXT_ENGINE_CBM_BOOTSTRAP_TIMEOUT_MS ?? 300_000),
    mode = (process.env.CONTEXT_ENGINE_CBM_BOOTSTRAP_MODE as CbmReadyOptions["mode"] | undefined) ?? "full",
  }: CbmReadyOptions = {}): Promise<CbmReadyResult> {
    try {
      return { status: await this.probe(probeTimeoutMs), indexed: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingIndex = /(project not found|not indexed|no projects indexed)/i.test(message);
      if (!autoIndex || !missingIndex) throw error;
      const status = await this.ensureIndexed({ indexTimeoutMs, mode });
      return { status, indexed: true };
    }
  }

  async getIndexStatus(): Promise<IndexStatusResult> {
    const output = await this.runProjectOperation(async (project) =>
      await this.executeTool(
        "index_status",
        ["--project", project],
        { project },
      ),
    );
    return this.parseIndexStatus(output);
  }
}
