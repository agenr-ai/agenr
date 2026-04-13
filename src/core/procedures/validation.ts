import { parseDocument } from "yaml";

import type { ProcedureConditionKind, ProcedureSourceKind, ProcedureStepKind, ProcedureToolArgumentValue } from "../types.js";

/**
 * Parses one procedure YAML source file into plain JavaScript data.
 *
 * @param sourceText - Raw YAML source text.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Parsed authoring payload as plain JavaScript values.
 */
export function parseProcedureYaml(sourceText: string, filePath: string): unknown {
  const document = parseDocument(sourceText, {
    merge: false,
    prettyErrors: true,
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    const [firstError] = document.errors;
    throw new Error(`Invalid procedure ${filePath}: ${firstError?.message ?? "YAML parsing failed."}`);
  }

  return document.toJS({ maxAliasCount: 0 });
}

/**
 * Reads one raw value as a plain object and rejects arrays or null values.
 *
 * @param value - Raw candidate value.
 * @param label - Human-readable label used in error messages.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Parsed object.
 */
export function readProcedureRecord(value: unknown, label: string, filePath: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid procedure ${filePath}: ${label} must be an object.`);
  }

  return value;
}

/**
 * Rejects unsupported keys on a parsed procedure object.
 *
 * @param record - Parsed object to inspect.
 * @param allowedKeys - Exact keys accepted for the object.
 * @param label - Human-readable object label.
 * @param filePath - Human-readable file path used in error messages.
 */
export function rejectUnexpectedProcedureFields(record: Record<string, unknown>, allowedKeys: ReadonlySet<string>, label: string, filePath: string): void {
  const unexpected = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unexpected.length === 0) {
    return;
  }

  throw new Error(`Invalid procedure ${filePath}: ${label} contains unsupported field "${unexpected[0]}".`);
}

/**
 * Reads one required non-empty string field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Trimmed non-empty string.
 */
export function readRequiredProcedureString(value: unknown, label: string, filePath: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid procedure ${filePath}: ${label} must be a non-empty string.`);
  }

  const normalized = normalizeWhitespace(value);
  if (normalized.length === 0) {
    throw new Error(`Invalid procedure ${filePath}: ${label} must be a non-empty string.`);
  }

  return normalized;
}

/**
 * Reads one optional string field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Trimmed string when present.
 */
export function readOptionalProcedureString(value: unknown, label: string, filePath: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredProcedureString(value, label, filePath);
}

/**
 * Reads one string array field while trimming each item.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Human-readable file path used in error messages.
 * @param options - Array-shape requirements.
 * @returns Normalized string array.
 */
export function readProcedureStringArray(value: unknown, label: string, filePath: string, options: { required?: boolean; minItems?: number } = {}): string[] {
  if (value === undefined) {
    if (options.required) {
      throw new Error(`Invalid procedure ${filePath}: ${label} must be an array.`);
    }

    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid procedure ${filePath}: ${label} must be an array.`);
  }

  const normalized = value.map((item, index) => readRequiredProcedureString(item, `${label}[${index}]`, filePath));
  if (options.minItems !== undefined && normalized.length < options.minItems) {
    throw new Error(`Invalid procedure ${filePath}: ${label} must contain at least ${options.minItems} item(s).`);
  }

  return normalized;
}

/**
 * Reads one array of plain objects.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Human-readable file path used in error messages.
 * @param options - Array-shape requirements.
 * @returns Parsed object array.
 */
export function readProcedureRecordArray(
  value: unknown,
  label: string,
  filePath: string,
  options: { required?: boolean; minItems?: number } = {},
): Array<Record<string, unknown>> {
  if (value === undefined) {
    if (options.required) {
      throw new Error(`Invalid procedure ${filePath}: ${label} must be an array.`);
    }

    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid procedure ${filePath}: ${label} must be an array.`);
  }

  const records = value.map((item, index) => readProcedureRecord(item, `${label}[${index}]`, filePath));
  if (options.minItems !== undefined && records.length < options.minItems) {
    throw new Error(`Invalid procedure ${filePath}: ${label} must contain at least ${options.minItems} item(s).`);
  }

  return records;
}

/**
 * Reads one supported procedure step kind.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Human-readable file path used in error messages.
 * @param supportedKinds - Closed union of accepted kinds.
 * @returns Validated step kind.
 */
export function readProcedureStepKind(value: unknown, label: string, filePath: string, supportedKinds: readonly ProcedureStepKind[]): ProcedureStepKind {
  const normalized = readRequiredProcedureString(value, label, filePath);
  if (!supportedKinds.includes(normalized as ProcedureStepKind)) {
    throw new Error(`Invalid procedure ${filePath}: ${label} has unsupported step kind "${normalized}".`);
  }

  return normalized as ProcedureStepKind;
}

/**
 * Reads one supported procedure condition kind.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Human-readable file path used in error messages.
 * @param supportedKinds - Closed union of accepted kinds.
 * @returns Validated condition kind.
 */
export function readProcedureConditionKind(
  value: unknown,
  label: string,
  filePath: string,
  supportedKinds: readonly ProcedureConditionKind[],
): ProcedureConditionKind {
  const normalized = readRequiredProcedureString(value, label, filePath);
  if (!supportedKinds.includes(normalized as ProcedureConditionKind)) {
    throw new Error(`Invalid procedure ${filePath}: ${label} has unsupported condition kind "${normalized}".`);
  }

  return normalized as ProcedureConditionKind;
}

/**
 * Reads one supported procedure source kind.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Human-readable file path used in error messages.
 * @param supportedKinds - Closed union of accepted kinds.
 * @returns Validated source kind.
 */
export function readProcedureSourceKind(value: unknown, label: string, filePath: string, supportedKinds: readonly ProcedureSourceKind[]): ProcedureSourceKind {
  const normalized = readRequiredProcedureString(value, label, filePath);
  if (!supportedKinds.includes(normalized as ProcedureSourceKind)) {
    throw new Error(`Invalid procedure ${filePath}: ${label} has unsupported source kind "${normalized}".`);
  }

  return normalized as ProcedureSourceKind;
}

/**
 * Normalizes one `invoke_tool.arguments` payload into stable JSON-like data.
 *
 * @param value - Raw argument value.
 * @param label - Human-readable field label.
 * @param filePath - Human-readable file path used in error messages.
 * @returns Normalized JSON-like payload.
 */
export function normalizeProcedureToolArgumentValue(value: unknown, label: string, filePath: string): ProcedureToolArgumentValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid procedure ${filePath}: ${label} must not contain non-finite numbers.`);
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeProcedureToolArgumentValue(item, `${label}[${index}]`, filePath));
  }

  if (!isRecord(value)) {
    throw new Error(`Invalid procedure ${filePath}: ${label} must be JSON-like data.`);
  }

  const normalizedEntries = Object.entries(value)
    .map(([key, entryValue]) => {
      const normalizedKey = key.trim();
      if (normalizedKey.length === 0) {
        throw new Error(`Invalid procedure ${filePath}: ${label} must not contain blank object keys.`);
      }

      return [normalizedKey, normalizeProcedureToolArgumentValue(entryValue, `${label}.${normalizedKey}`, filePath)] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.fromEntries(normalizedEntries);
}

/**
 * Checks whether one raw value is a plain object.
 *
 * @param value - Candidate value to inspect.
 * @returns True when the value is a non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collapses internal whitespace and trims one string field.
 *
 * @param value - Raw string input.
 * @returns Normalized single-line string.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
