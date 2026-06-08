import {
  isRecord,
  parseOptionalTrimmedString,
  parseRequiredTrimmedString,
  pushIssue,
  pushUnexpectedFields,
  type ValidationIssue,
} from "../../shared/validation.js";
import { WebApiError } from "../api-error.js";

/** Requires the input be an object and reports unexpected fields. */
export function requireObject(input: unknown, allowedKeys: ReadonlySet<string>): { record: Record<string, unknown>; issues: ValidationIssue[] } {
  if (!isRecord(input)) {
    throw WebApiError.invalid([{ path: "$", message: "Request body must be a JSON object." }]);
  }

  const issues: ValidationIssue[] = [];
  pushUnexpectedFields(input, allowedKeys, "", issues);
  return { record: input, issues };
}

/** Throws a 400 validation error when any issues were collected. */
export function throwIfIssues(issues: ValidationIssue[]): void {
  if (issues.length > 0) {
    throw WebApiError.invalid(issues);
  }
}

/** Reads a trimmed query-string value, applying a builder when present. */
export function readStringParam<T>(params: URLSearchParams, key: string, build: (value: string) => T): T | Record<never, never> {
  const raw = params.get(key)?.trim();
  return raw && raw.length > 0 ? build(raw) : {};
}

/** Reads a comma-separated or repeated query parameter into a string array. */
export function readStringArrayParam(params: URLSearchParams, key: string): string[] {
  const values = params.getAll(key).flatMap((entry) => entry.split(","));
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

/** Wraps a non-empty array under a key, or yields an empty object. */
export function arrayOrEmpty<K extends string>(key: K, values: string[]): Record<K, string[]> | Record<never, never> {
  return values.length > 0 ? ({ [key]: values } as Record<K, string[]>) : {};
}

/** Reads an integer query parameter, reporting malformed values. */
export function readIntParam<T>(params: URLSearchParams, key: string, issues: ValidationIssue[], build: (value: number) => T): T | Record<never, never> {
  const raw = params.get(key)?.trim();
  if (!raw || raw.length === 0) {
    return {};
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    pushIssue(issues, key, "Expected an integer.");
    return {};
  }

  return build(parsed);
}

/** Reads a finite-number query parameter, reporting malformed values. */
export function readNumberParam<T>(params: URLSearchParams, key: string, issues: ValidationIssue[], build: (value: number) => T): T | Record<never, never> {
  const raw = params.get(key)?.trim();
  if (!raw || raw.length === 0) {
    return {};
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    pushIssue(issues, key, "Expected a number.");
    return {};
  }

  return build(parsed);
}

/** Reads an enum query parameter, reporting unsupported values. */
export function readEnumParam<T extends string>(params: URLSearchParams, key: string, allowed: readonly T[], issues: ValidationIssue[]): T | undefined {
  const raw = params.get(key)?.trim();
  if (!raw || raw.length === 0) {
    return undefined;
  }

  if (!(allowed as readonly string[]).includes(raw)) {
    pushIssue(issues, key, `Expected one of: ${allowed.join(", ")}.`);
    return undefined;
  }

  return raw as T;
}

/** Reads a finite-number body field, reporting malformed values. */
export function readNumberField<T>(record: Record<string, unknown>, key: string, issues: ValidationIssue[], build: (value: number) => T): T | Record<never, never> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    pushIssue(issues, key, "Expected a finite number.");
    return {};
  }

  return build(value);
}

/** Reads a trimmed string body field, reporting malformed values. */
export function readStringField<T>(record: Record<string, unknown>, key: string, issues: ValidationIssue[], build: (value: string) => T): T | Record<never, never> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "string") {
    pushIssue(issues, key, "Expected a string.");
    return {};
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? build(trimmed) : {};
}

/** Reads a string body field, preserving empty strings for clear operations. */
export function readStringFieldPreserveEmpty<T>(
  record: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[],
  build: (value: string) => T,
): T | Record<never, never> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "string") {
    pushIssue(issues, key, "Expected a string.");
    return {};
  }

  return build(value.trim());
}

/** Reads a string-array body field, reporting malformed values. */
export function readStringArrayField(record: Record<string, unknown>, key: string, issues: ValidationIssue[]): { tags: string[] } | Record<never, never> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    pushIssue(issues, key, "Expected an array of strings.");
    return {};
  }

  const tags = value.map((entry) => (entry as string).trim()).filter((entry) => entry.length > 0);
  return tags.length > 0 ? { tags } : {};
}

/** Reads a string-array body field, preserving empty arrays for clear operations. */
export function readStringArrayFieldPreserveEmpty<T>(
  record: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[],
  build: (value: string[]) => T,
): T | Record<never, never> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    pushIssue(issues, key, "Expected an array of strings.");
    return {};
  }

  return build(value.map((entry) => (entry as string).trim()).filter((entry) => entry.length > 0));
}

/** Reads an enum body field, reporting unsupported values. */
export function readEnumField<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  issues: ValidationIssue[],
  build: (value: T) => Record<string, T>,
): Record<string, T> | Record<never, never> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  const parsed = readEnumValue(value, key, allowed, issues);
  return parsed ? build(parsed) : {};
}

/** Validates a single enum value, reporting unsupported or wrong-typed input. */
export function readEnumValue<T extends string>(value: unknown, key: string, allowed: readonly T[], issues: ValidationIssue[]): T | undefined {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    pushIssue(issues, key, `Expected one of: ${allowed.join(", ")}.`);
    return undefined;
  }

  return value as T;
}

/** Validates a boolean body field. */
export function readBoolean(value: unknown, key: string, issues: ValidationIssue[]): boolean {
  if (typeof value !== "boolean") {
    pushIssue(issues, key, "Expected a boolean.");
    return false;
  }

  return value;
}

/** Validates an optional string array body field. */
export function readOptionalStringArray(value: unknown, key: string, issues: ValidationIssue[]): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    pushIssue(issues, key, "Expected an array of strings.");
    return [];
  }

  const strings: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      pushIssue(issues, `${key}[${index}]`, "Expected a non-empty string.");
      continue;
    }
    strings.push(entry.trim());
  }

  return strings;
}

export { parseOptionalTrimmedString, parseRequiredTrimmedString, pushIssue };
