/**
 * Parses one optional boolean plugin-config field.
 *
 * @param value - Raw field value.
 * @param label - Stable validation label.
 * @param errors - Mutable validation error collection.
 * @returns Boolean value when valid, otherwise `undefined`.
 */
export function normalizeOptionalBoolean(value: unknown, label: string, errors: string[]): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    errors.push(`${label} must be a boolean when provided`);
    return undefined;
  }

  return value;
}

/**
 * Parses one optional positive-integer plugin-config field.
 *
 * @param value - Raw field value.
 * @param label - Stable validation label.
 * @param errors - Mutable validation error collection.
 * @returns Integer value when valid, otherwise `undefined`.
 */
export function normalizeOptionalPositiveInteger(value: unknown, label: string, errors: string[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    errors.push(`${label} must be a positive integer when provided`);
    return undefined;
  }

  return value;
}

/**
 * Parses one optional unit-interval plugin-config field.
 *
 * @param value - Raw field value.
 * @param label - Stable validation label.
 * @param errors - Mutable validation error collection.
 * @returns Numeric value when valid, otherwise `undefined`.
 */
export function normalizeOptionalUnitInterval(value: unknown, label: string, errors: string[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`${label} must be a number between 0 and 1 when provided`);
    return undefined;
  }

  return value;
}
