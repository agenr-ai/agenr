/**
 * Canonical temporal validity bounds after trimming and validation.
 */
export interface TemporalValidityRange {
  validFrom?: string;
  validTo?: string;
}

/**
 * Structured validation error codes for temporal validity checks.
 */
export type TemporalValidityIssueCode = "invalid_valid_from" | "invalid_valid_to" | "invalid_range";

/**
 * Result of validating optional temporal validity bounds.
 */
export type TemporalValidityValidationResult =
  | {
      ok: true;
      value: TemporalValidityRange;
    }
  | {
      ok: false;
      code: TemporalValidityIssueCode;
      message: string;
    };

/**
 * Validates and normalizes one optional temporal validity range.
 *
 * Empty strings normalize to absence. When both bounds are present, the range
 * must be strictly ordered so one entry cannot become invalid at the same
 * instant it becomes valid.
 *
 * @param validFrom - Optional lower validity bound.
 * @param validTo - Optional upper validity bound.
 * @returns Normalized bounds or one structured validation issue.
 */
export function validateTemporalValidityRange(validFrom?: string | null, validTo?: string | null): TemporalValidityValidationResult {
  const normalizedValidFrom = normalizeOptionalTimestamp(validFrom);
  if (validFrom !== undefined && validFrom !== null && normalizedValidFrom === null) {
    return {
      ok: false,
      code: "invalid_valid_from",
      message: "valid_from must be a valid ISO 8601 timestamp.",
    };
  }

  const normalizedValidTo = normalizeOptionalTimestamp(validTo);
  if (validTo !== undefined && validTo !== null && normalizedValidTo === null) {
    return {
      ok: false,
      code: "invalid_valid_to",
      message: "valid_to must be a valid ISO 8601 timestamp.",
    };
  }

  if (
    normalizedValidFrom !== undefined &&
    normalizedValidFrom !== null &&
    normalizedValidTo !== undefined &&
    normalizedValidTo !== null &&
    Date.parse(normalizedValidFrom) >= Date.parse(normalizedValidTo)
  ) {
    return {
      ok: false,
      code: "invalid_range",
      message: "valid_from must be earlier than valid_to.",
    };
  }

  const validFromValue = normalizedValidFrom ?? undefined;
  const validToValue = normalizedValidTo ?? undefined;

  return {
    ok: true,
    value: {
      validFrom: validFromValue,
      validTo: validToValue,
    },
  };
}

/**
 * Trims one optional timestamp-like string and verifies it parses as an
 * ISO-shaped instant.
 *
 * @param value - Raw optional timestamp input.
 * @returns Trimmed timestamp, undefined when absent, or null when invalid.
 */
function normalizeOptionalTimestamp(value?: string | null): string | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  if (!normalized.includes("T") || Number.isNaN(Date.parse(normalized))) {
    return null;
  }

  return normalized;
}
