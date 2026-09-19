import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  discoverPythonRequirementFiles,
  inspectValidationCommandToolchain,
  prepareValidationCommandToolchain,
  requiredValidationExecutables,
} from "../../scripts/internal/agent-runtime-validation-toolchain-preflight.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("npm validation scripts resolve their real executable requirements", () => {
  const required = requiredValidationExecutables({
    commands: [
      "npm run test:ml",
      "cd apps/worker && cargo test --manifest-path Cargo.toml",
    ],
    packageJson: {
      scripts: {
        "test:ml": "python apps/ml/run_tests.py",
      },
    },
  });

  assert.deepEqual(required, ["cargo", "npm", "python"]);
});

test("python3 and python normalize to one Python capability", () => {
  const required = requiredValidationExecutables({
    commands: [
      "PYTHONPATH=apps/ml python3 -m unittest discover -s apps/ml/tests",
      "python -m py_compile apps/ml/example.py",
    ],
  });
  assert.deepEqual(required, ["python"]);
});

test("validation toolchain preflight fails before execution when Python is absent", async () => {
  const available = new Set(["npm"]);
  const result = await inspectValidationCommandToolchain({
    root,
    commands: ["npm run test:ml"],
    availability: async (executable) => available.has(executable),
  });

  // The Harness repository itself does not define test:ml, so prove direct
  // Python detection here and npm-script expansion separately above.
  assert.equal(result.ok, true);

  const direct = await inspectValidationCommandToolchain({
    root,
    commands: ["python apps/ml/run_tests.py"],
    availability: async (executable) => available.has(executable),
  });
  assert.equal(direct.ok, false);
  assert.equal(direct.code, "agent_runtime_validation_command_toolchain_unavailable");
  assert.deepEqual(direct.missingExecutables, ["python"]);
  assert.match(direct.remediation, /required_executables:python/u);
});

test("runtime worker provisions Python base but does not hardcode pytest", () => {
  const dockerfile = readFileSync(resolve(root, "apps/runtime-worker/Dockerfile"), "utf8");
  assert.match(dockerfile, /python3/u);
  assert.match(dockerfile, /python3-pip/u);
  assert.match(dockerfile, /python3-venv/u);
  assert.match(dockerfile, /python-is-python3/u);
  assert.doesNotMatch(dockerfile, /\bpytest\b/u);
});

test("implementation toolchain preflight runs before isolated workspace creation", () => {
  const executor = readFileSync(resolve(root, ".agents/runtime/executor.mjs"), "utf8");
  const preflight = executor.indexOf("const validationToolchain = await prepareValidationCommandToolchain");
  const workspace = executor.indexOf("const workspace = await createIsolatedWorkspace");
  assert.ok(preflight >= 0, "validation toolchain preflight must exist");
  assert.ok(workspace >= 0, "workspace creation must exist");
  assert.ok(preflight < workspace, "toolchain must fail before implementation workspace materialization");
  assert.match(executor, /phase: "pre-executor-toolchain"/u);
  assert.match(executor, /validation_toolchain_unavailable/u);
});

test("consumer Python requirements are discovered next to the resolved npm Python entrypoint", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-python-requirements-"));
  try {
    await mkdir(join(workspace, "apps", "ml"), { recursive: true });
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      scripts: { "test:ml": "python apps/ml/run_tests.py" },
    }), "utf8");
    await writeFile(join(workspace, "apps", "ml", "run_tests.py"), "print('ok')\n", "utf8");
    await writeFile(join(workspace, "apps", "ml", "requirements.txt"), "pydantic>=2\n", "utf8");
    await writeFile(join(workspace, "apps", "ml", "requirements-dev.txt"), "coverage>=7\n", "utf8");

    const files = await discoverPythonRequirementFiles({
      root: workspace,
      commands: ["npm run test:ml"],
    });
    assert.deepEqual(files.map((value) => value.replaceAll("\\", "/")), [
      join(workspace, "apps", "ml", "requirements-dev.txt").replaceAll("\\", "/"),
      join(workspace, "apps", "ml", "requirements.txt").replaceAll("\\", "/"),
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Python preparation uses cached venv plus pip requirements and exposes it to the executor", () => {
  const source = readFileSync(
    resolve(root, "scripts/internal/agent-runtime-validation-toolchain-preflight.mjs"),
    "utf8",
  );
  assert.match(source, /pythonToolchainFingerprint/u);
  assert.match(source, /AGENT_HARNESS_AGENT_WORKSPACE_ROOT/u);
  assert.match(source, /"-m", "venv", venvPath/u);
  assert.match(source, /"-m", "pip", "install"/u);
  assert.match(source, /requirementFiles\.flatMap/u);
  assert.match(source, /VIRTUAL_ENV: venvPath/u);
  assert.match(source, /PIP_CACHE_DIR/u);
  assert.match(source, /\.ready/u);
  assert.match(source, /\.lock/u);
});
