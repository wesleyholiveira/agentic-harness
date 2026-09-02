import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runProcess } from "./process.mjs";

export const DEFAULT_OPENCODE_DOCTOR_PROBE_TIMEOUT_MS = 10_000;
export const EXPECTED_OPENCODE_PROVIDER = "openai";
export const EXPECTED_OPENCODE_MODELS = ["openai/gpt-5.6-luna"];

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function resolveOpenCodeAuthPath(source = process.env) {
  const dataHome = String(source.XDG_DATA_HOME ?? "").trim();
  if (dataHome) return join(dataHome, "opencode", "auth.json");
  const home = String(source.HOME ?? "").trim() || homedir();
  return join(home, ".local", "share", "opencode", "auth.json");
}

export function isolatedOpenCodeProbeEnv(source = process.env) {
  const env = {
    ...source,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  };
  // Doctor readiness must not recursively load the project's OpenCode config,
  // MCP graph or external plugins. Keep OpenCode internal/default plugins enabled:
  // ChatGPT OAuth for the built-in OpenAI provider is materialized by the internal
  // CodexAuthPlugin even when --pure suppresses external project plugins.
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_DIR;
  delete env.OPENCODE_CONFIG_CONTENT;
  // --pure already suppresses external project plugins. The built-in Codex auth
  // plugin must remain enabled so ChatGPT OAuth can materialize provider=openai.
  delete env.OPENCODE_DISABLE_DEFAULT_PLUGINS;
  return env;
}

async function timedProbe(run, command, args, options) {
  const startedAt = Date.now();
  const result = await run(command, args, options);
  return { ...result, durationMs: Date.now() - startedAt };
}

export async function probeOpenCodeAuthFile({
  provider = EXPECTED_OPENCODE_PROVIDER,
  authPath = resolveOpenCodeAuthPath(),
} = {}) {
  const startedAt = Date.now();
  const expectedProviders = [provider];
  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("auth_json_root_must_be_object");
    }
    const providers = Object.keys(parsed);
    const missingProviders = providers.includes(provider) ? [] : expectedProviders;
    return {
      available: true,
      source: "credentials-file",
      authPath,
      expectedProviders,
      missingProviders,
      error: null,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      available: false,
      source: "credentials-file",
      authPath,
      expectedProviders,
      missingProviders: expectedProviders,
      error: `auth_file_unavailable:${errorText(error)}`.slice(0, 2000),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function createEphemeralProbeState({ sourceEnv, authPath }) {
  const root = await mkdtemp(join(tmpdir(), "agentic-harness-opencode-doctor-"));
  const home = join(root, "home");
  const dataHome = join(home, ".local", "share");
  const configHome = join(home, ".config");
  const stateHome = join(home, ".local", "state");
  const originalHome = String(sourceEnv.HOME ?? "").trim() || homedir();
  const cacheHome = String(sourceEnv.XDG_CACHE_HOME ?? "").trim() || join(originalHome, ".cache");
  const probeAuthPath = join(dataHome, "opencode", "auth.json");

  await Promise.all([
    mkdir(dirname(probeAuthPath), { recursive: true }),
    mkdir(configHome, { recursive: true }),
    mkdir(stateHome, { recursive: true }),
  ]);

  let authCopied = false;
  try {
    await copyFile(authPath, probeAuthPath);
    authCopied = true;
  } catch {
    // Auth availability is reported independently from the original read-only
    // credentials file. Model metadata can still be probed without inventing
    // credentials or touching the shared OpenCode database.
  }

  const env = isolatedOpenCodeProbeEnv({
    ...sourceEnv,
    HOME: home,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
    // Reuse only the model cache. Persistent data/state/config are isolated so
    // the doctor cannot contend on ~/.local/share/opencode/opencode.db.
    XDG_CACHE_HOME: cacheHome,
  });

  return {
    root,
    env,
    authCopied,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function probeOpenCodeReadiness({
  run = runProcess,
  provider = EXPECTED_OPENCODE_PROVIDER,
  expectedModels = EXPECTED_OPENCODE_MODELS,
  timeoutMs = DEFAULT_OPENCODE_DOCTOR_PROBE_TIMEOUT_MS,
  cwd = tmpdir(),
  env = process.env,
  authPath = resolveOpenCodeAuthPath(env),
} = {}) {
  const authCatalog = await probeOpenCodeAuthFile({ provider, authPath });
  let probeState = null;
  try {
    probeState = await createEphemeralProbeState({ sourceEnv: env, authPath });
    const probeOptions = { cwd, env: probeState.env, timeoutMs };

    // Keep OpenCode subprocesses serialized even inside the ephemeral data
    // directory. Older probes ran auth/models concurrently and could make the
    // doctor itself create SQLite contention.
    const version = await timedProbe(run, "opencode", ["--version"], probeOptions);
    const models = await timedProbe(run, "opencode", ["--pure", "models", provider], probeOptions);

    const modelsText = `${models.stdout ?? ""}\n${models.stderr ?? ""}`;
    const modelCatalogAvailable = models.status === 0 && !models.timedOut;
    const missingModels = modelCatalogAvailable
      ? expectedModels.filter((model) => !modelsText.includes(model))
      : [...expectedModels];

    return {
      mode: "isolated-ephemeral-local-catalog",
      timeoutMs,
      cwd,
      configIsolated: true,
      pure: true,
      externalPluginsDisabled: true,
      defaultPluginsEnabled: probeState.env.OPENCODE_DISABLE_DEFAULT_PLUGINS !== "1",
      modelsFetchDisabled: probeState.env.OPENCODE_DISABLE_MODELS_FETCH === "1",
      sharedDatabaseAvoided: true,
      authSource: "credentials-file",
      authCopiedToProbeState: probeState.authCopied,
      version,
      authCatalog,
      modelCatalog: {
        available: modelCatalogAvailable,
        provider,
        expectedModels,
        missingModels,
        error: modelCatalogAvailable
          ? null
          : (models.stderr || models.stdout || (models.timedOut ? "model_catalog_probe_timeout" : "model_catalog_unavailable")).slice(0, 2000),
        durationMs: models.durationMs,
      },
    };
  } catch (error) {
    const unavailable = {
      status: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 0,
    };
    return {
      mode: "isolated-ephemeral-local-catalog",
      timeoutMs,
      cwd,
      configIsolated: true,
      pure: true,
      externalPluginsDisabled: true,
      defaultPluginsEnabled: probeState?.env?.OPENCODE_DISABLE_DEFAULT_PLUGINS !== "1",
      modelsFetchDisabled: true,
      sharedDatabaseAvoided: Boolean(probeState),
      authSource: "credentials-file",
      authCopiedToProbeState: probeState?.authCopied ?? false,
      version: unavailable,
      authCatalog,
      modelCatalog: {
        available: false,
        provider,
        expectedModels,
        missingModels: [...expectedModels],
        error: `opencode_probe_state_unavailable:${errorText(error)}`.slice(0, 2000),
        durationMs: 0,
      },
    };
  } finally {
    await probeState?.cleanup().catch(() => {});
  }
}
