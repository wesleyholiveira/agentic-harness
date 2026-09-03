import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const DERIVED_PREFIX = "agentic-harness";
const OVERRIDE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_PROJECT_NAME_LENGTH = 63;

export function canonicalFilesystemIdentity(inputPath) {
  const absolute = resolve(inputPath);
  let canonical = absolute;
  if (existsSync(absolute)) {
    const nativeRealpath = typeof realpathSync.native === "function" ? realpathSync.native : realpathSync;
    canonical = nativeRealpath(absolute);
  }
  canonical = canonical.replaceAll("\\", "/");
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function deriveComposeProjectName(projectRoot) {
  const identity = canonicalFilesystemIdentity(projectRoot);
  const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16);
  return `${DERIVED_PREFIX}-${digest}`;
}

export function validateComposeProjectName(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("AGENT_HARNESS_COMPOSE_PROJECT_NAME must be a non-empty string");
  }
  if (value.length > MAX_PROJECT_NAME_LENGTH || !OVERRIDE_PATTERN.test(value)) {
    throw new Error(
      "AGENT_HARNESS_COMPOSE_PROJECT_NAME must start with [a-z0-9], contain only [a-z0-9_-], and be at most 63 characters",
    );
  }
  return value;
}

export function resolveComposeProjectIdentity(projectRoot, environment = process.env) {
  const explicit = environment.AGENT_HARNESS_COMPOSE_PROJECT_NAME?.trim();
  if (explicit) {
    return {
      name: validateComposeProjectName(explicit),
      source: "AGENT_HARNESS_COMPOSE_PROJECT_NAME",
      projectIdentitySha256: createHash("sha256")
        .update(canonicalFilesystemIdentity(projectRoot), "utf8")
        .digest("hex"),
    };
  }

  const identity = canonicalFilesystemIdentity(projectRoot);
  return {
    name: deriveComposeProjectName(projectRoot),
    source: "derived-from-canonical-project-root",
    projectIdentitySha256: createHash("sha256").update(identity, "utf8").digest("hex"),
  };
}
