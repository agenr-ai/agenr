/**
 * Structured validation issue emitted at an adapter boundary.
 */
export interface ValidationIssue {
  /** Dot-path pointing to the invalid field. */
  path: string;
  /** Human-readable explanation of the validation failure. */
  message: string;
}

/**
 * Integer-range bounds used by adapter scalar parsers.
 */
export interface IntegerRangeBounds {
  /** Inclusive minimum accepted value when present. */
  min?: number;
  /** Inclusive maximum accepted value when present. */
  max?: number;
  /** Optional custom validation message. */
  message?: string;
}

/**
 * Checks whether a raw value is a string-keyed object.
 *
 * @param value - Candidate value to inspect.
 * @returns True when the value is a non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Appends one structured validation issue to the collector.
 *
 * @param issues - Mutable validation issue collection.
 * @param path - Stable path to the invalid field.
 * @param message - Human-readable validation failure message.
 */
export function pushIssue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

/**
 * Records unsupported object keys so adapter contracts stay narrow.
 *
 * @param value - Parsed object to inspect.
 * @param allowedKeys - Exact field names accepted at the boundary.
 * @param basePath - Prefix prepended to emitted issue paths.
 * @param issues - Mutable validation issue collection.
 */
export function pushUnexpectedFields(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>, basePath: string, issues: ValidationIssue[]): void {
  for (const key of Object.keys(value)) {
    if (allowedKeys.has(key)) {
      continue;
    }

    pushIssue(issues, joinPath(basePath, key), "Unexpected field.");
  }
}

/**
 * Parses one required non-empty trimmed string field.
 *
 * @param value - Raw field value.
 * @param path - Stable path to the field.
 * @param issues - Mutable validation issue collection.
 * @param message - Optional validation failure message override.
 * @returns Trimmed string when valid, otherwise `undefined`.
 */
export function parseRequiredTrimmedString(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  message = "Expected a non-empty string.",
): string | undefined {
  if (typeof value !== "string") {
    pushIssue(issues, path, message);
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    pushIssue(issues, path, message);
    return undefined;
  }

  return normalized;
}

/**
 * Parses one optional non-empty trimmed string field.
 *
 * @param value - Raw field value.
 * @param path - Stable path to the field.
 * @param issues - Mutable validation issue collection.
 * @param typeMessage - Validation message used for non-string values.
 * @param emptyMessage - Validation message used for empty strings.
 * @returns Trimmed string when valid, otherwise `undefined`.
 */
export function parseOptionalTrimmedString(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  typeMessage = "Expected a string.",
  emptyMessage = "Expected a non-empty string.",
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    pushIssue(issues, path, typeMessage);
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    pushIssue(issues, path, emptyMessage);
    return undefined;
  }

  return normalized;
}

/**
 * Parses one optional boolean field.
 *
 * @param value - Raw field value.
 * @param path - Stable path to the field.
 * @param issues - Mutable validation issue collection.
 * @param message - Optional validation failure message override.
 * @returns Boolean value when valid, otherwise `undefined`.
 */
export function parseOptionalBoolean(value: unknown, path: string, issues: ValidationIssue[], message = "Expected a boolean."): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    pushIssue(issues, path, message);
    return undefined;
  }

  return value;
}

/**
 * Parses one optional integer constrained by inclusive bounds.
 *
 * @param value - Raw field value.
 * @param path - Stable path to the field.
 * @param issues - Mutable validation issue collection.
 * @param bounds - Inclusive integer bounds and optional message override.
 * @returns Integer value when valid, otherwise `undefined`.
 */
export function parseOptionalIntegerInRange(value: unknown, path: string, issues: ValidationIssue[], bounds: IntegerRangeBounds): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    pushIssue(issues, path, integerRangeMessage(bounds));
    return undefined;
  }

  if (bounds.min !== undefined && value < bounds.min) {
    pushIssue(issues, path, integerRangeMessage(bounds));
    return undefined;
  }

  if (bounds.max !== undefined && value > bounds.max) {
    pushIssue(issues, path, integerRangeMessage(bounds));
    return undefined;
  }

  return value;
}

/**
 * Parses one optional ISO-like timestamp string.
 *
 * @param value - Raw field value.
 * @param path - Stable path to the field.
 * @param issues - Mutable validation issue collection.
 * @param message - Optional validation failure message override.
 * @returns Trimmed timestamp string when valid, otherwise `undefined`.
 */
export function parseOptionalTimestampString(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  message = "Expected a valid timestamp string.",
): string | undefined {
  const timestamp = parseOptionalTrimmedString(value, path, issues);
  if (timestamp === undefined) {
    return undefined;
  }

  if (Number.isNaN(Date.parse(timestamp))) {
    pushIssue(issues, path, message);
    return undefined;
  }

  return timestamp;
}

/**
 * Joins an optional parent path and field key into one stable issue path.
 *
 * @param basePath - Optional parent path.
 * @param key - Field name to append.
 * @returns Joined validation path.
 */
function joinPath(basePath: string, key: string): string {
  return basePath.length > 0 ? `${basePath}.${key}` : key;
}

/**
 * Builds a stable integer-range validation message.
 *
 * @param bounds - Inclusive integer bounds and optional override.
 * @returns Human-readable validation failure message.
 */
function integerRangeMessage(bounds: IntegerRangeBounds): string {
  if (bounds.message) {
    return bounds.message;
  }

  if (bounds.min === 0 && bounds.max === undefined) {
    return "Expected a non-negative integer.";
  }

  if (bounds.min === 1 && bounds.max === undefined) {
    return "Expected a positive integer.";
  }

  if (bounds.min !== undefined && bounds.max !== undefined) {
    return `Expected an integer from ${bounds.min} to ${bounds.max}.`;
  }

  if (bounds.min !== undefined) {
    return `Expected an integer greater than or equal to ${bounds.min}.`;
  }

  if (bounds.max !== undefined) {
    return `Expected an integer less than or equal to ${bounds.max}.`;
  }

  return "Expected an integer.";
}
