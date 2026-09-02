import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runProcess } from "./process.mjs";
import { exists, nowIso, sha256, sleep } from "./utils.mjs";

/**
 * Compute a deterministic ephemeral port for a runId.
 * Returns a value between 30000 and 39999 inclusive.
 */
export function computeEphemeralPort(runId) {
  // Use SHA-256 to get a deterministic numeric hash
  const hash = sha256(runId);
  // Take first 8 hex chars, convert to integer, mod 10000
  const numericHash = Number.parseInt(hash.slice(0, 8), 16);
  return (numericHash % 10000) + 30000;
}

/**
 * Build a deterministic Docker lifecycle scope for one task attempt domain.
 *
 * Docker validation must be isolated per task rather than per run because a
 * Dynamic DAG may execute multiple Docker-backed work items concurrently. A
 * run-scoped Compose project makes those tasks share containers, bind mounts,
 * ports and teardown, which creates service_conflict races.
 */
export function dockerLifecycleScopeId(runId, taskId = null) {
  const taskKey = taskId ? sha256(String(taskId)).slice(0, 12) : "run";
  return `${runId}--${taskKey}`;
}

/**
 * Compose project names are deliberately short and derived from the lifecycle
 * scope so Windows paths/container names do not grow with long task ids.
 */
export function dockerLifecycleProjectName(runId, taskId = null) {
  return `agentic-harness-agent-${sha256(dockerLifecycleScopeId(runId, taskId)).slice(0, 16)}`;
}

/**
 * Extract Docker version string from `docker info` stdout.
 */
function extractDockerVersion(stdout) {
  const match = stdout.match(/Server Version:\s*(\S+)/);
  return match ? match[1] : null;
}

/**
 * Extract Compose version string from `docker compose version` stdout.
 */
function extractComposeVersion(stdout) {
  const match = stdout.match(/v?(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/**
 * Build a deterministic port map for services that need host port exposure.
 */
function buildEphemeralPortMap(scopeId, services) {
  const portMap = {};
  // Service name to container port mapping
  const servicePorts = {
    postgres: { container: 5432, env: "AGENT_HARNESS_VALIDATION_POSTGRES_PORT" },
    rabbitmq: { container: 5672, env: "AGENT_HARNESS_VALIDATION_RABBITMQ_AMQP_PORT" },
    redis: { container: 6379, env: "AGENT_HARNESS_VALIDATION_REDIS_PORT" },
    "context-engine": { container: 8789, env: "AGENT_HARNESS_VALIDATION_CONTEXT_ENGINE_PORT" },
    "context-embeddings": { container: 80, env: "AGENT_HARNESS_VALIDATION_EMBEDDINGS_PORT" },
  };

  // Use runId hash as base for all ports with deterministic offsets
  const basePort = computeEphemeralPort(scopeId);

  for (const service of services) {
    if (servicePorts[service]) {
      // Deterministic: each service gets a distinct port from the same base
      const offset = Object.keys(servicePorts).indexOf(service);
      portMap[service] = ((basePort + offset - 30000) % 10000) + 30000;
    }
  }
  return portMap;
}

/**
 * Generate a Docker Compose override YAML for agent validation.
 * Extracted as testable function (REFACTOR target).
 */
export function generateComposeOverride({ runId, services, validationDir, ephemeralPorts, repositoryRoot }) {
  const normalizedRoot = resolve(repositoryRoot).replace(/\\/g, "/");
  const normalizedValidationDir = resolve(validationDir).replace(/\\/g, "/").replace(normalizedRoot + "/", "");

  const lines = [];
  lines.push(`# Auto-generated compose override for agent validation run ${runId}`);
  lines.push(`# Do not edit manually.`);
  lines.push("");
  lines.push("services:");
  lines.push("");

  for (const service of services) {
    lines.push(`  ${service}:`);
    lines.push(`    restart: "no"`);

    // Per-service overrides
    switch (service) {
      case "postgres":
        lines.push(`    ports: !override`);
        if (ephemeralPorts[service]) {
          lines.push(`      - "127.0.0.1:${ephemeralPorts[service]}:5432"`);
        }
        lines.push(`    environment:`);
        lines.push(`      AGENT_HARNESS_POSTGRES_HOST_PATH: "./${normalizedValidationDir}/postgres"`);
        lines.push(`    volumes:`);
        lines.push(`      - type: bind`);
        lines.push(`        source: "./${normalizedValidationDir}/postgres"`);
        lines.push(`        target: /var/lib/postgresql`);
        lines.push(`        bind:`);
        lines.push(`          create_host_path: true`);
        lines.push(`    mem_limit: 512m`);
        break;

      case "rabbitmq":
        lines.push(`    ports: !override`);
        if (ephemeralPorts[service]) {
          lines.push(`      - "127.0.0.1:${ephemeralPorts[service]}:5672"`);
        }
        lines.push(`    environment:`);
        lines.push(`      AGENT_HARNESS_RABBITMQ_HOST_PATH: "./${normalizedValidationDir}/rabbitmq"`);
        lines.push(`    volumes:`);
        lines.push(`      - type: bind`);
        lines.push(`        source: "./${normalizedValidationDir}/rabbitmq"`);
        lines.push(`        target: /var/lib/rabbitmq`);
        lines.push(`        bind:`);
        lines.push(`          create_host_path: true`);
        lines.push(`    mem_limit: 256m`);
        break;

      case "redis":
        lines.push(`    ports: !override`);
        if (ephemeralPorts[service]) lines.push(`      - "127.0.0.1:${ephemeralPorts[service]}:6379"`);
        lines.push(`    mem_limit: 512m`);
        break;

      case "context-engine":
        lines.push(`    ports: !override`);
        if (ephemeralPorts[service]) lines.push(`      - "127.0.0.1:${ephemeralPorts[service]}:8789"`);
        lines.push(`    mem_limit: 512m`);
        break;

      case "context-embeddings":
        lines.push(`    ports: !override`);
        if (ephemeralPorts[service]) lines.push(`      - "127.0.0.1:${ephemeralPorts[service]}:80"`);
        lines.push(`    mem_limit: 1024m`);
        break;

      case "agent-runtime-worker":
        lines.push(`    mem_limit: 512m`);
        break;

      default:
        lines.push(`    mem_limit: 256m`);
        break;
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Parse a Docker Compose duration string to milliseconds.
 * Supports: "Xs" (seconds), "Xm" (minutes), "Xh" (hours).
 * Returns 0 for undefined, null, or invalid input.
 */
export function parseDuration(durationStr) {
  if (!durationStr || typeof durationStr !== "string") return 0;
  let totalMs = 0;
  // Match patterns like "30s", "1m30s", "5m", "2h"
  const regex = /(\d+)(s|m|h)/g;
  let match;
  while ((match = regex.exec(durationStr)) !== null) {
    const value = Number.parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
      case "s": totalMs += value * 1000; break;
      case "m": totalMs += value * 60_000; break;
      case "h": totalMs += value * 3_600_000; break;
    }
  }
  return totalMs;
}

/**
 * Parse healthcheck configuration for a service from compose.yaml content.
 * Returns null if the service has no healthcheck defined.
 * Returns an object with normalized millisecond values.
 */
export function parseHealthcheckFromCompose(composeContent, serviceName) {
  if (!composeContent || !serviceName) return null;

  const lines = composeContent.split("\n");
  let inService = false;
  let inHealthcheck = false;
  const hcRaw = {};

  for (const line of lines) {
    // Detect service section header: "  serviceName:"
    if (line.match(new RegExp(`^  ${escapeRegex(serviceName)}:$`))) {
      inService = true;
      inHealthcheck = false;
      continue;
    }

    // If we were in a service and encounter another top-level service key (2-space indent), we're done
    if (inService && !inHealthcheck && line.match(/^  \w/) && !line.startsWith("    ")) {
      // Moving to next service — if we haven't found healthcheck yet, this service has none
      inService = false;
      continue;
    }

    // Detect healthcheck section within service
    if (inService && line.match(/^    healthcheck:/)) {
      inHealthcheck = true;
      continue;
    }

    // If we're inside a healthcheck block, parse its properties
    if (inHealthcheck) {
      // Properties are indented 6 spaces: "      key: value"
      const propMatch = line.match(/^      (\w+):\s*(.+)$/);
      if (propMatch) {
        hcRaw[propMatch[1]] = propMatch[2].trim();
        continue;
      }
      // If we encounter a line that is less indented or empty after properties, exit healthcheck
      if (line.match(/^    \w/) || (line.trim() === "" && Object.keys(hcRaw).length > 0)) {
        break;
      }
      if (line.match(/^  \w/)) {
        break;
      }
    }
  }

  // If no healthcheck parameters were found, return null
  if (!hcRaw.interval && !hcRaw.retries && !hcRaw.start_period && !hcRaw.test) {
    return null;
  }

  return {
    test: hcRaw.test || null,
    intervalMs: parseDuration(hcRaw.interval),
    timeoutMs: parseDuration(hcRaw.timeout),
    retries: Number.parseInt(hcRaw.retries, 10) || 0,
    startPeriodMs: parseDuration(hcRaw.start_period),
  };
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compute the maximum healthcheck timeout for a service.
 * Formula: startPeriodMs + (retries × intervalMs) + bufferMs
 * Capped at maxTimeoutMs (default 600000ms / 10 minutes).
 */
export function computeHealthTimeout(healthcheck, bufferMs = 30_000, maxTimeoutMs = 600_000) {
  if (!healthcheck) return maxTimeoutMs;
  const startPeriodMs = healthcheck.startPeriodMs || 0;
  const retries = healthcheck.retries || 0;
  const intervalMs = healthcheck.intervalMs || 0;
  const computed = startPeriodMs + (retries * intervalMs) + bufferMs;
  return Math.min(computed, maxTimeoutMs);
}

/**
 * Parse docker compose ps --format json output into an array of container objects.
 * Input is one JSON object per line.
 */
function parsePsJson(stdout) {
  const containers = [];
  const lines = stdout.trim().split(/\r?\n/);
  for (const line of lines) {
    try {
      containers.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return containers;
}

/**
 * Service Lifecycle Manager for agent Docker validation.
 * Manages preflight checks, service startup, and evidence collection.
 */
export class ServiceLifecycleManager {
  /** @type {string} */
  #repositoryRoot;
  /** @type {string} */
  #runId;
  /** @type {string|null} */
  #taskId;
  /** @type {string} */
  #scopeId;
  /** @type {string} */
  #projectName;
  /** @type {string} */
  #composePath;
  /** @type {string} */
  #validationDir;
  /** @type {boolean} */
  #available = false;
  /** @type {string|null} */
  #dockerVersion = null;
  /** @type {string|null} */
  #composeVersion = null;
  /** @type {string|null} */
  #error = null;
  /** @type {Array<{cmd: string, exitCode: number|null, timestamp: string}>} */
  #commands = [];
  /** @type {Array<{name: string, startedAt: string}>} */
  #services = [];
  /** @type {string|null} */
  #profileName = null;
  /** @type {string|null} */
  #overridePath = null;
  /** @type {string|null} */
  #teardownWarning = null;
  /** @type {boolean} */
  #downCalled = false;

  constructor({ repositoryRoot, runId, taskId = null, composePath }) {
    this.#repositoryRoot = repositoryRoot;
    this.#runId = runId;
    this.#taskId = taskId;
    this.#scopeId = dockerLifecycleScopeId(runId, taskId);
    this.#projectName = dockerLifecycleProjectName(runId, taskId);
    this.#composePath = composePath ?? join(repositoryRoot, "compose.yaml");
    const taskSegment = taskId ? sha256(String(taskId)).slice(0, 12) : "run";
    this.#validationDir = join(repositoryRoot, ".runtime", "agent-validation", runId, taskSegment);
  }

  /**
   * Run a Docker CLI command and record the result.
   */
  async #runAndRecord(command, args, options = {}) {
    const result = await runProcess(command, args, {
      cwd: options.cwd ?? this.#repositoryRoot,
      timeoutMs: options.timeoutMs ?? 30_000,
      ...options,
    });

    const exitCode = result.status;
    const errorMsg = result.error?.message ?? null;

    this.#commands.push({
      cmd: `${command} ${args.join(" ")}`,
      exitCode,
      timestamp: nowIso(),
    });

    return { ...result, recordedError: errorMsg };
  }

  /**
   * Preflight check: verify Docker and Compose are available.
   * Does not globally tear down other Agent Runtime Compose projects: other
   * tasks in the same DAG may legitimately be using them concurrently.
   * @returns {Promise<{available: boolean, dockerVersion: string|null, composeVersion: string|null, error: string|null}>}
   */
  async preflight() {
    this.#commands = [];

    // Step 1: docker info
    const dockerInfo = await this.#runAndRecord("docker", ["info"], { timeoutMs: 10_000 });

    if (dockerInfo.status !== 0) {
      this.#available = false;
      this.#error = dockerInfo.stderr || dockerInfo.stdout || dockerInfo.recordedError || "docker info failed";
      return {
        available: false,
        dockerVersion: null,
        composeVersion: null,
        error: this.#error,
      };
    }

    this.#dockerVersion = extractDockerVersion(dockerInfo.stdout);

    // Step 2: docker compose version
    const composeVersion = await this.#runAndRecord("docker", ["compose", "version"], { timeoutMs: 10_000 });

    if (composeVersion.status !== 0) {
      this.#available = false;
      this.#error = composeVersion.stderr || composeVersion.stdout || composeVersion.recordedError || "docker compose version failed";
      return {
        available: false,
        dockerVersion: this.#dockerVersion,
        composeVersion: null,
        error: this.#error,
      };
    }

    this.#composeVersion = extractComposeVersion(composeVersion.stdout);

    this.#available = true;
    this.#error = null;

    return {
      available: true,
      dockerVersion: this.#dockerVersion,
      composeVersion: this.#composeVersion,
      error: null,
    };
  }

  /**
   * Start Docker services for the given profile.
   * Generates compose override, creates validation directory, and starts services.
   * @param {{services: string[], name: string}} profile
   * @returns {Promise<{status: string, code?: string, message?: string, service?: string, resource?: string, services?: Array<{name: string, startedAt: string}>}>}
   */
  async up(profile) {
    if (!this.#available) {
      return { status: "blocked", code: "docker_unavailable", message: this.#error ?? "Docker not available" };
    }

    this.#profileName = profile.name;
    const { services } = profile;

    // Create validation directory
    await mkdir(this.#validationDir, { recursive: true });

    // Compute ephemeral ports
    const ephemeralPorts = buildEphemeralPortMap(this.#scopeId, services);

    // Generate compose override
    const overrideYaml = generateComposeOverride({
      runId: this.#runId,
      services,
      validationDir: this.#validationDir,
      ephemeralPorts,
      repositoryRoot: this.#repositoryRoot,
    });

    const overridePath = join(this.#validationDir, `compose.agent-validation-${sha256(this.#scopeId).slice(0, 12)}.yaml`);
    await writeFile(overridePath, overrideYaml, "utf8");
    this.#overridePath = overridePath;

    // A retry of the same task uses the same deterministic project identity.
    // Clear only this task's stale project before startup. Never sweep every
    // agentic-harness-agent-* project because sibling DAG tasks may be live.
    await this.#runAndRecord("docker", [
      "compose",
      "-p", this.#projectName,
      "-f", this.#composePath,
      "-f", overridePath,
      "down", "--volumes", "--remove-orphans",
    ], { timeoutMs: 30_000 });

    // Execute docker compose up
    const composeArgs = [
      "compose",
      "-p", this.#projectName,
      "-f", this.#composePath,
      "-f", overridePath,
      "up", "-d", "--no-deps",
      ...services,
    ];

    const upResult = await this.#runAndRecord("docker", composeArgs, { timeoutMs: 120_000 });

    if (upResult.status !== 0) {
      const errorText = upResult.stderr || upResult.stdout || upResult.recordedError || "unknown error";

      // Detect port/volume conflict
      if (
        errorText.includes("port") && (errorText.includes("already") || errorText.includes("use") || errorText.includes("bind")) ||
        errorText.includes("volume") && errorText.includes("use")
      ) {
        const serviceMatch = errorText.match(/service[:\s]+"?(\S+)"?/i);
        const resourceMatch = errorText.match(/(port|volume)[:\s]+"?(\S+)"?/i);

        return {
          status: "blocked",
          code: "service_conflict",
          message: errorText.slice(0, 1000),
          service: serviceMatch?.[1] ?? "unknown",
          resource: resourceMatch?.[2] ?? errorText.slice(0, 200),
        };
      }

      return {
        status: "blocked",
        code: "service_start_failed",
        message: errorText.slice(0, 1000),
        service: "unknown",
        resource: errorText.slice(0, 200),
      };
    }

    // Record started services
    const startedAt = nowIso();
    this.#services = services.map((name) => ({ name, startedAt }));

    return {
      status: "ok",
      services: this.#services,
    };
  }

  /**
   * Wait for all started services to reach healthy status.
   * Reads healthcheck config from compose.yaml to compute per-service timeouts.
   * @param {number|null} [maxTimeoutMs=null] - Overall maximum timeout in ms (falls back to per-service computed timeout).
   * @param {{signal?: AbortSignal}} [options={}]
   * @returns {Promise<{status: string, code?: string, service?: string, services?: Array<{name: string, health: string, startedAt: string, healthyAt: string|null, elapsedMs: number}>, elapsedMs?: number, timeoutMs?: number, lastStatus?: string}>}
   */
  async waitForHealth(maxTimeoutMs = null, options = {}) {
    if (this.#services.length === 0) {
      return { status: "ok", services: [] };
    }

    const projectName = this.#projectName;
    const composeArgs = [
      "compose",
      "-p", projectName,
    ];

    // Add compose files if we have override path
    if (this.#overridePath) {
      composeArgs.push("-f", this.#composePath, "-f", this.#overridePath);
    } else {
      composeArgs.push("-f", this.#composePath);
    }

    composeArgs.push("ps", "--format", "json");

    // Read compose.yaml to extract healthcheck configs
    let composeContent;
    try {
      composeContent = await readFile(this.#composePath, "utf8");
    } catch {
      // If we can't read compose.yaml, use defaults
      composeContent = "";
    }

    // Build per-service healthcheck configs
    const serviceHealthchecks = {};
    const serviceTimeouts = {};
    let globalMaxTimeout = 0;

    for (const svc of this.#services) {
      const hc = parseHealthcheckFromCompose(composeContent, svc.name);
      serviceHealthchecks[svc.name] = hc;
      const timeout = hc ? computeHealthTimeout(hc) : 60_000; // 60s default for no healthcheck
      serviceTimeouts[svc.name] = timeout;
      if (timeout > globalMaxTimeout) globalMaxTimeout = timeout;
    }

    // Use explicit maxTimeoutMs if provided, otherwise use computed maximum
    const effectiveMaxTimeout = maxTimeoutMs ?? globalMaxTimeout;
    const pollIntervalMs = 2_000; // Poll every 2s

    const startTime = Date.now();
    const serviceStartTimes = {};
    for (const svc of this.#services) {
      serviceStartTimes[svc.name] = startTime;
    }

    while (true) {
      // Check abort signal
      if (options.signal?.aborted) {
        const elapsed = Date.now() - startTime;
        return {
          status: "blocked",
          code: "aborted",
          elapsedMs: elapsed,
          timeoutMs: effectiveMaxTimeout,
        };
      }

      // Check overall timeout
      const elapsed = Date.now() - startTime;
      if (elapsed >= effectiveMaxTimeout) {
        // Find the first non-healthy service for error reporting
        // We need to query ps to find last status
        let lastStatus = "unknown";
        let blockingService = this.#services[0]?.name ?? "unknown";
        try {
          const psResult = await this.#runAndRecord("docker", composeArgs, { timeoutMs: 10_000 });
          if (psResult.status === 0 && psResult.stdout) {
            const containers = parsePsJson(psResult.stdout);
            for (const svc of this.#services) {
              const container = containers.find((c) => c.Service === svc.name);
              if (container && container.Health !== "healthy") {
                blockingService = svc.name;
                lastStatus = container.Health || "unknown";
                break;
              }
            }
          }
        } catch {
          // Best effort
        }

        return {
          status: "blocked",
          code: "service_healthcheck_timeout",
          service: blockingService,
          elapsedMs: elapsed,
          timeoutMs: effectiveMaxTimeout,
          lastStatus,
        };
      }

      // Poll docker compose ps
      let psResult;
      try {
        psResult = await this.#runAndRecord("docker", composeArgs, { timeoutMs: 10_000 });
      } catch {
        await sleep(pollIntervalMs);
        continue;
      }

      if (psResult.status !== 0 || !psResult.stdout) {
        await sleep(pollIntervalMs);
        continue;
      }

      const containers = parsePsJson(psResult.stdout);
      let allReady = true;
      const serviceResults = [];

      for (const svc of this.#services) {
        const container = containers.find((c) => c.Service === svc.name);
        const hc = serviceHealthchecks[svc.name];

        if (!container) {
          // Service not yet in ps output — still starting
          allReady = false;
          continue;
        }

        const health = container.Health || "";

        if (health === "healthy") {
          serviceResults.push({
            name: svc.name,
            health: "healthy",
            startedAt: svc.startedAt,
            healthyAt: nowIso(),
            elapsedMs: Date.now() - serviceStartTimes[svc.name],
          });
        } else if (!hc && (health === "" || container.State === "running")) {
          // No healthcheck defined — accept as "started"
          serviceResults.push({
            name: svc.name,
            health: "started",
            startedAt: svc.startedAt,
            healthyAt: null,
            elapsedMs: Date.now() - serviceStartTimes[svc.name],
          });
        } else {
          allReady = false;
        }
      }

      if (allReady && serviceResults.length === this.#services.length) {
        return {
          status: "ok",
          services: serviceResults,
        };
      }

      // Sleep before next poll
      await sleep(pollIntervalMs);
    }
  }

  /**
   * Execute teardown: docker compose down + remove validation directory.
   * Idempotent — safe to call multiple times. Never throws.
   * On Docker failure, registers teardown_failed warning without masking the original run result.
   * @returns {Promise<{status: string, code?: string, error?: string}>}
   */
  async down() {
    // Idempotency: if already called, return immediately
    if (this.#downCalled) return { status: "ok" };
    this.#downCalled = true;

    const projectName = this.#projectName;

    // Step 1: docker compose down --volumes --remove-orphans (timeout 30s)
    const downArgs = ["compose", "-p", projectName];
    if (this.#overridePath) downArgs.push("-f", this.#composePath, "-f", this.#overridePath);
    else downArgs.push("-f", this.#composePath);
    downArgs.push("down", "--volumes", "--remove-orphans");
    const downResult = await this.#runAndRecord("docker", downArgs, { timeoutMs: 30_000 });

    // Step 2: remove validation directory (best-effort)
    try {
      await rm(this.#validationDir, { recursive: true, force: true });
    } catch {
      // Directory removal is best-effort; don't mask docker result
    }

    // Step 3: check for teardown failure
    if (downResult.status !== 0) {
      const errorMsg = downResult.recordedError || downResult.stderr || downResult.stdout || "docker compose down failed";
      this.#teardownWarning = `teardown_failed: ${errorMsg}`;
      return { status: "warning", code: "teardown_failed", error: errorMsg };
    }

    return { status: "ok" };
  }

  /**
   * Register OS signal traps for graceful teardown.
   * SIGINT (Ctrl+C) and SIGBREAK (Windows) trigger down() before exit.
   * SIGKILL is unrecoverable — cannot be trapped (documented limitation).
   * process.on("exit") can only execute synchronous code; the handler here
   * is best-effort. Reliable teardown relies on SIGINT/SIGBREAK + preflight
   * cleanup of orphan containers from prior runs.
   * @returns {() => void} Cleanup function that removes all registered listeners.
   */
  registerSignalTraps() {
    const downWrapper = () => {
      this.down().catch(() => {
        // Best-effort: never throw inside a signal handler
      });
    };

    const exitHandler = () => {
      // process.on("exit") handlers must be synchronous.
      // SIGKILL is unrecoverable. Graceful teardown relies on SIGINT/SIGBREAK
      // and preflight cleanup of orphan containers from prior runs.
    };

    process.on("SIGINT", downWrapper);
    process.on("SIGBREAK", downWrapper);
    process.on("exit", exitHandler);

    return () => {
      process.removeListener("SIGINT", downWrapper);
      process.removeListener("SIGBREAK", downWrapper);
      process.removeListener("exit", exitHandler);
    };
  }

  /**
   * Return collected evidence of all lifecycle operations.
   * @returns {{available: boolean, profile: string|null, services: Array<{name: string, startedAt: string}>, commands: Array<{cmd: string, exitCode: number|null, timestamp: string}>, teardownWarning: string|null, error: string|null}}
   */
  getEvidence() {
    return {
      available: this.#available,
      profile: this.#profileName,
      services: [...this.#services],
      commands: [...this.#commands],
      teardownWarning: this.#teardownWarning,
      error: this.#error,
    };
  }

  /**
   * One-shot health check of all started services.
   * Queries `docker compose ps --format json` and returns the health status
   * of each service. Does NOT wait or retry — use waitForHealth() for that.
   *
   * Services with no healthcheck defined that are still running are considered healthy.
   * Services that are unhealthy, exited, or not found in ps output are reported as unhealthy.
   *
   * @returns {Promise<{allHealthy: boolean, unhealthyServices: string[]} | null>}
   *   null if the ps command failed (Docker daemon unreachable, etc.)
   */
  async checkHealth() {
    if (this.#services.length === 0) {
      return { allHealthy: true, unhealthyServices: [] };
    }

    const projectName = this.#projectName;
    const composeArgs = [
      "compose",
      "-p", projectName,
    ];

    // Add compose files if we have override path
    if (this.#overridePath) {
      composeArgs.push("-f", this.#composePath, "-f", this.#overridePath);
    } else {
      composeArgs.push("-f", this.#composePath);
    }

    composeArgs.push("ps", "--format", "json");

    try {
      const result = await this.#runAndRecord("docker", composeArgs, { timeoutMs: 10_000 });

      if (result.status !== 0 || !result.stdout) {
        return null;
      }

      const containers = parsePsJson(result.stdout);
      const unhealthy = [];

      for (const svc of this.#services) {
        const container = containers.find((c) => c.Service === svc.name);

        if (!container) {
          // Container not found in ps output — service exited or never started
          unhealthy.push(svc.name);
        } else if (container.Health === "unhealthy") {
          // Explicitly unhealthy
          unhealthy.push(svc.name);
        } else if (!container.Health && container.State !== "running") {
          // No healthcheck and not running — service exited
          unhealthy.push(svc.name);
        }
        // Otherwise: healthy or (no healthcheck + running) → considered healthy
      }

      return {
        allHealthy: unhealthy.length === 0,
        unhealthyServices: unhealthy,
      };
    } catch {
      // ps command threw — Docker daemon may be unreachable
      return null;
    }
  }
}
