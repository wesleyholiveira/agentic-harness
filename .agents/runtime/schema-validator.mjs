import { join } from "node:path";
import { readJson } from "./utils.mjs";

const schemaFiles = {
  taskBrief: "task-brief.schema.json",
  contextPacket: "context-packet.schema.json",
  handoffResult: "handoff-result.schema.json",
  integrationDecision: "integration-decision.schema.json",
  executionPlan: "execution-plan.schema.json",
  reasoningAssessment: "reasoning-assessment.schema.json",
  implementationPlan: "implementation-plan.schema.json",
  replayCapsule: "replay-capsule.schema.json",
  agentInputManifest: "agent-input-manifest.schema.json",
};

function jsonConstMatches(value, expected) {
  if (Object.is(value, expected)) return true;
  if (Array.isArray(value) || Array.isArray(expected)) {
    if (!Array.isArray(value) || !Array.isArray(expected) || value.length !== expected.length) return false;
    return value.every((item, index) => jsonConstMatches(item, expected[index]));
  }
  if (value && expected && typeof value === "object" && typeof expected === "object") {
    const valueKeys = Object.keys(value).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (valueKeys.length !== expectedKeys.length || valueKeys.some((key, index) => key !== expectedKeys[index])) return false;
    return valueKeys.every((key) => jsonConstMatches(value[key], expected[key]));
  }
  return false;
}

function typeMatches(value, expected) {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "integer") return Number.isInteger(value);
  return typeof value === expected;
}

function validateNode(value, schema, path, errors) {
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) validateNode(value, branch, path, errors);
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((branch) => {
      const branchErrors = [];
      validateNode(value, branch, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (!matches) errors.push(`${path}: expected to match at least one anyOf branch`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => {
      const branchErrors = [];
      validateNode(value, branch, path, branchErrors);
      return branchErrors.length === 0;
    }).length;
    if (matches !== 1) errors.push(`${path}: expected to match exactly one oneOf branch`);
  }
  if (schema.if && typeof schema.if === "object") {
    const conditionErrors = [];
    validateNode(value, schema.if, path, conditionErrors);
    if (conditionErrors.length === 0 && schema.then) validateNode(value, schema.then, path, errors);
    else if (conditionErrors.length > 0 && schema.else) validateNode(value, schema.else, path, errors);
  }
  if (schema.const !== undefined && !jsonConstMatches(value, schema.const)) errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: expected one of ${schema.enum.join(", ")}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${path}: expected type ${types.join("|")}`);
      return;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: string shorter than ${schema.minLength}`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${path}: pattern mismatch`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${path}: invalid date-time`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: expected at least ${schema.minItems} items`);
    if (schema.items) value.forEach((item, index) => validateNode(item, schema.items, `${path}[${index}]`, errors));
    return;
  }
  if (value !== null && typeof value === "object") {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) errors.push(`${path}.${required}: required property missing`);
    }
    for (const [key, nested] of Object.entries(value)) {
      if (properties[key]) validateNode(nested, properties[key], `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional property not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateNode(nested, schema.additionalProperties, `${path}.${key}`, errors);
    }
  }
}

export async function loadSchemas(repositoryRoot) {
  const base = join(repositoryRoot, ".agents", "schemas");
  return Object.fromEntries(await Promise.all(Object.entries(schemaFiles).map(async ([name, file]) => [name, await readJson(join(base, file))])));
}

export function validateAgainstSchema(value, schema, label = "artifact") {
  const errors = [];
  validateNode(value, schema, label, errors);
  return { valid: errors.length === 0, errors };
}

export function assertSchema(value, schema, label = "artifact") {
  const result = validateAgainstSchema(value, schema, label);
  if (!result.valid) throw new Error(`schema_validation_failed:${label}:${result.errors.join("; ")}`);
  return value;
}

export async function validateArtifact(repositoryRoot, schemaName, artifact) {
  const schemas = await loadSchemas(repositoryRoot);
  const schema = schemas[schemaName];
  if (!schema) throw new Error(`unknown_schema:${schemaName}`);
  return assertSchema(artifact, schema, schemaName);
}
