import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("Context Engine image carries the pinned Linux CBM runtime used by its persistent MCP adapter", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "apps/context-engine/package.json"), "utf8"));
  assert.equal(pkg.dependencies["codebase-memory-mcp"], "0.10.8");

  const dockerfile = readFileSync(resolve(root, "apps/context-engine/Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY package\.json package-lock\.json tsconfig\.json/);
  assert.match(dockerfile, /RUN npm ci/);
  assert.match(dockerfile, /node_modules\/\.bin\/codebase-memory-mcp --version/);

  const compose = readFileSync(resolve(root, "compose.yaml"), "utf8");
  assert.match(compose, /CODEBASE_MEMORY_MCP_BINARY: \/workspace\/harness\/node_modules\/\.bin\/codebase-memory-mcp/);
  assert.match(compose, /CONTEXT_ENGINE_CBM_TRANSPORT: persistent-mcp/);
});
