import {
  PROCEDURE_CONDITION_KINDS,
  PROCEDURE_SOURCE_KINDS,
  PROCEDURE_STEP_KINDS,
  type ProcedureCondition,
  type ProcedureDefinition,
  type ProcedureSource,
  type ProcedureStep,
  type ProcedureToolArgumentValue,
} from "../types.js";
import {
  normalizeProcedureToolArgumentValue,
  parseProcedureYaml,
  readOptionalProcedureString,
  readProcedureConditionKind,
  readProcedureRecord,
  readProcedureRecordArray,
  readProcedureSourceKind,
  readProcedureStepKind,
  readProcedureStringArray,
  readRequiredProcedureString,
  rejectUnexpectedProcedureFields,
} from "./validation.js";

const PROCEDURE_KEYS = new Set([
  "procedure_key",
  "title",
  "goal",
  "when_to_use",
  "when_not_to_use",
  "prerequisites",
  "steps",
  "verification",
  "failure_modes",
  "sources",
]);

const STEP_BASE_KEYS = new Set(["id", "kind", "instruction", "conditions", "stop_if"]);
const READ_REFERENCE_STEP_KEYS = new Set([...STEP_BASE_KEYS, "ref"]);
const RUN_COMMAND_STEP_KEYS = new Set([...STEP_BASE_KEYS, "command"]);
const INSPECT_STATE_STEP_KEYS = new Set([...STEP_BASE_KEYS, "target", "query"]);
const EDIT_FILE_STEP_KEYS = new Set([...STEP_BASE_KEYS, "path", "edit"]);
const ASK_USER_STEP_KEYS = new Set([...STEP_BASE_KEYS, "prompt"]);
const INVOKE_TOOL_STEP_KEYS = new Set([...STEP_BASE_KEYS, "tool", "arguments"]);
const VERIFY_STEP_KEYS = new Set([...STEP_BASE_KEYS, "checks"]);

const SOURCE_KEYS = new Set(["kind", "path", "locator", "label"]);

const HARNESS_CONDITION_KEYS = new Set(["kind", "value"]);
const TOOL_AVAILABLE_CONDITION_KEYS = new Set(["kind", "value"]);
const FILE_EXISTS_CONDITION_KEYS = new Set(["kind", "path"]);
const PATH_EXISTS_CONDITION_KEYS = new Set(["kind", "path"]);
const ENV_FLAG_CONDITION_KEYS = new Set(["kind", "name", "value"]);
const REPO_STATE_CONDITION_KEYS = new Set(["kind", "value"]);
const USER_CONFIRMED_CONDITION_KEYS = new Set(["kind", "value"]);

/**
 * Shared normalized fields carried by every procedure step.
 */
interface NormalizedProcedureStepBase {
  id: string;
  instruction: string;
  conditions?: ProcedureCondition[];
  stop_if?: ProcedureCondition[];
}

/**
 * Parses raw procedure YAML and returns one normalized procedure definition.
 *
 * @param sourceText - Raw YAML source text.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Canonical normalized procedure body.
 */
export function parseAndNormalizeProcedureYaml(sourceText: string, filePath: string): ProcedureDefinition {
  return normalizeProcedureDefinition(parseProcedureYaml(sourceText, filePath), filePath);
}

/**
 * Validates and normalizes one parsed procedure document.
 *
 * @param value - Raw parsed procedure payload.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Canonical normalized procedure body.
 */
export function normalizeProcedureDefinition(value: unknown, filePath: string): ProcedureDefinition {
  const record = readProcedureRecord(value, "Procedure root", filePath);
  rejectUnexpectedProcedureFields(record, PROCEDURE_KEYS, "Procedure root", filePath);

  return {
    procedure_key: normalizeProcedureKey(record.procedure_key, filePath),
    title: readRequiredProcedureString(record.title, "title", filePath),
    goal: readRequiredProcedureString(record.goal, "goal", filePath),
    when_to_use: readProcedureStringArray(record.when_to_use, "when_to_use", filePath),
    when_not_to_use: readProcedureStringArray(record.when_not_to_use, "when_not_to_use", filePath),
    prerequisites: readProcedureStringArray(record.prerequisites, "prerequisites", filePath),
    steps: normalizeProcedureSteps(record.steps, filePath),
    verification: readProcedureStringArray(record.verification, "verification", filePath, { required: true, minItems: 1 }),
    failure_modes: readProcedureStringArray(record.failure_modes, "failure_modes", filePath, { required: true, minItems: 1 }),
    sources: normalizeProcedureSources(record.sources, "sources", filePath, { required: true, minItems: 1 }),
  };
}

/**
 * Normalizes one stable procedure key into the supported identifier format.
 *
 * @param value - Raw procedure-key field.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Lowercase slash-delimited procedure key.
 */
function normalizeProcedureKey(value: unknown, filePath: string): string {
  const normalized = readRequiredProcedureString(value, "procedure_key", filePath).toLowerCase();
  if (!normalized.includes("/") || !/^[a-z0-9][a-z0-9._/-]*$/u.test(normalized)) {
    throw new Error(`Invalid procedure ${filePath}: procedure_key must be a lowercase slash-delimited identifier like "agenr/release".`);
  }

  return normalized;
}

/**
 * Normalizes the ordered procedure step list and rejects duplicate step IDs.
 *
 * @param value - Raw steps field.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Normalized procedure steps.
 */
function normalizeProcedureSteps(value: unknown, filePath: string): ProcedureStep[] {
  const records = readProcedureRecordArray(value, "steps", filePath, { required: true, minItems: 1 });
  const steps = records.map((record, index) => normalizeProcedureStep(record, `steps[${index}]`, filePath));
  const stepIds = new Set<string>();

  for (const step of steps) {
    if (stepIds.has(step.id)) {
      throw new Error(`Invalid procedure ${filePath}: steps must not contain duplicate id "${step.id}".`);
    }

    stepIds.add(step.id);
  }

  return steps;
}

/**
 * Normalizes one procedure step according to its step-kind contract.
 *
 * @param record - Parsed step object.
 * @param label - Human-readable step label.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Normalized procedure step.
 */
function normalizeProcedureStep(record: Record<string, unknown>, label: string, filePath: string): ProcedureStep {
  const kind = readProcedureStepKind(record.kind, `${label}.kind`, filePath, PROCEDURE_STEP_KINDS);
  const base = normalizeProcedureStepBase(record, label, filePath);

  switch (kind) {
    case "run_command":
      rejectUnexpectedProcedureFields(record, RUN_COMMAND_STEP_KEYS, label, filePath);
      return {
        ...base,
        kind,
        command: readRequiredProcedureString(record.command, `${label}.command`, filePath),
      };
    case "read_reference":
      rejectUnexpectedProcedureFields(record, READ_REFERENCE_STEP_KEYS, label, filePath);
      return {
        ...base,
        kind,
        ref: normalizeProcedureSource(readProcedureRecord(record.ref, `${label}.ref`, filePath), `${label}.ref`, filePath),
      };
    case "inspect_state": {
      rejectUnexpectedProcedureFields(record, INSPECT_STATE_STEP_KEYS, label, filePath);
      const target = readOptionalProcedureString(record.target, `${label}.target`, filePath);
      const query = readOptionalProcedureString(record.query, `${label}.query`, filePath);
      if (!target && !query) {
        throw new Error(`Invalid procedure ${filePath}: ${label} must define target, query, or both.`);
      }

      return {
        ...base,
        kind,
        ...(target ? { target } : {}),
        ...(query ? { query } : {}),
      };
    }
    case "edit_file":
      rejectUnexpectedProcedureFields(record, EDIT_FILE_STEP_KEYS, label, filePath);
      return {
        ...base,
        kind,
        path: readRequiredProcedureString(record.path, `${label}.path`, filePath),
        edit: readRequiredProcedureString(record.edit, `${label}.edit`, filePath),
      };
    case "ask_user":
      rejectUnexpectedProcedureFields(record, ASK_USER_STEP_KEYS, label, filePath);
      return {
        ...base,
        kind,
        prompt: readRequiredProcedureString(record.prompt, `${label}.prompt`, filePath),
      };
    case "invoke_tool":
      rejectUnexpectedProcedureFields(record, INVOKE_TOOL_STEP_KEYS, label, filePath);
      return {
        ...base,
        kind,
        tool: readRequiredProcedureString(record.tool, `${label}.tool`, filePath),
        ...(record.arguments !== undefined
          ? {
              arguments: normalizeProcedureArguments(record.arguments, `${label}.arguments`, filePath),
            }
          : {}),
      };
    case "verify":
      rejectUnexpectedProcedureFields(record, VERIFY_STEP_KEYS, label, filePath);
      return {
        ...base,
        kind,
        checks: readProcedureStringArray(record.checks, `${label}.checks`, filePath, { required: true, minItems: 1 }),
      };
  }
}

/**
 * Normalizes the shared fields carried by every procedure step.
 *
 * @param record - Parsed step object.
 * @param label - Human-readable step label.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Normalized shared step fields.
 */
function normalizeProcedureStepBase(record: Record<string, unknown>, label: string, filePath: string): NormalizedProcedureStepBase {
  return {
    id: readRequiredProcedureString(record.id, `${label}.id`, filePath),
    instruction: readRequiredProcedureString(record.instruction, `${label}.instruction`, filePath),
    ...(record.conditions !== undefined ? { conditions: normalizeProcedureConditions(record.conditions, `${label}.conditions`, filePath) } : {}),
    ...(record.stop_if !== undefined ? { stop_if: normalizeProcedureConditions(record.stop_if, `${label}.stop_if`, filePath) } : {}),
  };
}

/**
 * Normalizes one `invoke_tool.arguments` payload into a stable object.
 *
 * @param value - Raw arguments payload.
 * @param label - Human-readable field label.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Normalized JSON-like arguments object.
 */
function normalizeProcedureArguments(value: unknown, label: string, filePath: string): { [key: string]: ProcedureToolArgumentValue } {
  const record = readProcedureRecord(value, label, filePath);
  return normalizeProcedureToolArgumentValue(record, label, filePath) as {
    [key: string]: ProcedureToolArgumentValue;
  };
}

/**
 * Normalizes one condition list attached to a procedure step.
 *
 * @param value - Raw condition-list field.
 * @param label - Human-readable field label.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Normalized condition list.
 */
function normalizeProcedureConditions(value: unknown, label: string, filePath: string): ProcedureCondition[] {
  return readProcedureRecordArray(value, label, filePath, { required: true, minItems: 1 }).map((record, index) =>
    normalizeProcedureCondition(record, `${label}[${index}]`, filePath),
  );
}

/**
 * Normalizes one bounded declarative condition object.
 *
 * @param record - Parsed condition object.
 * @param label - Human-readable condition label.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Normalized procedure condition.
 */
function normalizeProcedureCondition(record: Record<string, unknown>, label: string, filePath: string): ProcedureCondition {
  const kind = readProcedureConditionKind(record.kind, `${label}.kind`, filePath, PROCEDURE_CONDITION_KINDS);

  switch (kind) {
    case "harness_is":
      rejectUnexpectedProcedureFields(record, HARNESS_CONDITION_KEYS, label, filePath);
      return {
        kind,
        value: readRequiredProcedureString(record.value, `${label}.value`, filePath),
      };
    case "tool_available":
      rejectUnexpectedProcedureFields(record, TOOL_AVAILABLE_CONDITION_KEYS, label, filePath);
      return {
        kind,
        value: readRequiredProcedureString(record.value, `${label}.value`, filePath),
      };
    case "file_exists":
      rejectUnexpectedProcedureFields(record, FILE_EXISTS_CONDITION_KEYS, label, filePath);
      return {
        kind,
        path: readRequiredProcedureString(record.path, `${label}.path`, filePath),
      };
    case "path_exists":
      rejectUnexpectedProcedureFields(record, PATH_EXISTS_CONDITION_KEYS, label, filePath);
      return {
        kind,
        path: readRequiredProcedureString(record.path, `${label}.path`, filePath),
      };
    case "env_flag":
      rejectUnexpectedProcedureFields(record, ENV_FLAG_CONDITION_KEYS, label, filePath);
      return {
        kind,
        name: readRequiredProcedureString(record.name, `${label}.name`, filePath),
        ...(record.value !== undefined ? { value: readRequiredProcedureString(record.value, `${label}.value`, filePath) } : {}),
      };
    case "repo_state":
      rejectUnexpectedProcedureFields(record, REPO_STATE_CONDITION_KEYS, label, filePath);
      return {
        kind,
        value: readRequiredProcedureString(record.value, `${label}.value`, filePath),
      };
    case "user_confirmed":
      rejectUnexpectedProcedureFields(record, USER_CONFIRMED_CONDITION_KEYS, label, filePath);
      return {
        kind,
        value: readRequiredProcedureString(record.value, `${label}.value`, filePath),
      };
  }
}

/**
 * Normalizes one provenance-source list.
 *
 * @param value - Raw source-list field.
 * @param label - Human-readable field label.
 * @param filePath - Human-readable file path used in error messages.
 * @param options - Required/min-items constraints for the source list.
 * @returns Normalized source list.
 */
function normalizeProcedureSources(
  value: unknown,
  label: string,
  filePath: string,
  options: { required?: boolean; minItems?: number } = {},
): ProcedureSource[] {
  return readProcedureRecordArray(value, label, filePath, options).map((record, index) => normalizeProcedureSource(record, `${label}[${index}]`, filePath));
}

/**
 * Normalizes one explicit provenance source object.
 *
 * @param record - Parsed source object.
 * @param label - Human-readable source label.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Normalized procedure source.
 */
function normalizeProcedureSource(record: Record<string, unknown>, label: string, filePath: string): ProcedureSource {
  rejectUnexpectedProcedureFields(record, SOURCE_KEYS, label, filePath);

  const kind = readProcedureSourceKind(record.kind, `${label}.kind`, filePath, PROCEDURE_SOURCE_KINDS);
  const path = readOptionalProcedureString(record.path, `${label}.path`, filePath);
  const locator = readOptionalProcedureString(record.locator, `${label}.locator`, filePath);
  const sourceLabel = readOptionalProcedureString(record.label, `${label}.label`, filePath);

  switch (kind) {
    case "skill":
    case "doc":
    case "repo_file":
      if (!path) {
        throw new Error(`Invalid procedure ${filePath}: ${label}.${kind} sources require a path.`);
      }
      break;
    case "durable":
    case "episode":
      if (!locator) {
        throw new Error(`Invalid procedure ${filePath}: ${label}.${kind} sources require a locator.`);
      }
      break;
    case "manual":
      if (!sourceLabel && !locator) {
        throw new Error(`Invalid procedure ${filePath}: ${label}.manual sources require a label or locator.`);
      }
      break;
  }

  return {
    kind,
    ...(path ? { path } : {}),
    ...(locator ? { locator } : {}),
    ...(sourceLabel ? { label: sourceLabel } : {}),
  };
}
