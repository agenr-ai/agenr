import { ENTRY_TYPES, EXPIRY_LEVELS, type EntryType, type Expiry } from "../../core/types.js";
import { formatErrorMessage } from "./errors.js";

export { formatErrorMessage };

/**
 * Human-readable guidance shown in store tool schemas.
 */
const ENTRY_TYPE_DESCRIPTION =
  "Knowledge type to store. Use fact for durable truth about a person, system, place, or how something works. Use decision for a standing rule, constraint, policy, or chosen approach future sessions should follow - not a progress update or completed action. Use preference for what someone likes, wants, values, or wants avoided. Use lesson for a non-obvious takeaway learned from experience that should change future behavior. Use milestone for a rare one-time event with durable future significance - not ordinary execution progress. Use relationship for a meaningful durable connection between people, groups, or systems.";

/**
 * Human-readable guidance shown in expiry-related tool schemas.
 */
const EXPIRY_DESCRIPTION =
  "Lifetime bucket: core (always injected at session start, use sparingly), permanent (durable and recalled on demand), or temporary (short-horizon).";

/**
 * Human-readable guidance shown in update tool schemas.
 */
const UPDATE_EXPIRY_DESCRIPTION = `${EXPIRY_DESCRIPTION} Accepted values: ${EXPIRY_LEVELS.join(", ")}.`;

/**
 * Supported recall-mode values accepted by host memory tools.
 */
const RECALL_MODES = ["auto", "entries", "episodes", "procedures"] as const;

export { ENTRY_TYPE_DESCRIPTION, EXPIRY_DESCRIPTION, RECALL_MODES, UPDATE_EXPIRY_DESCRIPTION };

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
 * Parses optional recall/store type filters into validated agenr entry types.
 *
 * @param values - Candidate entry-type strings.
 * @returns Validated entry types.
 */
export function parseEntryTypes(values: string[] | undefined): EntryType[] {
  return normalizeStringArray(values).map((value) => parseEntryType(value));
}

/**
 * Parses one entry type string into the agenr domain union.
 *
 * @param value - Candidate entry type.
 * @returns Validated entry type.
 */
export function parseEntryType(value: string): EntryType {
  if (ENTRY_TYPES.includes(value as EntryType)) {
    return value as EntryType;
  }

  throw new Error(`Unsupported entry type "${value}".`);
}

/**
 * Parses the optional unified recall mode parameter.
 *
 * @param value - Candidate recall mode.
 * @returns Validated recall mode, or undefined when absent.
 */
export function parseRecallMode(value: string | undefined): (typeof RECALL_MODES)[number] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (RECALL_MODES.includes(value as (typeof RECALL_MODES)[number])) {
    return value as (typeof RECALL_MODES)[number];
  }

  throw new Error(`Unsupported recall mode "${value}".`);
}

/**
 * Normalizes optional string arrays by trimming, deduplicating, and dropping empties.
 *
 * @param values - Candidate string values.
 * @returns Normalized string list.
 */
export function normalizeStringArray(values: string[] | undefined): string[] {
  if (!values) {
    return [];
  }

  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
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

/** Sanitizes fetch parameters before debug logging. */
export function sanitizeFetchToolParams(params: { id: string | undefined; subject: string | undefined }): Record<string, unknown> {
  return {
    ...(params.id ? { id: params.id } : {}),
    ...(params.subject ? { subject: params.subject } : {}),
  };
}
