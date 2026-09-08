export function parseWorkerMetadata(worker) {
  const raw = worker?.metadata_json;
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function workerExecutionCapabilities(worker, expectedModels = []) {
  const metadata = parseWorkerMetadata(worker);
  const capabilities = metadata?.capabilities && typeof metadata.capabilities === "object"
    ? metadata.capabilities
    : null;
  const models = Array.isArray(capabilities?.openaiModels)
    ? capabilities.openaiModels.map(String)
    : [];
  const missingModels = expectedModels.filter((model) => !models.includes(model));
  const available = Boolean(capabilities);
  return {
    source: "rust-worker-heartbeat-metadata",
    available,
    gitAvailable: capabilities?.gitAvailable === true,
    gitVersion: capabilities?.gitVersion ?? null,
    opencodeAvailable: capabilities?.opencodeAvailable === true,
    opencodeVersion: capabilities?.opencodeVersion ?? null,
    authAvailable: capabilities?.authAvailable === true,
    authOpenaiAvailable: capabilities?.authOpenaiAvailable === true,
    authPath: capabilities?.authPath ?? null,
    modelCatalogAvailable: capabilities?.modelCatalogAvailable === true,
    openaiModels: models,
    missingModels,
    probeErrors: Array.isArray(capabilities?.probeErrors) ? capabilities.probeErrors.map(String) : [],
  };
}
