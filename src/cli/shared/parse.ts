import { InvalidArgumentError } from "commander";

/**
 * Parsed provider/model reference accepted by CLI model override flags.
 */
export interface ParsedModelRef {
  provider?: string;
  modelId: string;
}

/**
 * Normalizes optional strings into trimmed values.
 *
 * @param value - Candidate string input.
 * @returns Trimmed string, or undefined when blank.
 */
export function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalizes repeated string flags into a trimmed de-duplicated list.
 *
 * @param values - Candidate repeated values.
 * @returns Ordered unique trimmed values, or undefined when no values remain.
 */
export function normalizeStringList(values: readonly string[] | undefined): string[] | undefined {
  const normalizedValues: string[] = [];
  const seen = new Set<string>();

  for (const value of values ?? []) {
    const normalized = normalizeOptionalString(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    normalizedValues.push(normalized);
  }

  return normalizedValues.length > 0 ? normalizedValues : undefined;
}

/**
 * Collects one repeated commander option value after trimming whitespace.
 *
 * @param value - Raw commander option value.
 * @param previous - Previously collected option values.
 * @returns Updated ordered list of collected values.
 */
export function collectStringValue(value: string, previous: string[] | undefined): string[] {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new InvalidArgumentError("Value cannot be empty.");
  }

  return [...(previous ?? []), normalized];
}

/**
 * Parses a comma-separated CLI list into trimmed non-empty unique values.
 *
 * @param value - Raw commander option text.
 * @returns Normalized list of string values.
 */
export function parseCsvList(value: string): string[] {
  const parsed = normalizeStringList(value.split(","));
  if (!parsed) {
    throw new InvalidArgumentError("Expected at least one comma-separated value.");
  }

  return parsed;
}

/**
 * Parses a strictly positive integer CLI option.
 *
 * @param value - Raw commander option text.
 * @returns Parsed integer value.
 */
export function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive integer.");
  }

  return parsed;
}

/**
 * Parses a non-negative integer CLI option.
 *
 * @param value - Raw commander option text.
 * @returns Parsed integer value.
 */
export function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Value must be a non-negative integer.");
  }

  return parsed;
}

/**
 * Parses an integer constrained to one inclusive numeric range.
 *
 * @param value - Raw commander option text.
 * @param label - Human-readable option label used in error messages.
 * @param min - Inclusive minimum allowed value.
 * @param max - Inclusive maximum allowed value.
 * @returns Parsed integer within the requested range.
 */
export function parseIntegerInRange(value: string, label: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new InvalidArgumentError(`${label} must be an integer.`);
  }

  if (parsed < min || parsed > max) {
    throw new InvalidArgumentError(`${label} must be between ${min} and ${max}.`);
  }

  return parsed;
}

/**
 * Parses a strictly positive numeric CLI option.
 *
 * @param value - Raw commander option text.
 * @returns Parsed numeric value.
 */
export function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive number.");
  }

  return parsed;
}

/**
 * Parses a unit-interval numeric CLI option.
 *
 * @param value - Raw commander option text.
 * @returns Parsed number in the inclusive 0-1 range.
 */
export function parseUnitInterval(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError("Value must be between 0 and 1.");
  }

  return parsed;
}

/**
 * Parses one provider/model reference or bare model ID from the CLI.
 *
 * @param value - Raw commander option text.
 * @returns Parsed model reference with an optional provider override.
 */
export function parseModelRef(value: string): ParsedModelRef {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new InvalidArgumentError("Model reference cannot be empty.");
  }

  const separatorIndex = normalized.indexOf("/");
  if (separatorIndex < 0) {
    return {
      modelId: normalized,
    };
  }

  const provider = normalizeOptionalString(normalized.slice(0, separatorIndex));
  const modelId = normalizeOptionalString(normalized.slice(separatorIndex + 1));
  if (!provider || !modelId) {
    throw new InvalidArgumentError(`Model reference must look like "provider/model" or "model". Received: ${value}.`);
  }

  return {
    provider,
    modelId,
  };
}
