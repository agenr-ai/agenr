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
 * Decides whether a durable's valid-time window contains a given instant.
 *
 * This implements the valid-time half of the bi-temporal as-of contract:
 * an entry is "valid as of" an instant when the instant is at or after its
 * lower bound and at or before its upper bound. Open bounds are treated as
 * unbounded, and unparseable bounds are ignored rather than excluding the row,
 * so malformed data never silently hides a memory.
 *
 * Boundaries are inclusive. An entry whose `valid_to` equals the as-of instant
 * is still considered valid at that instant; it becomes invalid only once the
 * instant moves strictly past `valid_to`. The same inclusive rule applies to
 * `valid_from`.
 *
 * @param validFrom - Optional lower validity bound in ISO format.
 * @param validTo - Optional upper validity bound in ISO format.
 * @param asOfMs - Reference instant in epoch milliseconds (valid time).
 * @returns True when the window contains the instant or has no usable bounds.
 */
export function isWithinValidityWindow(validFrom: string | undefined | null, validTo: string | undefined | null, asOfMs: number): boolean {
  const fromMs = parseInstantMs(validFrom);
  if (fromMs !== null && asOfMs < fromMs) {
    // The entry has not yet become valid at the reference instant.
    return false;
  }

  const toMs = parseInstantMs(validTo);
  if (toMs !== null && asOfMs > toMs) {
    // The entry's validity has expired before the reference instant.
    return false;
  }

  return true;
}

/**
 * Parses an optional ISO timestamp into epoch milliseconds.
 *
 * @param value - Raw optional timestamp input.
 * @returns Epoch milliseconds, or null when absent or unparseable.
 */
function parseInstantMs(value?: string | null): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return parsed;
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
