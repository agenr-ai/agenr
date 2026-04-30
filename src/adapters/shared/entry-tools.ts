import { EXPIRY_LEVELS, type Expiry } from "../../core/types.js";

/**
 * Human-readable guidance shown in expiry-related tool schemas.
 */
const EXPIRY_DESCRIPTION =
  "Lifetime bucket: core (always injected at session start, use sparingly), permanent (durable and recalled on demand), or temporary (short-horizon).";

/**
 * Human-readable guidance shown in update tool schemas.
 */
const UPDATE_EXPIRY_DESCRIPTION = `${EXPIRY_DESCRIPTION} Accepted values: ${EXPIRY_LEVELS.join(", ")}.`;

export { EXPIRY_DESCRIPTION, UPDATE_EXPIRY_DESCRIPTION };

/**
 * Guards untrusted tool parameters and narrows them to a string-keyed object.
 *
 * @param value - Raw tool parameter payload.
 * @returns Object-like parameter payload.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error("Tool parameters must be an object.");
}

/**
 * Normalizes unknown tool failures into human-readable messages.
 *
 * @param error - Unknown failure value.
 * @returns Human-readable error message.
 */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Parses an optional expiry string into the agenr domain union.
 *
 * @param value - Candidate expiry value.
 * @returns Validated expiry value, or undefined when absent.
 */
export function parseExpiry(value: string | undefined): Expiry | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (EXPIRY_LEVELS.includes(value as Expiry)) {
    return value as Expiry;
  }

  throw new Error(`Unsupported expiry "${value}".`);
}

/**
 * Formats a compact id-or-subject selector summary for tool call logs.
 *
 * @param id - Optional entry id.
 * @param subject - Optional entry subject.
 * @param last - Optional "last entry" selector.
 * @returns Log-friendly selector description.
 */
export function formatTargetSelector(id?: string, subject?: string, last?: boolean): string {
  if (last === true) {
    return "last";
  }

  if (id) {
    return `id:${JSON.stringify(id)}`;
  }

  if (subject) {
    return `subject:${JSON.stringify(subject)}`;
  }

  return "unknown";
}

/**
 * Sanitizes update parameters before debug logging.
 *
 * @param params - Parsed update-tool parameters.
 * @returns Redacted log payload.
 */
export function sanitizeUpdateToolParams(params: {
  id: string | undefined;
  subject: string | undefined;
  importance: number | undefined;
  expiry: Expiry | undefined;
  claimKey: string | undefined;
  validFrom: string | undefined;
  validTo: string | undefined;
}): Record<string, unknown> {
  return {
    ...(params.id ? { id: params.id } : {}),
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.importance !== undefined ? { importance: params.importance } : {}),
    ...(params.expiry !== undefined ? { expiry: params.expiry } : {}),
    ...(params.claimKey !== undefined ? { hasClaimKey: true } : {}),
    ...(params.validFrom !== undefined ? { hasValidFrom: true } : {}),
    ...(params.validTo !== undefined ? { hasValidTo: true } : {}),
  };
}
