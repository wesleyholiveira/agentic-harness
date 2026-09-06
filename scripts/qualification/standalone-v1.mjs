#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveComposeProjectIdentity } from "../internal/compose-project-identity.mjs";
import {
  buildHeadroomEnvironment,
  buildHeadroomWrapInvocation,
  startHeadroomProxy,
} from "../internal/headroom-opencode.mjs";
import { ProcessRunner, terminateProcessTree } from "./lib/process.mjs";
import { QualificationHold, QualificationReport } from "./lib/report.mjs";
import {
  allocatePortSet,
  ensureDir,
  isPortFree,
  nativeRealpath,
  parseJsonOutput,
  randomId,
  sha256File,
  sleep,
  stripAnsi,
  waitFor,
  writeJson,
} from "./lib/util.mjs";
import { assertFixtureComplete, fixtureIdentity, materializeFixture } from "./lib/fixture.mjs";
import { basicAuthHeaders, requestJson, waitForJsonReady } from "./lib/http.mjs";
import { evaluateRuntimeObservation, formatRuntimeProgress } from "./lib/runtime-watchdog.mjs";
import {
  DEFAULT_CONTINUATION_COMPLETION_TIMEOUT_MS,
  evaluateContinuationObservation,
  formatContinuationProgress,
} from "./lib/continuation-watchdog.mjs";
import { resolveExecutionLivenessPolicy } from "../../.agents/runtime/execution-liveness.mjs";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = parseArgs(process.argv.slice(2));
const harnessRoot = nativeRealpath(process.env.AGENT_HARNESS_ROOT || scriptRoot);
const runId = args.runId || randomId("standalone-v1");
const outputDir = ensureDir(resolve(args.output || join(tmpdir(), "agentic-harness-qualification", runId)));
const runner = new ProcessRunner({ outputDir });
const report = new QualificationReport({ runId, outputDir, harnessRoot });
const state = {
  harnessRoot,
  outputDir,
  runId,
  ports: null,
  consumers: {},
  composeProject: null,
  consumerEnv: null,
  preexistingDocker: null,
  dnsProject: null,
  dnsComposeYaml: null,
  freshTeiContainer: null,
  headroom: null,
  opencode: null,
  opencodeAuth: null,
  effectiveConfig: null,
  effectiveConfigPath: null,
  pluginSha: null,
  r7: null,
  r9: null,
  r10: null,
};

const gateOrder = ["Q-ENTRY", "PRE-R0", "R-0", "R-1", "R-2", "R-3", "R-4", "R-5", "R-6", "R-7", "R-8", "R-9", "R-10"];
let firstHold = null;

const gates = {
  "Q-ENTRY": qEntry,
  "PRE-R0": preR0,
  "R-0": r0,
  "R-1": r1,
  "R-2": r2,
  "R-3": r3,
  "R-4": r4,
  "R-5": r5,
  "R-6": r6,
  "R-7": r7,
  "R-8": r8,
  "R-9": r9,
  "R-10": r10,
};

try {
  if (args.selfTest) {
    await selfTest();
  } else {
    for (const name of gateOrder) {
      if (firstHold) {
        report.skip(name);
        continue;
      }
      const gate = report.beginGate(name);
      try {
        const evidence = await gates[name]();
        report.pass(gate, evidence);
      } catch (error) {
        const hold = normalizeHold(name, error);
        report.hold(gate, hold);
        firstHold = hold;
      }
    }
  }
} finally {
  const cleanupGate = report.beginGate("R-11");
  try {
    const evidence = await cleanup();
    report.pass(cleanupGate, evidence);
  } catch (error) {
    const hold = normalizeHold("R-11", error, "QUALIFICATION CLEANUP");
    report.hold(cleanupGate, hold);
    firstHold ??= hold;
  }
  report.finish();
  const paths = report.write();
  console.log(JSON.stringify({
    verdict: report.firstDivergence ? "HOLD" : "PASS",
    runId,
    report: paths,
    firstDivergence: report.firstDivergence,
  }, null, 2));
  process.exitCode = report.firstDivergence ? 1 : 0;
}

function legacyProductNamespacePattern() {
  return [
    ["clip", "compass"].join("-"),
    ["Clip", "Compass"].join(" "),
    ["clip", "compass"].join("_"),
    ["CLIP", "COMPASS"].join("_"),
  ].join("|");
}

function parseArgs(argv) {
  const out = { output: null, selfTest: false, runId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output") out.output = argv[++i];
    else if (arg === "--run-id") out.runId = argv[++i];
    else if (arg === "--self-test") out.selfTest = true;
    else throw new Error(`qualification_unknown_argument:${arg}`);
  }
  return out;
}

function hold(gate, classification, message, evidence = {}) {
  throw new QualificationHold(gate, classification, message, evidence);
}

function normalizeHold(gate, error, fallbackClassification = "QUALIFICATION PROCEDURE") {
  if (error instanceof QualificationHold) return error;
  return new QualificationHold(gate, fallbackClassification, error instanceof Error ? error.message : String(error), {
    code: error?.code ?? null,
    command: error?.evidence ?? null,
    stack: error instanceof Error ? error.stack : null,
  });
}

function mustRun(gate, classification, command, commandArgs, options = {}) {
  try {
    return runner.run(command, commandArgs, options);
  } catch (error) {
    hold(gate, classification, error.message, error.evidence ?? {});
  }
}

function git(args, options = {}) {
  return runner.run("git", ["-C", options.cwd || harnessRoot, ...args], {
    ...options,
    cwd: harnessRoot,
    label: options.label || `git-${args[0] || "command"}`,
  });
}

function gitText(root, args) {
  return runner.run("git", ["-C", root, ...args], { cwd: harnessRoot, label: `git-${args[0]}` }).stdout.trim();
}

function assertCleanSource(gate) {
  const status = gitText(harnessRoot, ["status", "--short"]);
  if (status) hold(gate, "SOURCE", "agent_harness_git_worktree_dirty", { status });
  return status;
}

function walk(dir, { skip = new Set(["node_modules", ".git", ".runtime", "qualification"]) } = {}) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = resolve(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) out.push(...walk(path, { skip }));
    else out.push(path);
  }
  return out;
}

async function qEntry() {
  const probes = {};
  for (const [name, command, commandArgs] of [
    ["git", "git", ["--version"]],
    ["node", process.execPath, ["--version"]],
    ["npm", "npm", ["--version"]],
    ["docker", "docker", ["--version"]],
  ]) {
    const result = mustRun("Q-ENTRY", "QUALIFICATION ENVIRONMENT", command, commandArgs, { label: `qentry-${name}` });
    probes[name] = { exitCode: result.exitCode, output: (result.stdout || result.stderr).trim() };
  }
  const top = gitText(harnessRoot, ["rev-parse", "--show-toplevel"]);
  if (nativeRealpath(top) !== harnessRoot) hold("Q-ENTRY", "QUALIFICATION ENVIRONMENT", "harness_checkout_not_accessible", { top, harnessRoot });
  return { executionMode: "deterministic-cli", runtimeCallsBeforeR7: 0, harnessRoot, probes };
}

async function preR0() {
  const source = {
    head: gitText(harnessRoot, ["rev-parse", "HEAD"]),
    status: gitText(harnessRoot, ["status", "--short"]),
  };
  if (source.status) hold("PRE-R0", "SOURCE", "pre_r0_source_dirty", source);

  const preDoctor = mustRun("PRE-R0", "SOURCE", process.execPath, [resolve(harnessRoot, "scripts/harness-doctor.mjs"), harnessRoot], { cwd: harnessRoot, label: "pre-r0-doctor-before-npm-ci" });
  const preDoctorJson = parseJsonOutput(preDoctor.stdout);
  if (preDoctorJson.ok !== true) hold("PRE-R0", "SOURCE", "pre_r0_initial_doctor_failed", { doctor: preDoctorJson });
  mustRun("PRE-R0", "SOURCE", "npm", ["ci"], { cwd: harnessRoot, label: "pre-r0-npm-ci", timeoutMs: 15 * 60_000 });
  const doctor1 = mustRun("PRE-R0", "SOURCE", process.execPath, [resolve(harnessRoot, "scripts/harness-doctor.mjs"), harnessRoot], { cwd: harnessRoot, label: "pre-r0-doctor-after-npm-ci" });
  const doctor = parseJsonOutput(doctor1.stdout);
  if (doctor.superpowers?.complete !== true || doctor.superpowers?.vendoredSkills !== 14 || doctor.agentCount !== 20) {
    hold("PRE-R0", "SOURCE", "pre_r0_doctor_inventory_invalid", { doctor });
  }

  const toolchain = {};
  for (const [name, command, commandArgs] of [
    ["node", process.execPath, ["--version"]],
    ["npm", "npm", ["--version"]],
    ["git", "git", ["--version"]],
    ["opencode", "opencode", ["--version"]],
    ["rustc", "rustc", ["--version"]],
    ["cargo", "cargo", ["--version"]],
    ["docker", "docker", ["--version"]],
    ["compose", "docker", ["compose", "version"]],
    ["uv", "uv", ["--version"]],
    ["uvx", "uvx", ["--version"]],
    ["rtk", "rtk", ["--version"]],
  ]) {
    const result = mustRun("PRE-R0", "QUALIFICATION ENVIRONMENT", command, commandArgs, { label: `toolchain-${name}` });
    toolchain[name] = (result.stdout || result.stderr).trim();
  }
  if (!doctor.binary?.["codebase-memory-mcp"]) hold("PRE-R0", "QUALIFICATION ENVIRONMENT", "codebase_memory_mcp_unavailable", { doctor: doctor.codebaseMemory });
  toolchain["codebase-memory-mcp"] = doctor.codebaseMemoryExecutable;

  const ports = await allocatePortSet();
  for (const [name, port] of Object.entries(ports)) {
    if (!(await isPortFree(port))) hold("PRE-R0", "ENVIRONMENT", "qualification_port_not_free", { name, port });
  }
  state.ports = ports;

  state.preexistingDocker = {
    containers: runner.run("docker", ["ps", "-a", "--format", "{{.ID}}|{{.Names}}|{{.Image}}"], { label: "preexisting-containers" }).stdout.trim().split(/\r?\n/u).filter(Boolean),
    networks: runner.run("docker", ["network", "ls", "--format", "{{.ID}}|{{.Name}}"], { label: "preexisting-networks" }).stdout.trim().split(/\r?\n/u).filter(Boolean),
    volumes: runner.run("docker", ["volume", "ls", "--format", "{{.Name}}"], { label: "preexisting-volumes" }).stdout.trim().split(/\r?\n/u).filter(Boolean),
  };

  const networking = await preR0Networking();
  assertCleanSource("PRE-R0");
  report.identity.PRE_R0_HEAD = source.head;
  report.resources.ports = ports;
  report.resources.preexistingDocker = state.preexistingDocker;
  return { head: source.head, doctor: { agentCount: doctor.agentCount, superpowers: doctor.superpowers }, toolchain, ports, networking };
}

async function preR0Networking() {
  const hostDns = await dns.lookup("huggingface.co", { all: true });
  if (!Array.isArray(hostDns) || hostDns.length === 0) hold("PRE-R0", "ENVIRONMENT", "host_dns_unavailable");
  const https = await requestJson("https://huggingface.co/api/models?limit=1", { timeoutMs: 20_000, allowStatuses: [200] });

  mustRun("PRE-R0", "ENVIRONMENT", "docker", ["run", "--rm", "alpine:3.20", "nslookup", "huggingface.co"], { label: "container-dns", timeoutMs: 60_000 });
  mustRun("PRE-R0", "ENVIRONMENT", "docker", ["run", "--rm", "alpine:3.20", "wget", "-q", "-O", "/dev/null", "https://huggingface.co"], { label: "container-https", timeoutMs: 60_000 });

  const dnsProject = `agentic-harness-preflight-dns-${randomBytes(6).toString("hex")}`;
  state.dnsProject = dnsProject;
  const yaml = `services:\n  postgres:\n    image: alpine:3.20\n    command: [\"sh\", \"-c\", \"sleep 300\"]\n  probe:\n    image: alpine:3.20\n    command: [\"sh\", \"-c\", \"sleep 300\"]\n`;
  state.dnsComposeYaml = yaml;
  const compose = (extra, options = {}) => runner.run("docker", ["compose", "--project-name", dnsProject, "--file", "-", ...extra], { input: yaml, label: options.label || `dns-compose-${extra[0]}`, timeoutMs: options.timeoutMs ?? 120_000, allowExitCodes: options.allowExitCodes });
  try {
    compose(["config"], { label: "dns-compose-config" });
    compose(["up", "-d", "--remove-orphans"], { label: "dns-compose-up" });
    await waitFor(() => {
      const running = compose(["ps", "--services", "--status", "running"], { label: "dns-compose-running" }).stdout.trim().split(/\r?\n/u).filter(Boolean).sort();
      return JSON.stringify(running) === JSON.stringify(["postgres", "probe"]);
    }, { timeoutMs: 30_000, label: "compose-dns-services-running" });
    const postgresId = compose(["ps", "-q", "postgres"], { label: "dns-postgres-id" }).stdout.trim();
    const probeId = compose(["ps", "-q", "probe"], { label: "dns-probe-id" }).stdout.trim();
    const postgresInspect = JSON.parse(runner.run("docker", ["inspect", postgresId], { label: "dns-postgres-inspect" }).stdout)[0];
    const probeInspect = JSON.parse(runner.run("docker", ["inspect", probeId], { label: "dns-probe-inspect" }).stdout)[0];
    const postgresNetworks = Object.values(postgresInspect.NetworkSettings?.Networks ?? {});
    const probeNetworks = Object.values(probeInspect.NetworkSettings?.Networks ?? {});
    if (postgresNetworks.length !== 1 || probeNetworks.length !== 1 || postgresNetworks[0]?.NetworkID !== probeNetworks[0]?.NetworkID) {
      hold("PRE-R0", "QUALIFICATION PROCEDURE", "compose_dns_network_membership_invalid", { postgresNetworks, probeNetworks });
    }
    const networkId = postgresNetworks[0].NetworkID;
    const networkInspect = JSON.parse(runner.run("docker", ["network", "inspect", networkId], { label: "dns-network-inspect" }).stdout)[0];
    if (networkInspect.Labels?.["com.docker.compose.project"] !== dnsProject) hold("PRE-R0", "QUALIFICATION PROCEDURE", "compose_dns_network_ownership_invalid", { labels: networkInspect.Labels });
    compose(["exec", "-T", "probe", "nslookup", "postgres"], { label: "dns-compose-nslookup" });
  } finally {
    try { compose(["down", "--volumes", "--remove-orphans"], { label: "dns-compose-down", allowExitCodes: [0, 1] }); } catch {}
    state.dnsProject = null;
  }

  const teiName = `agentic-harness-preflight-tei-${randomBytes(5).toString("hex")}`;
  state.freshTeiContainer = teiName;
  try {
    mustRun("PRE-R0", "ENVIRONMENT", "docker", [
      "run", "-d", "--name", teiName,
      "-p", `127.0.0.1:${state.ports.embeddings}:80`,
      "ghcr.io/huggingface/text-embeddings-inference:cpu-1.8.3",
      "--model-id", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    ], { label: "fresh-tei-start", timeoutMs: 10 * 60_000 });
    const embed = await waitFor(async () => {
      try {
        const response = await requestJson(`http://127.0.0.1:${state.ports.embeddings}/embed`, {
          method: "POST",
          body: { inputs: "agentic harness qualification" },
          timeoutMs: 5_000,
          allowStatuses: [200],
        });
        return Array.isArray(response.body) ? response.body : null;
      } catch { return null; }
    }, { timeoutMs: 10 * 60_000, intervalMs: 2_000, label: "fresh-tei-embed" });
    if (!embed) hold("PRE-R0", "ENVIRONMENT", "fresh_tei_embed_invalid");
  } finally {
    try { runner.run("docker", ["rm", "-f", teiName], { label: "fresh-tei-cleanup", allowExitCodes: [0, 1] }); } catch {}
    state.freshTeiContainer = null;
  }

  return { hostDns, hostHttpsStatus: https.status, containerDnsHttps: true, composeDns: true, freshTei: true };
}

async function r0() {
  assertCleanSource("R-0");
  const head = gitText(harnessRoot, ["rev-parse", "HEAD"]);
  if (head !== report.identity.PRE_R0_HEAD) hold("R-0", "SOURCE", "r0_head_changed_after_pre_r0", { head, pre: report.identity.PRE_R0_HEAD });
  const manifestCheck = mustRun("R-0", "SOURCE", process.execPath, [resolve(harnessRoot, "scripts/internal/source-manifest.mjs"), "--check"], { cwd: harnessRoot, label: "r0-manifest-check" });
  const manifestResult = parseJsonOutput(manifestCheck.stdout);
  if (manifestResult.ok !== true) hold("R-0", "SOURCE", "r0_manifest_mismatch", { manifestResult });
  const manifestPrint = mustRun("R-0", "SOURCE", process.execPath, [resolve(harnessRoot, "scripts/internal/source-manifest.mjs")], { cwd: harnessRoot, label: "r0-manifest-print" });
  const source = parseJsonOutput(manifestPrint.stdout);

  const tracked = gitText(harnessRoot, ["ls-files"]).split(/\r?\n/u).filter(Boolean);
  const forbiddenPaths = [".agents/registry.json", ".agents/runtime/registry.mjs"];
  for (const path of forbiddenPaths) if (tracked.includes(path)) hold("R-0", "SOURCE", "r0_forbidden_registry_present", { path });
  for (const path of tracked) {
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path) || path.split("/").includes("..")) hold("R-0", "SOURCE", "r0_tracked_path_invalid", { path });
    const parts = path.split("/");
    if (parts.includes("node_modules") || parts.includes(".runtime")) hold("R-0", "SOURCE", "r0_forbidden_runtime_source_path", { path });
  }
  const agentCount = readdirSync(resolve(harnessRoot, ".agents/agents"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  if (agentCount !== 20) hold("R-0", "SOURCE", "r0_agent_count_invalid", { agentCount });
  const workflowText = readFileSync(resolve(harnessRoot, ".agents/workflow.json"), "utf8");
  if (!workflowText.includes("technical-refinement") || !workflowText.includes("implementationPlan")) hold("R-0", "SOURCE", "r0_dynamic_dag_authority_missing");

  const grep = runner.run("git", ["-C", harnessRoot, "grep", "-niE", legacyProductNamespacePattern(), "--", ":!qualification/baseline/r17.4.5/**"], { label: "r0-product-namespace", allowExitCodes: [0, 1] });
  if (grep.exitCode === 0 && grep.stdout.trim()) hold("R-0", "SOURCE", "r0_product_specific_operational_reference", { matches: grep.stdout.trim().split(/\r?\n/u) });

  const agents = JSON.parse(readFileSync(resolve(harnessRoot, ".opencode/agents.generated.json"), "utf8"));
  const permission = agents["main-orchestrator"]?.permission;
  if (permission?.edit !== "deny" || permission?.bash !== "deny" || permission?.task?.["*"] !== "deny" || permission?.["serena_*"] !== "deny") {
    hold("R-0", "SOURCE", "r0_main_orchestrator_runtime_ingress_boundary_missing", { permission });
  }
  const pluginText = readFileSync(resolve(harnessRoot, ".opencode/plugins/runtime-invocation-provenance.js"), "utf8");
  for (const marker of ["MAIN_ORCHESTRATOR_DIRECT_EXECUTION_TOOLS", "agent_runtime_main_orchestrator_direct_execution_denied", "AGENT_HARNESS_OPENCODE_RUNTIME_CHILD"]) {
    if (!pluginText.includes(marker)) hold("R-0", "SOURCE", "r0_plugin_runtime_ingress_fence_missing", { marker });
  }

  report.identity.R0_HEAD = head;
  report.identity.R0_TREE_SHA256 = source.treeSha256;
  report.identity.R0_TRACKED_FILES = source.trackedTotal;
  report.identity.packageLockSha256 = sha256File(resolve(harnessRoot, "package-lock.json"));
  report.identity.superpowersLockSha256 = sha256File(resolve(harnessRoot, "vendor/superpowers/lock.json"));
  return { head, treeSha256: source.treeSha256, trackedTotal: source.trackedTotal, agentCount, manifest: manifestResult.code, runtimeIngressBoundary: true };
}

async function r1() {
  mustRun("R-1", "SOURCE", "npm", ["run", "harness:test"], { cwd: harnessRoot, label: "r1-contracts", timeoutMs: 10 * 60_000 });
  const tracked = gitText(harnessRoot, ["ls-files"]).split(/\r?\n/u).filter(Boolean);
  let jsCount = 0;
  for (const path of tracked.filter((path) => /\.(?:js|mjs)$/u.test(path) && !path.startsWith("qualification/baseline/"))) {
    mustRun("R-1", "SOURCE", process.execPath, ["--check", resolve(harnessRoot, path)], { cwd: harnessRoot, label: `r1-node-check-${jsCount++}` });
  }
  let jsonCount = 0;
  for (const path of tracked.filter((path) => /\.json$/u.test(path) && !path.startsWith("qualification/baseline/"))) {
    JSON.parse(readFileSync(resolve(harnessRoot, path), "utf8"));
    jsonCount += 1;
  }
  for (const path of tracked.filter((path) => /\.jsonc$/u.test(path))) {
    const raw = readFileSync(resolve(harnessRoot, path), "utf8").replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
    JSON.parse(raw);
    jsonCount += 1;
  }
  const inventory = {
    agents: readdirSync(resolve(harnessRoot, ".agents/agents"), { withFileTypes: true }).filter((e) => e.isDirectory()).length,
    skills: readdirSync(resolve(harnessRoot, ".agents/skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).length,
    superpowers: readdirSync(resolve(harnessRoot, "vendor/superpowers/skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).length,
    schemas: readdirSync(resolve(harnessRoot, ".agents/schemas")).filter((n) => n.endsWith(".json")).length,
    migrations: readdirSync(resolve(harnessRoot, "infra/postgres/migrations")).filter((n) => n.endsWith(".sql")).length,
    publicScripts: Object.keys(JSON.parse(readFileSync(resolve(harnessRoot, "package.json"), "utf8")).scripts).length,
  };
  const expected = { agents: 20, skills: 22, superpowers: 14, schemas: 11, migrations: 11, publicScripts: 10 };
  for (const [key, value] of Object.entries(expected)) if (inventory[key] !== value) hold("R-1", "SOURCE", "r1_inventory_mismatch", { key, expected: value, actual: inventory[key] });
  assertCleanSource("R-1");
  return { contracts: "PASS", jsSyntaxFiles: jsCount, jsonFiles: jsonCount, inventory };
}

async function r2() {
  const commands = [
    ["typescript", "npx", ["tsc", "--noEmit"]],
    ["cargo-fmt", "cargo", ["fmt", "--manifest-path", "apps/runtime-worker/Cargo.toml", "--", "--check"]],
    ["cargo-check", "cargo", ["check", "--manifest-path", "apps/runtime-worker/Cargo.toml"]],
    ["cargo-test", "cargo", ["test", "--manifest-path", "apps/runtime-worker/Cargo.toml"]],
    ["cargo-clippy", "cargo", ["clippy", "--manifest-path", "apps/runtime-worker/Cargo.toml", "--all-targets", "--all-features", "--", "-D", "warnings"]],
    ["compose-config", "docker", ["compose", "-f", resolve(harnessRoot, "compose.yaml"), "config"]],
    ["runtime-build", "docker", ["compose", "-f", resolve(harnessRoot, "compose.yaml"), "--profile", "runtime", "build"]],
  ];
  const evidence = {};
  for (const [name, command, commandArgs] of commands) {
    evidence[name] = mustRun("R-2", "SOURCE", command, commandArgs, { cwd: harnessRoot, label: `r2-${name}`, timeoutMs: name === "runtime-build" ? 30 * 60_000 : 15 * 60_000 }).exitCode;
    assertCleanSource("R-2");
  }
  return evidence;
}

async function r3() {
  const consumerA = nativeRealpath(mkdtempSync(join(tmpdir(), "agentic-harness-consumer-a-")));
  const consumerB = nativeRealpath(mkdtempSync(join(tmpdir(), "agentic-harness-consumer-b-")));
  for (const consumer of [consumerA, consumerB]) {
    if (consumer === harnessRoot || isInside(harnessRoot, consumer) || isInside(consumer, harnessRoot)) hold("R-3", "QUALIFICATION PROCEDURE", "consumer_harness_root_overlap", { consumer, harnessRoot });
  }
  state.consumers = { A: consumerA, B: consumerB };

  for (const [label, consumer] of Object.entries(state.consumers)) {
    const identity = materializeFixture(consumer);
    mustRun("R-3", "QUALIFICATION PROCEDURE", "git", ["-C", consumer, "init"], { label: `r3-${label}-git-init` });
    mustRun("R-3", "QUALIFICATION PROCEDURE", "git", ["-C", consumer, "config", "user.name", "Agentic Harness Qualification"], { label: `r3-${label}-git-user` });
    mustRun("R-3", "QUALIFICATION PROCEDURE", "git", ["-C", consumer, "config", "user.email", "qualification@example.invalid"], { label: `r3-${label}-git-email` });
    mustRun("R-3", "QUALIFICATION PROCEDURE", "npm", ["--prefix", consumer, "test"], { label: `r3-${label}-baseline-test` });
    mustRun("R-3", "QUALIFICATION PROCEDURE", "git", ["-C", consumer, "add", "."], { label: `r3-${label}-git-add` });
    mustRun("R-3", "QUALIFICATION PROCEDURE", "git", ["-C", consumer, "commit", "-m", "qualification consumer baseline"], { label: `r3-${label}-baseline-commit` });
    mustRun("R-3", "QUALIFICATION PROCEDURE", "git", ["-C", consumer, "-c", "protocol.file.allow=always", "submodule", "add", harnessRoot, ".harness"], { label: `r3-${label}-submodule-add`, timeoutMs: 120_000 });
    mustRun("R-3", "QUALIFICATION PROCEDURE", "git", ["-C", consumer, "add", ".gitmodules", ".harness"], { label: `r3-${label}-submodule-stage` });
    mustRun("R-3", "QUALIFICATION PROCEDURE", "git", ["-C", consumer, "commit", "-m", "add Agentic Harness submodule"], { label: `r3-${label}-submodule-commit` });
    const subHead = gitText(resolve(consumer, ".harness"), ["rev-parse", "HEAD"]);
    if (subHead !== report.identity.R0_HEAD) hold("R-3", "SOURCE", "submodule_head_mismatch", { label, subHead, r0: report.identity.R0_HEAD });
    const manifest = parseJsonOutput(mustRun("R-3", "SOURCE", process.execPath, [resolve(consumer, ".harness/scripts/internal/source-manifest.mjs")], { cwd: resolve(consumer, ".harness"), env: { AGENT_HARNESS_ROOT: resolve(consumer, ".harness") }, label: `r3-${label}-submodule-manifest` }).stdout);
    if (manifest.treeSha256 !== report.identity.R0_TREE_SHA256) hold("R-3", "SOURCE", "submodule_tree_mismatch", { label, manifest: manifest.treeSha256, r0: report.identity.R0_TREE_SHA256 });
    state[`fixture${label}`] = identity;
  }

  const harnessA = resolve(consumerA, ".harness");
  const envA = { AGENT_HARNESS_ROOT: harnessA, AGENT_HARNESS_PROJECT_ROOT: consumerA };
  mustRun("R-3", "SOURCE", process.execPath, [resolve(harnessA, "bin/harness.mjs"), "bootstrap"], { cwd: consumerA, env: envA, label: "r3-bootstrap-a" });
  const doctor = mustRun("R-3", "SOURCE", process.execPath, [resolve(harnessA, "bin/harness.mjs"), "doctor"], { cwd: consumerA, env: envA, label: "r3-doctor-a" });
  const doctorJson = parseJsonOutput(doctor.stdout);
  if (nativeRealpath(doctorJson.projectRoot) !== consumerA || nativeRealpath(doctorJson.harnessRoot) !== nativeRealpath(harnessA)) hold("R-3", "SOURCE", "dual_root_identity_invalid", { doctor: doctorJson });

  const staleDoctor = mustRun("R-3", "SOURCE", process.execPath, [resolve(harnessA, "bin/harness.mjs"), "doctor"], {
    cwd: consumerA,
    env: { AGENT_HARNESS_ROOT: harnessA, AGENT_HARNESS_PROJECT_ROOT: harnessRoot },
    label: "r3-stale-root-recovery",
  });
  const stale = parseJsonOutput(staleDoctor.stdout);
  if (nativeRealpath(stale.projectRoot) !== consumerA || stale.projectRootResolution?.staleInheritedHarnessRootIgnored !== true) hold("R-3", "SOURCE", "stale_project_root_recovery_failed", { stale });

  const composeA = resolveComposeProjectIdentity(consumerA, envA);
  const composeB = resolveComposeProjectIdentity(consumerB, { AGENT_HARNESS_ROOT: resolve(consumerB, ".harness"), AGENT_HARNESS_PROJECT_ROOT: consumerB });
  if (composeA.name === composeB.name) hold("R-3", "SOURCE", "compose_consumer_identity_collision", { composeA, composeB });
  state.composeProject = composeA;
  report.identity.SUBMODULE_HEAD = report.identity.R0_HEAD;
  report.identity.SUBMODULE_TREE_SHA256 = report.identity.R0_TREE_SHA256;
  assertCleanSource("R-3");
  return { consumerA, consumerB, composeA, composeB, staleRootRecovery: true };
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function buildConsumerEnv() {
  const consumer = state.consumers.A;
  const harness = resolve(consumer, ".harness");
  const p = state.ports;
  const username = "opencode";
  const password = process.env.AGENT_HARNESS_QUALIFICATION_OPENCODE_PASSWORD || randomBytes(18).toString("base64url");
  state.opencodeAuth ??= { username, password };
  const base = {
    ...process.env,
    AGENT_HARNESS_ROOT: harness,
    AGENT_HARNESS_PROJECT_ROOT: consumer,
    AGENT_HARNESS_POSTGRES_PORT: String(p.postgres),
    AGENT_HARNESS_RABBITMQ_PORT: String(p.rabbitmq),
    AGENT_HARNESS_RABBITMQ_MANAGEMENT_PORT: String(p.rabbitmqManagement),
    AGENT_HARNESS_REDIS_PORT: String(p.redis),
    AGENT_HARNESS_EMBEDDINGS_PORT: String(p.embeddings),
    AGENT_HARNESS_CONTEXT_ENGINE_PORT: String(p.contextEngine),
    HEADROOM_PROXY_PORT: String(p.headroom),
    OPENCODE_PORT: String(p.opencode),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    AGENT_HARNESS_OPENCODE_CONTINUATION_USERNAME: username,
    AGENT_HARNESS_OPENCODE_CONTINUATION_PASSWORD: password,
    AGENT_HARNESS_OPENCODE_CONTINUATION_URL: `http://host.docker.internal:${p.opencode}`,
    AGENT_HARNESS_OPENCODE_CONTINUATION_HOST_PROBE_URL: `http://host.docker.internal:${p.opencode}`,
    AGENT_HARNESS_CONTEXT_ENGINE_MCP_URL: `http://127.0.0.1:${p.contextEngine}/mcp`,
    AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_URL: `http://127.0.0.1:${p.contextEngine}/runtime-invocation-provenance`,
  };
  state.consumerEnv = base;
  return base;
}

function composeCommand(extra, { allowExitCodes = [0], label = `compose-${extra[0]}`, timeoutMs = 120_000 } = {}) {
  return runner.run("docker", ["compose", "-p", state.composeProject.name, "-f", resolve(state.consumers.A, ".harness/compose.yaml"), ...extra], {
    cwd: state.consumers.A,
    env: { ...state.consumerEnv, COMPOSE_PROJECT_NAME: state.composeProject.name, AGENT_HARNESS_COMPOSE_PROJECT_NAME: state.composeProject.name, AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_PLUGIN_SHA256: state.pluginSha || pluginSha() },
    allowExitCodes,
    label,
    timeoutMs,
  });
}

function pluginSha() {
  return `sha256:${createHash("sha256").update(readFileSync(resolve(state.consumers.A || harnessRoot, state.consumers.A ? ".harness/.opencode/plugins/runtime-invocation-provenance.js" : ".opencode/plugins/runtime-invocation-provenance.js"))).digest("hex")}`;
}

async function requireHttpReady(gate, {
  service,
  url,
  request = {},
  timeoutMs = 120_000,
  intervalMs = 1_000,
}) {
  try {
    const readiness = await waitForJsonReady(url, {
      request,
      timeoutMs,
      intervalMs,
      label: service,
    });
    return {
      service,
      url,
      attempts: readiness.attempts,
      elapsedMs: readiness.elapsedMs,
      status: readiness.response.status,
    };
  } catch (error) {
    const classification =
      error?.code === "qualification_http_readiness_rejected"
        ? "SOURCE"
        : "ENVIRONMENT";
    hold(gate, classification, error instanceof Error ? error.message : String(error), {
      service,
      url,
      ...(error?.evidence ?? {}),
    });
  }
}

async function r4() {
  const env = buildConsumerEnv();
  state.pluginSha = pluginSha();
  for (const [name, port] of Object.entries(state.ports)) if (!(await isPortFree(port))) hold("R-4", "ENVIRONMENT", "qualification_port_race", { name, port });
  mustRun("R-4", "SOURCE", process.execPath, [resolve(state.consumers.A, ".harness/bin/harness.mjs"), "up"], { cwd: state.consumers.A, env: { ...env, AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_PLUGIN_SHA256: state.pluginSha }, label: "r4-harness-up", timeoutMs: 30 * 60_000 });

  const contextEngineReadiness = await requireHttpReady("R-4", {
    service: "context-engine",
    url: `http://127.0.0.1:${state.ports.contextEngine}/healthz`,
    request: { timeoutMs: 5_000, allowStatuses: [200] },
    timeoutMs: 5 * 60_000,
    intervalMs: 2_000,
  });

  const services = ["postgres", "rabbitmq", "redis", "context-embeddings", "context-engine", "agent-runtime-worker"];
  const containerEvidence = {};
  const containerInspects = {};
  for (const service of services) {
    const id = composeCommand(["ps", "-q", service], { label: `r4-${service}-id` }).stdout.trim();
    if (!id) hold("R-4", "ENVIRONMENT", "runtime_service_container_missing", { service });
    const inspect = JSON.parse(runner.run("docker", ["inspect", id], { label: `r4-${service}-inspect` }).stdout)[0];
    if (inspect.State?.Running !== true) hold("R-4", "ENVIRONMENT", "runtime_service_not_running", { service, state: inspect.State });
    if (service === "postgres" && inspect.State?.Health?.Status !== "healthy") hold("R-4", "ENVIRONMENT", "postgres_not_healthy", { health: inspect.State?.Health });
    containerInspects[service] = inspect;
    containerEvidence[service] = { id, pid: inspect.State?.Pid, health: inspect.State?.Health?.Status ?? "running", restartCount: inspect.RestartCount ?? 0 };
  }

  const workspaceDestination = "/workspace/agent-workspaces";
  const environmentMap = (inspect) => Object.fromEntries((inspect?.Config?.Env ?? []).map((entry) => {
    const separator = entry.indexOf("=");
    return separator < 0 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const contextEngineEnv = environmentMap(containerInspects["context-engine"]);
  const workerEnv = environmentMap(containerInspects["agent-runtime-worker"]);
  if (contextEngineEnv.AGENT_HARNESS_AGENT_WORKSPACE_ROOT !== workspaceDestination || workerEnv.AGENT_HARNESS_AGENT_WORKSPACE_ROOT !== workspaceDestination) {
    hold("R-4", "SOURCE", "runtime_workspace_root_authority_mismatch", {
      expected: workspaceDestination,
      contextEngine: contextEngineEnv.AGENT_HARNESS_AGENT_WORKSPACE_ROOT ?? null,
      worker: workerEnv.AGENT_HARNESS_AGENT_WORKSPACE_ROOT ?? null,
    });
  }
  const workspaceMountFor = (inspect) => (inspect?.Mounts ?? []).find((mount) => mount.Destination === workspaceDestination);
  const contextEngineWorkspaceMount = workspaceMountFor(containerInspects["context-engine"]);
  const workerWorkspaceMount = workspaceMountFor(containerInspects["agent-runtime-worker"]);
  if (!contextEngineWorkspaceMount || !workerWorkspaceMount) {
    hold("R-4", "SOURCE", "runtime_workspace_shared_volume_missing", {
      destination: workspaceDestination,
      contextEngineMount: contextEngineWorkspaceMount ?? null,
      workerMount: workerWorkspaceMount ?? null,
    });
  }
  if (contextEngineWorkspaceMount.Type !== "volume" || workerWorkspaceMount.Type !== "volume"
      || contextEngineWorkspaceMount.Source !== workerWorkspaceMount.Source) {
    hold("R-4", "SOURCE", "runtime_workspace_volume_not_shared", {
      destination: workspaceDestination,
      contextEngineMount: contextEngineWorkspaceMount,
      workerMount: workerWorkspaceMount,
    });
  }
  const workspaceAuthority = {
    root: workspaceDestination,
    volume: contextEngineWorkspaceMount.Source,
    contextEngineMountType: contextEngineWorkspaceMount.Type,
    workerMountType: workerWorkspaceMount.Type,
  };
  composeCommand(["exec", "-T", "redis", "redis-cli", "ping"], { label: "r4-redis-ping" });
  const rabbitmqReadiness = await requireHttpReady("R-4", {
    service: "rabbitmq-management",
    url: `http://127.0.0.1:${state.ports.rabbitmqManagement}/api/overview`,
    request: {
      headers: basicAuthHeaders("agent", "agent"),
      timeoutMs: 10_000,
      allowStatuses: [200],
    },
    timeoutMs: 2 * 60_000,
    intervalMs: 1_000,
  });
  const embeddingsReadiness = await requireHttpReady("R-4", {
    service: "context-embeddings",
    url: `http://127.0.0.1:${state.ports.embeddings}/embed`,
    request: {
      method: "POST",
      body: { inputs: "qualification" },
      timeoutMs: 10_000,
      allowStatuses: [200],
    },
    timeoutMs: 5 * 60_000,
    intervalMs: 2_000,
  });

  for (let i = 0; i < 2; i += 1) {
    mustRun("R-4", "SOURCE", process.execPath, [resolve(state.consumers.A, ".harness/bin/harness.mjs"), "migrate"], { cwd: state.consumers.A, env: { ...env, AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_PLUGIN_SHA256: state.pluginSha }, label: `r4-migrate-${i + 1}`, timeoutMs: 10 * 60_000 });
  }
  const migrationCount = Number(sqlScalar("SELECT count(*) FROM harness_migrations;"));
  const migrationDuplicateCount = Number(sqlScalar("SELECT count(*) FROM (SELECT name,count(*) c FROM harness_migrations GROUP BY name HAVING count(*)>1) d;"));
  if (migrationCount !== 11 || migrationDuplicateCount !== 0) hold("R-4", "SOURCE", "migration_idempotency_invalid", { migrationCount, migrationDuplicateCount });
  const workerHeartbeat = sqlScalar("SELECT heartbeat_at FROM agent_runtime_workers WHERE stopped_at IS NULL ORDER BY heartbeat_at DESC LIMIT 1;");
  if (!workerHeartbeat) hold("R-4", "RUNTIME", "runtime_worker_heartbeat_missing");

  if (existsSync(resolve(state.consumers.A, ".harness/node_modules"))) hold("R-4", "SOURCE", "submodule_node_modules_created");
  const volumes = runner.run("docker", ["volume", "ls", "--filter", `label=com.docker.compose.project=${state.composeProject.name}`, "--format", "{{.Name}}"], { label: "r4-compose-volumes" }).stdout.trim().split(/\r?\n/u).filter(Boolean);
  if (volumes.some((name) => state.preexistingDocker.volumes.includes(name))) hold("R-4", "SOURCE", "preexisting_volume_reused", { volumes });
  return { composeProject: state.composeProject.name, services: containerEvidence, workspaceAuthority, readiness: { contextEngine: contextEngineReadiness, rabbitmq: rabbitmqReadiness, embeddings: embeddingsReadiness }, migrations: migrationCount, workerHeartbeat, volumes };
}

function sqlScalar(sql) {
  return composeCommand(["exec", "-T", "postgres", "psql", "-U", "agent", "-d", "agent_harness", "-Atqc", sql], { label: "sql-scalar" }).stdout.trim();
}

function sqlRows(sql) {
  const stdout = composeCommand(["exec", "-T", "postgres", "psql", "-U", "agent", "-d", "agent_harness", "-At", "-F", "\t", "-c", sql], { label: "sql-rows" }).stdout.trim();
  return stdout ? stdout.split(/\r?\n/u).map((line) => line.split("\t")) : [];
}

async function r5() {
  const env = { ...state.consumerEnv, AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_PLUGIN_SHA256: state.pluginSha };
  if (state.headroom) hold("R-5", "QUALIFICATION PROCEDURE", "headroom_already_started");
  state.headroom = await startHeadroomProxy({ baseEnv: env, port: String(state.ports.headroom) });

  const generated = mustRun("R-5", "SOURCE", process.execPath, [resolve(state.consumers.A, ".harness/scripts/generate-opencode-config.mjs")], { cwd: state.consumers.A, env, label: "r5-generate-config" });
  const effectivePath = generated.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!effectivePath || nativeRealpath(dirname(effectivePath)) !== nativeRealpath(resolve(state.consumers.A, ".runtime"))) hold("R-5", "SOURCE", "effective_config_ownership_invalid", { effectivePath });
  const config = JSON.parse(readFileSync(effectivePath, "utf8"));
  const expectedMcp = `http://127.0.0.1:${state.ports.contextEngine}/mcp`;
  if (config.mcp?.["context-engine"]?.url !== expectedMcp) hold("R-5", "QUALIFICATION PROCEDURE", "context_engine_effective_authority_drift", { actual: config.mcp?.["context-engine"]?.url, expected: expectedMcp });
  const headroomCommand = config.mcp?.headroom?.command ?? [];
  const proxyIndex = headroomCommand.indexOf("--proxy-url");
  const expectedHeadroom = `http://127.0.0.1:${state.ports.headroom}`;
  if (proxyIndex < 0 || headroomCommand[proxyIndex + 1] !== expectedHeadroom) hold("R-5", "QUALIFICATION PROCEDURE", "headroom_effective_authority_drift", { headroomCommand, expectedHeadroom });
  const permission = config.agent?.["main-orchestrator"]?.permission;
  if (permission?.edit !== "deny" || permission?.bash !== "deny" || permission?.task?.["*"] !== "deny" || permission?.["serena_*"] !== "deny") hold("R-5", "SOURCE", "effective_main_orchestrator_boundary_invalid", { permission });

  state.effectiveConfig = config;
  state.effectiveConfigPath = effectivePath;
  const opencodeEnv = {
    ...env,
    OPENCODE_CONFIG: effectivePath,
    OPENCODE_CONFIG_DIR: resolve(state.consumers.A, ".harness/.opencode"),
  };
  const mcpList = mustRun("R-5", "ENVIRONMENT", "opencode", ["mcp", "list"], { cwd: state.consumers.A, env: opencodeEnv, label: "r5-mcp-list", timeoutMs: 5 * 60_000 });
  const text = stripAnsi(`${mcpList.stdout}\n${mcpList.stderr}`);
  const mandatory = ["context-engine", "serena", "headroom", "codebase-memory-mcp"];
  for (const name of mandatory) {
    const index = text.toLowerCase().indexOf(name.toLowerCase());
    if (index < 0 || !/(connected|✓|ready)/iu.test(text.slice(index, index + 220))) hold("R-5", "ENVIRONMENT", "mandatory_mcp_handshake_missing", { name, output: text.slice(Math.max(0, index), index + 400) });
  }
  return { effectivePath, contextEngineMcp: expectedMcp, headroomProxy: expectedHeadroom, mandatoryMcpHandshakes: mandatory, mainOrchestratorPermission: permission };
}

async function startQualifiedOpenCode(label = "opencode") {
  const baseEnv = {
    ...state.consumerEnv,
    AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_PLUGIN_SHA256: state.pluginSha,
    OPENCODE_CONFIG: state.effectiveConfigPath,
    OPENCODE_CONFIG_DIR: resolve(state.consumers.A, ".harness/.opencode"),
    AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_URL: `http://127.0.0.1:${state.ports.contextEngine}/runtime-invocation-provenance`,
  };
  const env = buildHeadroomEnvironment(baseEnv);
  const invocation = buildHeadroomWrapInvocation(["serve", "--hostname", "127.0.0.1", "--port", String(state.ports.opencode)], String(state.ports.headroom), baseEnv, state.headroom.python);
  const started = runner.start(invocation.command, invocation.args, { cwd: state.consumers.A, env, label });
  const auth = basicAuthHeaders(state.opencodeAuth.username, state.opencodeAuth.password);
  await waitFor(async () => {
    try {
      const health = await requestJson(`http://127.0.0.1:${state.ports.opencode}/global/health`, { headers: auth, timeoutMs: 2_000, allowStatuses: [200] });
      return health.body?.healthy === true ? health.body : null;
    } catch { return null; }
  }, { timeoutMs: 2 * 60_000, intervalMs: 500, label: "opencode-health" });
  const listeningPid = resolveListeningPid(state.ports.opencode) || started.child.pid;
  return { ...started, baseUrl: `http://127.0.0.1:${state.ports.opencode}`, authHeaders: auth, listeningPid, invocation };
}

function resolveListeningPid(port) {
  try {
    if (process.platform === "win32") {
      const out = runner.run("powershell.exe", ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess)`], { label: "opencode-listening-pid", allowExitCodes: [0, 1] }).stdout.trim();
      return /^\d+$/u.test(out) ? Number(out) : null;
    }
    const out = runner.run("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-t"], { label: "opencode-listening-pid", allowExitCodes: [0, 1, 127] }).stdout.trim().split(/\r?\n/u)[0];
    return /^\d+$/u.test(out) ? Number(out) : null;
  } catch { return null; }
}

async function r6() {
  state.opencode = await startQualifiedOpenCode("r6-opencode-host");
  const { baseUrl, authHeaders } = state.opencode;
  const pathInfo = await requestJson(`${baseUrl}/path`, { headers: authHeaders, allowStatuses: [200] });
  const pathText = JSON.stringify(pathInfo.body);
  if (!pathText.toLowerCase().includes(state.consumers.A.toLowerCase().replaceAll("\\", "\\\\")) && !pathText.toLowerCase().includes(state.consumers.A.toLowerCase().replaceAll("\\", "/"))) {
    // Fall back to project current identity; OpenCode versions can serialize path fields differently.
    const project = await requestJson(`${baseUrl}/project/current`, { headers: authHeaders, allowStatuses: [200] });
    if (!JSON.stringify(project.body).toLowerCase().includes(state.consumers.A.toLowerCase().replaceAll("\\", "/"))) hold("R-6", "RUNTIME", "qualified_opencode_project_root_mismatch", { path: pathInfo.body, project: project.body });
  }

  const identity = await requestJson(`http://127.0.0.1:${state.ports.contextEngine}/runtime-invocation-provenance/identity`, { allowStatuses: [200] });
  const id = identity.body;
  for (const key of ["expectedPluginSourceSha256", "configuredPluginSourceSha256", "bundledPluginSourceSha256"]) if (id?.[key] !== state.pluginSha) hold("R-6", "RUNTIME", "runtime_invocation_provenance_sha_authority_mismatch", { key, actual: id?.[key], expected: state.pluginSha, identity: id });

  const session = await requestJson(`${baseUrl}/session`, { method: "POST", headers: authHeaders, body: { title: "Agentic Harness R-6D history probe" }, allowStatuses: [200, 201] });
  const sessionId = session.body?.id;
  if (!sessionId) hold("R-6", "RUNTIME", "r6d_session_id_missing", { session: session.body });
  const probeText = "Agentic Harness qualification history probe. No Runtime invocation.";
  const sent = await requestJson(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message`, { method: "POST", headers: authHeaders, body: { noReply: true, parts: [{ type: "text", text: probeText }] }, allowStatuses: [200, 201] });
  const userMessageId = sent.body?.info?.id;
  const history = await requestJson(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message`, { headers: authHeaders, allowStatuses: [200] });
  const messages = Array.isArray(history.body) ? history.body : [];
  const matching = messages.find((message) => message?.info?.id === userMessageId);
  if (!matching || matching.info?.role !== "user" || !matching.parts?.some((part) => part?.type === "text" && part?.text === probeText)) hold("R-6", "RUNTIME", "r6d_history_persistence_failed", { userMessageId, messages });
  const assistantCount = messages.filter((message) => message?.info?.role === "assistant").length;
  const probeTools = toolNames(messages);
  const continuationCount = Number(sqlScalar(`SELECT count(*) FROM agent_continuations WHERE opencode_session_id='${sqlQuote(sessionId)}';`));
  if (assistantCount !== 0 || probeTools.length !== 0 || continuationCount !== 0) hold("R-6", "RUNTIME", "r6d_no_reply_contract_failed", { assistantCount, probeTools, continuationCount });
  await requestJson(`${baseUrl}/session/${encodeURIComponent(sessionId)}`, { method: "DELETE", headers: authHeaders, allowStatuses: [200, 204] });

  return { baseUrl, pid: state.opencode.listeningPid, config: state.effectiveConfigPath, pluginSha: state.pluginSha, provenanceIdentity: id, historyProbe: { sessionId, userMessageId, assistantCount, toolCount: probeTools.length, runtimeRunCount: continuationCount } };
}

function sqlQuote(value) { return String(value).replaceAll("'", "''"); }

async function createOpenCodeSession(title) {
  const response = await requestJson(`${state.opencode.baseUrl}/session`, { method: "POST", headers: state.opencode.authHeaders, body: { title }, allowStatuses: [200, 201] });
  if (!response.body?.id) throw new Error("qualification_opencode_session_id_missing");
  return response.body.id;
}

async function sendWorkload(sessionId, text) {
  await requestJson(`${state.opencode.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
    method: "POST",
    headers: state.opencode.authHeaders,
    body: { parts: [{ type: "text", text }] },
    allowStatuses: [204],
  });
  const user = await waitFor(async () => {
    const history = await openCodeHistory(sessionId);
    return history.find((message) => message?.info?.role === "user" && message.parts?.some((part) => part?.type === "text" && part?.text === text)) ?? null;
  }, { timeoutMs: 30_000, label: "opencode-user-message-materialization" });
  return user.info.id;
}

async function openCodeHistory(sessionId) {
  const response = await requestJson(`${state.opencode.baseUrl}/session/${encodeURIComponent(sessionId)}/message`, { headers: state.opencode.authHeaders, allowStatuses: [200] });
  return Array.isArray(response.body) ? response.body : [];
}


async function openCodeSessionStatus(sessionId) {
  const response = await requestJson(`${state.opencode.baseUrl}/session/status`, {
    headers: state.opencode.authHeaders,
    allowStatuses: [200],
  });
  return String(response.body?.[sessionId]?.type ?? "idle");
}

function runtimeWorkerEnvironment() {
  const workerId = composeCommand(["ps", "-q", "agent-runtime-worker"], { label: "continuation-worker-id" }).stdout.trim();
  if (!workerId) throw new Error("qualification_continuation_worker_id_missing");
  const inspect = JSON.parse(runner.run("docker", ["inspect", workerId], { label: "continuation-worker-inspect" }).stdout)[0];
  const values = {};
  for (const entry of inspect?.Config?.Env ?? []) {
    const index = String(entry).indexOf("=");
    if (index <= 0) continue;
    values[String(entry).slice(0, index)] = String(entry).slice(index + 1);
  }
  return values;
}

function continuationCompletionTimeoutMs() {
  const environment = runtimeWorkerEnvironment();
  const raw = environment.AGENT_HARNESS_OPENCODE_CONTINUATION_COMPLETION_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_CONTINUATION_COMPLETION_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    hold("R-8", "QUALIFICATION PROCEDURE", "continuation_completion_timeout_environment_invalid", { raw });
  }
  return value;
}

function assistantContinuationState(history, messageId) {
  const children = history
    .filter((message) => message?.info?.role === "assistant" && message?.info?.parentID === messageId)
    .sort((left, right) => Number(left?.info?.time?.created ?? 0) - Number(right?.info?.time?.created ?? 0));
  if (children.length === 0) return { state: "missing", messageId: null, count: 0, error: null };
  const latest = children.at(-1);
  const error = latest?.info?.error ?? null;
  const completed = Boolean(latest?.info?.time?.completed) || Boolean(latest?.info?.finish);
  return {
    state: error ? "failed" : completed ? "completed" : "pending",
    messageId: latest?.info?.id ?? null,
    count: children.length,
    error,
  };
}

async function continuationObservation(runId, sessionId) {
  const rows = sqlRows(`SELECT d.delivery_id,d.effect_key,d.opencode_message_id,d.prompt_text,d.status,coalesce(d.accepted_at,''),coalesce(d.observed_at,''),d.generation::text,d.attempts::text,coalesce(d.dispatch_started_at,''),coalesce(d.next_attempt_at,''),coalesce(d.last_error,''),coalesce(d.updated_at,''),coalesce(d.created_at,''),coalesce(d.completed_at,''),c.status,coalesce(c.current_delivery_id,'') FROM agent_continuation_deliveries d JOIN agent_continuations c ON c.continuation_id=d.continuation_id WHERE d.run_id='${sqlQuote(runId)}' ORDER BY d.generation DESC LIMIT 1;`);
  if (!rows.length) return { runId, sessionId, delivery: null, continuation: null, sessionStatus: null, wakeCount: 0, assistant: { state: "missing", messageId: null, count: 0, error: null } };
  const [deliveryId, effectKey, messageId, promptText, status, acceptedAt, observedAt, generation, attempts, dispatchStartedAt, nextAttemptAt, lastError, updatedAt, createdAt, completedAt, continuationStatus, currentDeliveryId] = rows[0];
  const history = await openCodeHistory(sessionId);
  const exactWakeMessages = history.filter((message) => message?.info?.role === "user" && message?.info?.id === messageId && message?.parts?.some((part) => part?.type === "text" && part?.text === promptText));
  const sameIdMessages = history.filter((message) => message?.info?.id === messageId);
  const sessionStatus = await openCodeSessionStatus(sessionId).catch((error) => `unavailable:${String(error?.code ?? error?.message ?? error).slice(0, 120)}`);
  return {
    runId,
    sessionId,
    delivery: {
      deliveryId,
      effectKey,
      messageId,
      promptText,
      status,
      acceptedAt: acceptedAt || null,
      observedAt: observedAt || null,
      generation: Number(generation),
      attempts: Number(attempts),
      dispatchStartedAt: dispatchStartedAt || null,
      nextAttemptAt: nextAttemptAt || null,
      lastError: lastError || null,
      updatedAt: updatedAt || null,
      createdAt: createdAt || null,
      completedAt: completedAt || null,
    },
    continuation: { status: continuationStatus, currentDeliveryId: currentDeliveryId || null },
    sessionStatus,
    wakeCount: exactWakeMessages.length,
    sameMessageIdCount: sameIdMessages.length,
    assistant: assistantContinuationState(history, messageId),
  };
}

function toolNames(history) {
  const names = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const maybe = value.tool || value.toolName || value.name;
    if ((value.type === "tool" || value.type === "tool-invocation" || value.type === "tool_call") && typeof maybe === "string") names.push(maybe);
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(history);
  return [...new Set(names)];
}

function assistantTexts(history) {
  const values = [];
  for (const message of history) {
    if (message?.info?.role !== "assistant") continue;
    for (const part of message?.parts ?? []) {
      if (part?.type === "text" && typeof part?.text === "string" && part.text.trim()) values.push(part.text.trim());
    }
  }
  return values;
}

function worktreeFingerprint() {
  const status = runner.run("git", ["-C", state.consumers.A, "status", "--porcelain=v1", "--untracked-files=all"], { label: "consumer-worktree-status" }).stdout;
  const diff = runner.run("git", ["-C", state.consumers.A, "diff", "--no-ext-diff", "--binary", "HEAD", "--"], { label: "consumer-worktree-diff" }).stdout;
  return `sha256:${createHash("sha256").update(status).update("\0").update(diff).digest("hex")}`;
}

async function waitForRunId(sessionId, {
  timeoutMs = 90_000,
  gate = "R-7",
  baselineWorktree = worktreeFingerprint(),
  request = null,
} = {}) {
  const direct = new Set(["write", "edit", "apply_patch", "bash", "task"]);
  try {
    return await waitFor(async () => {
      const continuationRunId = sqlScalar(`SELECT run_id FROM agent_continuations WHERE opencode_session_id='${sqlQuote(sessionId)}' ORDER BY created_at DESC LIMIT 1;`);
      if (continuationRunId) return continuationRunId;

      if (request) {
        const runs = sqlRows(`SELECT run_id,status,created_at FROM agent_runs WHERE request='${sqlQuote(request)}' ORDER BY created_at DESC LIMIT 2;`);
        if (runs.length > 1) hold(gate, "RUNTIME", "multiple_runtime_runs_for_single_qualification_request", { sessionId, request, runs });
        if (runs.length === 1) return runs[0][0];
      }

      const currentWorktree = worktreeFingerprint();
      if (currentWorktree !== baselineWorktree) hold(gate, "RUNTIME", "persistent_main_orchestrator_mutated_consumer_before_run_id", { sessionId, baselineWorktree, currentWorktree });
      const history = await openCodeHistory(sessionId);
      const tools = toolNames(history);
      const bypass = tools.find((name) => direct.has(name) || name.startsWith("serena_"));
      if (bypass) hold(gate, "RUNTIME", "main_orchestrator_routing_violation", { bypass, tools, sessionId });
      return null;
    }, { timeoutMs, intervalMs: 750, label: `${gate}-agent-start-run-id` });
  } catch (error) {
    if (!String(error?.message ?? error).startsWith("qualification_wait_timeout:")) throw error;

    const history = await openCodeHistory(sessionId).catch(() => []);
    const tools = toolNames(history);
    const currentWorktree = worktreeFingerprint();
    const recentRuns = request
      ? sqlRows(`SELECT run_id,status,created_at FROM agent_runs WHERE request='${sqlQuote(request)}' ORDER BY created_at DESC LIMIT 5;`)
      : [];
    const continuations = sqlRows(`SELECT run_id,status,created_at FROM agent_continuations WHERE opencode_session_id='${sqlQuote(sessionId)}' ORDER BY created_at DESC LIMIT 5;`);
    const logs = composeCommand(["logs", "--no-color", "context-engine"], { label: `${gate.toLowerCase()}-run-id-timeout-context-engine-logs` }).stdout;
    const provenanceLogHint = logs.includes("mcp.invocation_provenance_registered")
      && logs.includes(sessionId)
      && logs.includes("agent_start");

    if (currentWorktree !== baselineWorktree) {
      hold(gate, "RUNTIME", "persistent_main_orchestrator_mutated_consumer_before_run_id", {
        sessionId, baselineWorktree, currentWorktree, tools,
      });
    }

    const recentAssistantTexts = assistantTexts(history).slice(-5);
    const agentStartAttempted = tools.some((name) => name === "agent_start" || name.endsWith("_agent_start"));
    const runtimeValidationText = recentAssistantTexts.find((text) => /schema_validation_failed|additional property not allowed|executionPlan\./i.test(text)) ?? null;
    const message = runtimeValidationText && agentStartAttempted
      ? "r7_agent_start_rejected_by_runtime_validation"
      : provenanceLogHint
        ? "r7_agent_start_provenance_log_seen_but_run_not_materialized"
        : agentStartAttempted
          ? "r7_agent_start_attempted_but_no_run_materialized"
          : "r7_main_orchestrator_failed_to_enter_runtime";

    hold(
      gate,
      "RUNTIME",
      message,
      {
        sessionId,
        request,
        tools,
        assistantTexts: recentAssistantTexts,
        recentRuns,
        continuations,
        provenanceLogHint,
        agentStartAttempted,
        runtimeValidationText,
      },
    );
  }
}

async function requireDurableContinuation(runId, sessionId, { gate = "R-7", timeoutMs = 30_000 } = {}) {
  try {
    return await waitFor(() => {
      const rows = sqlRows(`SELECT run_id,opencode_session_id,status,created_at FROM agent_continuations WHERE run_id='${sqlQuote(runId)}' LIMIT 1;`);
      if (!rows.length) return null;
      const [observedRunId, observedSessionId, status, createdAt] = rows[0];
      return { runId: observedRunId, sessionId: observedSessionId, status, createdAt };
    }, { timeoutMs, intervalMs: 500, label: `${gate}-durable-continuation-binding` });
  } catch (error) {
    if (!String(error?.message ?? error).startsWith("qualification_wait_timeout:")) throw error;
    const history = await openCodeHistory(sessionId).catch(() => []);
    hold(gate, "RUNTIME", "r7_run_created_without_durable_continuation", {
      runId,
      sessionId,
      tools: toolNames(history),
      assistantTexts: assistantTexts(history).slice(-5),
      expectedFlow: "runtime-continuation -> agent_start({ continuation }) -> next=session-resume-event",
    });
  }
}

function runtimeRunObservation(runId) {
  const quotedRunId = sqlQuote(runId);
  const raw = sqlScalar(`
WITH latest_heartbeats AS (
  SELECT DISTINCT ON (task_id)
    task_id,
    created_at,
    COALESCE(payload_json::jsonb->>'elapsedMs','') AS elapsed_ms,
    COALESCE(payload_json::jsonb->>'idleMs','') AS idle_ms,
    COALESCE(payload_json::jsonb->>'stdoutBytes','') AS stdout_bytes,
    COALESCE(payload_json::jsonb->>'stderrBytes','') AS stderr_bytes,
    COALESCE(payload_json::jsonb->>'dispatchGeneration','') AS dispatch_generation,
    COALESCE(payload_json::jsonb->>'fencingToken','') AS fencing_token
  FROM agent_events
  WHERE run_id='${quotedRunId}' AND event_type='executor.heartbeat' AND task_id IS NOT NULL
  ORDER BY task_id, created_at DESC
),
latest_task_events AS (
  SELECT DISTINCT ON (task_id)
    task_id,
    event_type,
    created_at,
    COALESCE(payload_json::jsonb->>'code','') AS code,
    COALESCE(payload_json::jsonb->>'status','') AS status,
    COALESCE(payload_json::jsonb->>'message','') AS message
  FROM agent_events
  WHERE run_id='${quotedRunId}' AND task_id IS NOT NULL AND event_type<>'executor.heartbeat'
  ORDER BY task_id, created_at DESC
)
SELECT json_build_object(
  'run', (
    SELECT json_build_object(
      'status', status,
      'stateVersion', state_version,
      'startedAt', started_at,
      'completedAt', completed_at,
      'taskTimeoutMs', task_timeout_ms,
      'maxParallel', max_parallel,
      'errorCode', error_code,
      'errorMessage', error_message,
      'planJson', plan_json
    )
    FROM agent_runs
    WHERE run_id='${quotedRunId}'
  ),
  'tasks', COALESCE((
    SELECT json_agg(json_build_object(
      'taskId', t.task_id,
      'agentId', t.agent_id,
      'role', t.role,
      'status', t.status,
      'attempt', t.attempt,
      'maxAttempts', t.max_attempts,
      'startedAt', t.started_at,
      'completedAt', t.completed_at,
      'modelId', t.model_id,
      'queuedAt', t.queued_at,
      'retryNotBefore', t.retry_not_before,
      'leaseOwner', t.lease_owner,
      'leaseExpiresAt', t.lease_expires_at,
      'dispatchGeneration', t.dispatch_generation,
      'fencingToken', t.fencing_token,
      'stateVersion', t.state_version,
      'heartbeat', CASE WHEN h.task_id IS NULL THEN NULL ELSE json_build_object(
        'at', h.created_at,
        'elapsedMs', NULLIF(h.elapsed_ms,'')::bigint,
        'idleMs', NULLIF(h.idle_ms,'')::bigint,
        'stdoutBytes', NULLIF(h.stdout_bytes,'')::bigint,
        'stderrBytes', NULLIF(h.stderr_bytes,'')::bigint,
        'dispatchGeneration', NULLIF(h.dispatch_generation,'')::bigint,
        'fencingToken', NULLIF(h.fencing_token,'')::bigint
      ) END,
      'latestEvent', CASE WHEN e.task_id IS NULL THEN NULL ELSE json_build_object(
        'type', e.event_type,
        'at', e.created_at,
        'code', NULLIF(e.code,''),
        'status', NULLIF(e.status,''),
        'message', NULLIF(e.message,'')
      ) END
    ) ORDER BY t.task_id)
    FROM agent_tasks t
    LEFT JOIN latest_heartbeats h ON h.task_id=t.task_id
    LEFT JOIN latest_task_events e ON e.task_id=t.task_id
    WHERE t.run_id='${quotedRunId}'
  ), '[]'::json),
  'worker', (
    SELECT json_build_object(
      'workerId', worker_id,
      'heartbeatAt', heartbeat_at,
      'hostname', hostname,
      'pid', pid,
      'concurrency', concurrency
    )
    FROM agent_runtime_workers
    WHERE stopped_at IS NULL
    ORDER BY heartbeat_at DESC
    LIMIT 1
  ),
  'recentEvents', COALESCE((
    SELECT json_agg(event_json ORDER BY created_at)
    FROM (
      SELECT json_build_object(
        'type', event_type,
        'taskId', task_id,
        'at', created_at,
        'code', NULLIF(COALESCE(payload_json::jsonb->>'code',''),''),
        'status', NULLIF(COALESCE(payload_json::jsonb->>'status',''),''),
        'message', NULLIF(COALESCE(payload_json::jsonb->>'message',''),'')
      ) AS event_json, created_at
      FROM agent_events
      WHERE run_id='${quotedRunId}' AND event_type<>'executor.heartbeat'
      ORDER BY created_at DESC
      LIMIT 16
    ) recent
  ), '[]'::json),
  'outbox', COALESCE((
    SELECT json_agg(json_build_object(
      'kind', message_kind,
      'taskId', task_id,
      'dispatchGeneration', dispatch_generation,
      'publishedAt', published_at,
      'publishCount', publish_count,
      'lastError', last_error,
      'terminalAt', terminal_at,
      'terminalReason', terminal_reason
    ) ORDER BY created_at DESC)
    FROM (
      SELECT *
      FROM agent_runtime_outbox
      WHERE run_id='${quotedRunId}'
      ORDER BY created_at DESC
      LIMIT 16
    ) o
  ), '[]'::json),
  'pendingExecutionResults', COALESCE((
    SELECT json_agg(json_build_object(
      'resultId', result_id,
      'taskId', task_id,
      'attempt', attempt,
      'dispatchGeneration', dispatch_generation,
      'createdAt', created_at
    ) ORDER BY created_at DESC)
    FROM agent_execution_results
    WHERE run_id='${quotedRunId}' AND consumed_at IS NULL
  ), '[]'::json)
)::text;
  `);
  if (!raw) throw new Error(`qualification_runtime_observation_missing:${runId}`);
  const observation = JSON.parse(raw);
  if (!observation.run) throw new Error(`qualification_runtime_run_missing:${runId}`);

  let plan = {};
  try { plan = JSON.parse(String(observation.run.planJson ?? "{}")); }
  catch { plan = {}; }
  const taskPlans = new Map((Array.isArray(plan.tasks) ? plan.tasks : []).map((task) => [task.taskId, task]));
  const hardTimeoutMs = Number(observation.run.taskTimeoutMs) || 3_600_000;
  observation.tasks = (Array.isArray(observation.tasks) ? observation.tasks : []).map((task) => {
    const taskPlan = taskPlans.get(task.taskId) ?? {};
    return {
      ...task,
      stage: taskPlan.stage ?? null,
      livenessPolicy: resolveExecutionLivenessPolicy({
        task: taskPlan,
        attempt: Number(task.attempt) || 1,
        hardTimeoutMs,
      }),
    };
  });
  delete observation.run.planJson;
  return observation;
}

function runtimeObservationEvidence(observation) {
  return {
    run: observation?.run ?? null,
    tasks: observation?.tasks ?? [],
    worker: observation?.worker ?? null,
    recentEvents: observation?.recentEvents ?? [],
    outbox: observation?.outbox ?? [],
    pendingExecutionResults: observation?.pendingExecutionResults ?? [],
  };
}

async function waitForTerminalRun(runId, { gate } = {}) {
  const startedAtMs = Date.now();
  const emergencyCeilingMs = 6 * 60 * 60_000;
  let inactiveSinceMs = null;
  let nextProgressLogAt = 0;
  let lastObservation = null;

  while (true) {
    const nowMs = Date.now();
    const observation = runtimeRunObservation(runId);
    lastObservation = observation;
    const assessment = evaluateRuntimeObservation(observation, { nowMs, inactiveSinceMs });
    inactiveSinceMs = assessment.inactiveSinceMs;

    if (assessment.terminal) {
      return {
        ...assessment.terminal,
        observation: runtimeObservationEvidence(observation),
      };
    }

    if (assessment.violation) {
      const gateToken = String(gate ?? "runtime").toLowerCase().replaceAll("-", "");
      hold(gate, "RUNTIME", `${gateToken}_${assessment.violation.message}`, {
        runId,
        watchdog: assessment.violation.evidence,
        observation: runtimeObservationEvidence(observation),
      });
    }

    if (nowMs >= nextProgressLogAt) {
      console.error(`[qualification][${gate}] ${runId} ${formatRuntimeProgress(observation, nowMs)}`);
      nextProgressLogAt = nowMs + 60_000;
    }

    if (nowMs - startedAtMs > emergencyCeilingMs) {
      const gateToken = String(gate ?? "runtime").toLowerCase().replaceAll("-", "");
      hold(gate, "QUALIFICATION PROCEDURE", `${gateToken}_progress_aware_watch_safety_ceiling`, {
        runId,
        elapsedMs: nowMs - startedAtMs,
        emergencyCeilingMs,
        observation: runtimeObservationEvidence(lastObservation),
      });
    }

    await sleep(5_000);
  }
}

async function r7() {
  const fixture = assertFixtureComplete(state.consumers.A);
  for (const [path, sha] of Object.entries(state.fixtureA)) if (fixture.identity[path] !== sha) hold("R-7", "QUALIFICATION PROCEDURE", "synthetic_fixture_drift", { path, expected: sha, actual: fixture.identity[path] });
  const sessionId = await createOpenCodeSession("Agentic Harness R-7 consumer workload");
  const workload = "Implemente integralmente os requisitos definidos em docs/specs/example/PRD.md.\n\nUse docs/adr/0001-example.md como restrição arquitetural.\n\nMantenha o escopo limitado ao projeto consumidor atual e execute a validação especificada no PRD antes de concluir.";
  const baselineWorktree = worktreeFingerprint();
  const userMessageId = await sendWorkload(sessionId, workload);
  const runId = await waitForRunId(sessionId, { gate: "R-7", baselineWorktree, request: workload });
  const continuation = await requireDurableContinuation(runId, sessionId, { gate: "R-7" });
  if (continuation.sessionId !== sessionId) hold("R-7", "RUNTIME", "r7_continuation_session_identity_mismatch", { runId, sessionId, continuation });
  const provenance = {
    authority: "context-engine-agent-start-fail-closed",
    source: "opencode-plugin-sidechannel",
    sessionId,
    userMessageId,
    runId,
  };
  const terminal = await waitForTerminalRun(runId, { gate: "R-7" });
  if (terminal.status !== "closed") hold("R-7", "RUNTIME", "r7_runtime_not_closed", { runId, terminal });
  mustRun("R-7", "RUNTIME", "npm", ["--prefix", state.consumers.A, "test"], { label: "r7-consumer-validation" });
  const replay = mustRun("R-7", "RUNTIME", process.execPath, [resolve(state.consumers.A, ".harness/scripts/internal/agent-runtime-replay.mjs"), "--capsule", resolve(state.consumers.A, ".runtime", "agents", "runs", runId, "replay-capsule.json"), "--repository", resolve(state.consumers.A, ".harness"), "--json"], { cwd: state.consumers.A, env: state.consumerEnv, label: "r7-replay", timeoutMs: 2 * 60_000 });
  const replayJson = parseJsonOutput(replay.stdout);
  if (replayJson.ok !== true) hold("R-7", "RUNTIME", "r7_replay_verification_failed", { replay: replayJson });
  state.r7 = { sessionId, userMessageId, runId, continuation, provenance, terminal, workload };
  return state.r7;
}

async function waitForContinuationObserved(runId, sessionId, { gate }) {
  const completionTimeoutMs = continuationCompletionTimeoutMs();
  const safetyCeilingMs = Math.max(30 * 60_000, completionTimeoutMs * 2 + 5 * 60_000);
  const startedAtMs = Date.now();
  let lastProgressAtMs = 0;
  let observation = null;

  while (true) {
    observation = await continuationObservation(runId, sessionId);
    const nowMs = Date.now();
    const decision = evaluateContinuationObservation(observation, {
      nowMs,
      watchStartedAtMs: startedAtMs,
      completionTimeoutMs,
      acceptanceStallTimeoutMs: completionTimeoutMs,
    });
    if (decision.violation) {
      hold(gate, "RUNTIME", decision.violation.message, {
        runId,
        sessionId,
        completionTimeoutMs,
        observation: decision.violation.evidence ?? observation,
      });
    }
    if (decision.terminal) return { observation, completionTimeoutMs };
    if (nowMs - startedAtMs >= safetyCeilingMs) {
      hold(gate, "QUALIFICATION PROCEDURE", `${gate.toLowerCase()}_continuation_progress_aware_watch_safety_ceiling`, {
        runId,
        sessionId,
        completionTimeoutMs,
        safetyCeilingMs,
        observation,
      });
    }
    if (nowMs - lastProgressAtMs >= 30_000) {
      console.error(`[qualification][${gate}] ${runId} ${formatContinuationProgress(observation, { nowMs })}`);
      lastProgressAtMs = nowMs;
    }
    await sleep(1_000);
  }
}

async function r8() {
  const { runId, sessionId } = state.r7;
  const { observation, completionTimeoutMs } = await waitForContinuationObserved(runId, sessionId, { gate: "R-8" });
  const delivery = observation.delivery;
  if (!delivery.acceptedAt || !delivery.observedAt) hold("R-8", "RUNTIME", "continuation_acceptance_or_observation_missing", { observation });
  if (Date.parse(delivery.observedAt) < Date.parse(delivery.acceptedAt)) hold("R-8", "RUNTIME", "continuation_observed_before_accepted", { observation });
  if (observation.continuation?.currentDeliveryId && observation.continuation.currentDeliveryId !== delivery.deliveryId) {
    hold("R-8", "RUNTIME", "continuation_current_delivery_identity_mismatch", { observation });
  }
  const continuation = sqlRows(`SELECT opencode_session_id,status,generation::text FROM agent_continuations WHERE run_id='${sqlQuote(runId)}';`)[0];
  if (!continuation || continuation[0] !== sessionId) hold("R-8", "RUNTIME", "continuation_session_identity_mismatch", { continuation, sessionId });
  if (observation.sameMessageIdCount !== 1 || observation.wakeCount !== 1) {
    hold("R-8", "RUNTIME", "continuation_wake_materialization_count_invalid", { observation });
  }
  if (observation.assistant?.state !== "completed" || !observation.assistant?.messageId || observation.assistant?.count !== 1) {
    hold("R-8", "RUNTIME", "continuation_assistant_terminal_observation_invalid", { observation });
  }
  const wakeEvents = Number(sqlScalar(`SELECT count(*) FROM agent_events WHERE run_id='${sqlQuote(runId)}' AND event_type='continuation.wake_materialized';`));
  const deliveredEvents = Number(sqlScalar(`SELECT count(*) FROM agent_events WHERE run_id='${sqlQuote(runId)}' AND event_type='continuation.delivered';`));
  if (wakeEvents !== 1 || deliveredEvents !== 1) hold("R-8", "RUNTIME", "continuation_event_count_invalid", { wakeEvents, deliveredEvents, observation });
  return { runId, sessionId, completionTimeoutMs, delivery, assistant: observation.assistant, wakeEvents, deliveredEvents };
}

async function r9() {
  const sessionId = await createOpenCodeSession("Agentic Harness R-9 process-loss workload");
  const workload = "No projeto consumidor atual, adicione uma função exportada formatInitials(name) em src/format-name.mjs. Ela deve usar o mesmo String(name).trim(), retornar as iniciais maiúsculas das palavras não vazias e retornar Anonymous para entrada vazia. Adicione testes com node:test para nome simples, nome composto e entrada vazia. Não adicione dependências e execute npm test.";
  const baselineWorktree = worktreeFingerprint();
  const userMessageId = await sendWorkload(sessionId, workload);
  const runId = await waitForRunId(sessionId, { gate: "R-9", baselineWorktree });

  const target = await waitFor(() => {
    const rows = sqlRows(`SELECT e.task_id,e.payload_json,c.checkpoint_id,c.attempt::text,c.dispatch_generation::text,c.fencing_token::text FROM agent_events e JOIN agent_task_checkpoints c ON c.task_id=e.task_id AND c.run_id=e.run_id AND c.reusable=true WHERE e.run_id='${sqlQuote(runId)}' AND e.event_type='executor.spawned' ORDER BY e.created_at DESC LIMIT 1;`);
    if (!rows.length) return null;
    return { taskId: rows[0][0], executorPayload: safeJson(rows[0][1]), checkpointId: rows[0][2], attempt: Number(rows[0][3]), dispatchGeneration: Number(rows[0][4]), fencingToken: Number(rows[0][5]) };
  }, { timeoutMs: 20 * 60_000, intervalMs: 1_000, label: "r9-repair-checkpoint-and-executor" });

  const workerId = composeCommand(["ps", "-q", "agent-runtime-worker"], { label: "r9-worker-id" }).stdout.trim();
  const before = JSON.parse(runner.run("docker", ["inspect", workerId], { label: "r9-worker-before" }).stdout)[0];
  runner.run("docker", ["kill", workerId], { label: "r9-worker-kill" });
  const after = await waitFor(() => {
    const inspect = JSON.parse(runner.run("docker", ["inspect", workerId], { label: "r9-worker-after" }).stdout)[0];
    return inspect.State?.Running === true && Number(inspect.RestartCount ?? 0) > Number(before.RestartCount ?? 0) && inspect.State?.Pid !== before.State?.Pid ? inspect : null;
  }, { timeoutMs: 2 * 60_000, intervalMs: 1_000, label: "r9-worker-restart" });

  const terminal = await waitForTerminalRun(runId, { gate: "R-9" });
  if (terminal.status !== "closed") hold("R-9", "RUNTIME", "r9_run_not_closed_after_worker_loss", { runId, terminal });
  const events = sqlRows(`SELECT event_type,payload_json,coalesce(task_id,'') FROM agent_events WHERE run_id='${sqlQuote(runId)}' AND event_type IN ('repair.resume_checkpoint_loaded','retry.full_attempt_avoided','repair.started','repair.completed') ORDER BY created_at;`).map(([type, payload, taskId]) => ({ type, taskId, payload: safeJson(payload) }));
  const resume = events.find((event) => event.type === "repair.resume_checkpoint_loaded" && event.taskId === target.taskId);
  if (!resume || resume.payload?.skippedFullAgentInvocation !== true) hold("R-9", "RUNTIME", "r9_repair_resume_not_proven", { target, events });
  if (!(Number(resume.payload?.dispatchGeneration) > target.dispatchGeneration) || !(Number(resume.payload?.fencingToken) > target.fencingToken)) hold("R-9", "RUNTIME", "r9_generation_fencing_not_advanced", { target, resume });
  mustRun("R-9", "RUNTIME", "npm", ["--prefix", state.consumers.A, "test"], { label: "r9-consumer-validation" });
  state.r9 = { sessionId, userMessageId, runId, target, workerBefore: { pid: before.State?.Pid, restartCount: before.RestartCount }, workerAfter: { pid: after.State?.Pid, restartCount: after.RestartCount }, events };
  return state.r9;
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return {}; }
}

async function r10() {
  const faults = [];
  for (const [service, recovery] of [
    ["redis", async () => composeCommand(["exec", "-T", "redis", "redis-cli", "ping"], { label: "r10-redis-recovery" })],
    ["context-embeddings", async () => requestJson(`http://127.0.0.1:${state.ports.embeddings}/embed`, { method: "POST", body: { inputs: "recovery" }, allowStatuses: [200], timeoutMs: 10_000 })],
    ["rabbitmq", async () => requestJson(`http://127.0.0.1:${state.ports.rabbitmqManagement}/api/overview`, { headers: basicAuthHeaders("agent", "agent"), allowStatuses: [200], timeoutMs: 10_000 })],
    ["context-engine", async () => requestJson(`http://127.0.0.1:${state.ports.contextEngine}/healthz`, { allowStatuses: [200], timeoutMs: 10_000 })],
    ["agent-runtime-worker", async () => {
      const heartbeat = sqlScalar("SELECT heartbeat_at FROM agent_runtime_workers WHERE stopped_at IS NULL ORDER BY heartbeat_at DESC LIMIT 1;");
      if (!heartbeat) throw new Error("worker_heartbeat_missing_after_restart");
      return heartbeat;
    }],
  ]) {
    const runCountBefore = Number(sqlScalar("SELECT count(*) FROM agent_runs;"));
    composeCommand(["restart", service], { label: `r10-restart-${service}`, timeoutMs: 5 * 60_000 });
    await waitFor(async () => {
      try { return await recovery(); } catch { return null; }
    }, { timeoutMs: 5 * 60_000, intervalMs: 1_000, label: `r10-${service}-recovery` });
    const runCountAfter = Number(sqlScalar("SELECT count(*) FROM agent_runs;"));
    if (runCountAfter !== runCountBefore) hold("R-10", "RUNTIME", "fault_restart_created_semantic_run", { service, runCountBefore, runCountAfter });
    faults.push({ service, recovered: true, runCountBefore, runCountAfter });
  }

  const sessionId = await createOpenCodeSession("Agentic Harness R-10 continuation outage workload");
  const workload = "No projeto consumidor atual, adicione ao README uma seção curta 'Formatting helpers' descrevendo formatName e formatInitials sem alterar código ou dependências. Preserve os testes existentes e execute npm test.";
  const baselineWorktree = worktreeFingerprint();
  const userMessageId = await sendWorkload(sessionId, workload);
  const runId = await waitForRunId(sessionId, { gate: "R-10", baselineWorktree });
  const oldOpenCode = state.opencode;
  terminateProcessTree(oldOpenCode.child);
  await waitFor(() => isPortFree(state.ports.opencode), { timeoutMs: 60_000, intervalMs: 500, label: "r10-opencode-down" });
  const terminal = await waitForTerminalRun(runId, { gate: "R-10" });
  if (terminal.status !== "closed") hold("R-10", "RUNTIME", "r10_outage_run_not_closed", { terminal });
  const deferred = await waitFor(() => {
    const rows = sqlRows(`SELECT status,coalesce(last_error,''),delivery_id,attempts::text FROM agent_continuation_deliveries WHERE run_id='${sqlQuote(runId)}' ORDER BY generation DESC LIMIT 1;`);
    if (!rows.length) return null;
    const [status,lastError,deliveryId,attempts] = rows[0];
    if (status === "accepted" || status === "observed") hold("R-10", "QUALIFICATION PROCEDURE", "opencode_outage_fault_missed_delivery_window", { status, deliveryId });
    return Number(attempts) > 0 && lastError ? { status, lastError, deliveryId, attempts: Number(attempts) } : null;
  }, { timeoutMs: 3 * 60_000, intervalMs: 1_000, label: "r10-continuation-deferred" });
  state.opencode = await startQualifiedOpenCode("r10-opencode-restart");
  const recovered = await waitForContinuationObserved(runId, sessionId, { gate: "R-10" });
  const accepted = recovered.observation.delivery;
  mustRun("R-10", "RUNTIME", "npm", ["--prefix", state.consumers.A, "test"], { label: "r10-consumer-validation" });
  state.r10 = { faults, sessionId, userMessageId, runId, deferred, accepted };
  return state.r10;
}

async function cleanup() {
  const evidence = { opencode: false, headroom: false, stack: false, consumers: false, sourceEquality: null };
  if (state.opencode?.child) {
    terminateProcessTree(state.opencode.child);
    evidence.opencode = true;
  }
  if (state.headroom?.child) {
    terminateProcessTree(state.headroom.child);
    evidence.headroom = true;
  }
  if (state.dnsProject && state.dnsComposeYaml) {
    try { runner.run("docker", ["compose", "--project-name", state.dnsProject, "--file", "-", "down", "--volumes", "--remove-orphans"], { input: state.dnsComposeYaml, label: "cleanup-dns", allowExitCodes: [0, 1] }); } catch {}
  }
  if (state.freshTeiContainer) {
    try { runner.run("docker", ["rm", "-f", state.freshTeiContainer], { label: "cleanup-fresh-tei", allowExitCodes: [0, 1] }); } catch {}
  }
  if (state.consumers.A && existsSync(resolve(state.consumers.A, ".harness/bin/harness.mjs"))) {
    try {
      runner.run(process.execPath, [resolve(state.consumers.A, ".harness/bin/harness.mjs"), "down", "--volumes", "--remove-orphans"], { cwd: state.consumers.A, env: state.consumerEnv || buildConsumerEnv(), label: "cleanup-consumer-stack", allowExitCodes: [0, 1], timeoutMs: 10 * 60_000 });
      evidence.stack = true;
    } catch {}
  }
  for (const consumer of Object.values(state.consumers)) {
    if (consumer && existsSync(consumer)) rmSync(consumer, { recursive: true, force: true });
  }
  evidence.consumers = true;
  const finalHead = gitText(harnessRoot, ["rev-parse", "HEAD"]);
  const finalStatus = gitText(harnessRoot, ["status", "--short"]);
  let finalTree = null;
  try {
    const manifest = parseJsonOutput(runner.run(process.execPath, [resolve(harnessRoot, "scripts/internal/source-manifest.mjs")], { cwd: harnessRoot, label: "cleanup-source-manifest" }).stdout);
    finalTree = manifest.treeSha256;
  } catch {}
  report.identity.POST_CLEANUP_HEAD = finalHead;
  report.identity.POST_CLEANUP_TREE_SHA256 = finalTree;
  report.identity.FINAL_GIT_STATUS = finalStatus;
  evidence.sourceEquality = {
    headEqual: !report.identity.R0_HEAD || finalHead === report.identity.R0_HEAD,
    treeEqual: !report.identity.R0_TREE_SHA256 || finalTree === report.identity.R0_TREE_SHA256,
    clean: finalStatus === "",
  };
  if (!args.selfTest && (!evidence.sourceEquality.headEqual || !evidence.sourceEquality.treeEqual || !evidence.sourceEquality.clean)) hold("R-11", "SOURCE", "post_cleanup_source_identity_mismatch", evidence.sourceEquality);
  if (state.ports) {
    const ports = {};
    for (const [name, port] of Object.entries(state.ports)) ports[name] = await isPortFree(port);
    evidence.portsFree = ports;
  }
  return evidence;
}

async function selfTest() {
  const gate = report.beginGate("Q-ENTRY");
  const requiredFiles = [
    "scripts/qualification/standalone-v1.mjs",
    "scripts/qualification/lib/process.mjs",
    "scripts/qualification/lib/report.mjs",
    "scripts/qualification/lib/fixture.mjs",
    "scripts/qualification/lib/http.mjs",
    "scripts/qualification/lib/runtime-watchdog.mjs",
    "scripts/qualification/lib/util.mjs",
  ];
  for (const path of requiredFiles) if (!existsSync(resolve(harnessRoot, path))) throw new Error(`qualification_self_test_missing:${path}`);
  const packageScripts = JSON.parse(readFileSync(resolve(harnessRoot, "package.json"), "utf8")).scripts;
  if (Object.keys(packageScripts).length !== 10 || packageScripts["harness:qualify"] !== "node bin/harness.mjs qualify") throw new Error("qualification_public_surface_changed");
  const mainAgent = JSON.parse(readFileSync(resolve(harnessRoot, ".opencode/agents.generated.json"), "utf8"))["main-orchestrator"];
  if (mainAgent.permission?.bash !== "deny" || mainAgent.permission?.edit !== "deny") throw new Error("qualification_self_test_main_orchestrator_not_restricted");
  report.pass(gate, { selfTest: true, requiredFiles, publicScripts: Object.keys(packageScripts).length, mainOrchestratorShell: "deny" });
  for (const name of gateOrder.slice(1)) report.skip(name, "self-test mode");
}
