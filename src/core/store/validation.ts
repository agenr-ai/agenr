import { CLAIM_SUPPORT_MODES, ENTRY_TYPES, EXPIRY_LEVELS, type Expiry, type StoreEntryInput } from "../types.js";
import { describeClaimKeyNormalizationFailure, normalizeClaimKey } from "../claim-key.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Result of validating a batch of store inputs.
 */
export interface ValidationResult {
  valid: StoreEntryInput[];
  rejected: number;
  errors: string[];
  warnings: string[];
}

/**
 * Validated store input paired with its original array index.
 */
export interface IndexedValidEntry {
  inputIndex: number;
  input: StoreEntryInput;
}

/**
 * Result of validating a batch while preserving input indexes.
 */
export interface IndexedValidationResult {
  valid: IndexedValidEntry[];
  rejected: number;
  rejectedInputIndexes: number[];
  errors: string[];
  warnings: string[];
}

/**
 * Validates and normalizes store inputs before they enter the write pipeline.
 *
 * @param inputs - Candidate entries to validate.
 * @returns Accepted entries plus aggregate rejection metadata.
 */
export function validateEntries(inputs: StoreEntryInput[]): ValidationResult {
  const validation = validateEntriesWithIndexes(inputs);

  return {
    valid: validation.valid.map(({ input }) => input),
    rejected: validation.rejected,
    errors: validation.errors,
    warnings: validation.warnings,
  };
}

/**
 * Validates and normalizes store inputs while preserving their original indexes.
 *
 * @param inputs - Candidate entries to validate.
 * @returns Accepted entries, rejected indexes, and validation errors.
 */
export function validateEntriesWithIndexes(inputs: StoreEntryInput[]): IndexedValidationResult {
  const valid: IndexedValidEntry[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const rejectedInputIndexes: number[] = [];

  for (const [index, input] of inputs.entries()) {
    const subject = normalizeString(input.subject);
    const content = normalizeString(input.content);

    if (!ENTRY_TYPES.includes(input.type)) {
      errors.push(`Entry ${index} has an invalid type.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (subject.length === 0) {
      errors.push(`Entry ${index} is missing a subject.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (content.length === 0) {
      errors.push(`Entry ${index} is missing content.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (input.expiry !== undefined && !EXPIRY_LEVELS.includes(input.expiry)) {
      errors.push(`Entry ${index} has an invalid expiry.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (input.tags !== undefined && !areValidTags(input.tags)) {
      errors.push(`Entry ${index} has invalid tags.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (input.importance !== undefined && !Number.isFinite(input.importance)) {
      errors.push(`Entry ${index} has an invalid importance.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (input.supersedes !== undefined && !isUuid(input.supersedes)) {
      errors.push(`Entry ${index} has an invalid supersedes id.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (input.valid_from !== undefined && !isIsoTimestamp(input.valid_from)) {
      errors.push(`Entry ${index} has an invalid valid_from timestamp.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (input.valid_to !== undefined && !isIsoTimestamp(input.valid_to)) {
      errors.push(`Entry ${index} has an invalid valid_to timestamp.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    let normalizedClaimKey: string | undefined;
    if (input.claim_key !== undefined) {
      if (typeof input.claim_key !== "string") {
        warnings.push(`Entry ${index} provided a non-string claim key and it was dropped.`);
      } else {
        const claimKey = normalizeClaimKey(input.claim_key);
        if (claimKey.ok) {
          normalizedClaimKey = claimKey.value.claimKey;
        } else {
          warnings.push(
            `Entry ${index} provided invalid claim key ${JSON.stringify(input.claim_key)} and it was dropped: ${describeClaimKeyNormalizationFailure(claimKey.reason)}.`,
          );
        }
      }
    }

    const claimKeyRaw = normalizedClaimKey ? normalizeOptionalString(input.claim_key_raw) : undefined;
    const claimSupportSourceKind = normalizedClaimKey ? normalizeOptionalString(input.claim_support_source_kind) : undefined;
    const claimSupportLocator = normalizedClaimKey ? normalizeOptionalString(input.claim_support_locator) : undefined;
    const claimSupportObservedAt =
      normalizedClaimKey && input.claim_support_observed_at !== undefined
        ? normalizeClaimSupportObservedAt(input.claim_support_observed_at, index, warnings)
        : undefined;
    const claimSupportMode =
      normalizedClaimKey && input.claim_support_mode !== undefined ? normalizeClaimSupportMode(input.claim_support_mode, index, warnings) : undefined;

    valid.push({
      inputIndex: index,
      input: {
        type: input.type,
        subject,
        content,
        importance: clampImportance(input.importance),
        expiry: (input.expiry ?? "temporary") as Expiry,
        tags: normalizeTags(input.tags),
        source_file: normalizeOptionalString(input.source_file),
        source_context: normalizeOptionalString(input.source_context),
        user_id: normalizeOptionalString(input.user_id),
        project: normalizeOptionalString(input.project),
        created_at: normalizeOptionalString(input.created_at),
        supersedes: normalizeOptionalString(input.supersedes),
        claim_key: normalizedClaimKey,
        claim_key_raw: claimKeyRaw,
        claim_support_source_kind: claimSupportSourceKind,
        claim_support_locator: claimSupportLocator,
        claim_support_observed_at: claimSupportObservedAt,
        claim_support_mode: claimSupportMode,
        valid_from: normalizeOptionalString(input.valid_from),
        valid_to: normalizeOptionalString(input.valid_to),
      },
    });
  }

  return {
    valid,
    rejected: errors.length,
    rejectedInputIndexes,
    errors,
    warnings,
  };
}

/** Clamps optional importance values into the supported 1-10 range. */
function clampImportance(value?: number): number {
  if (value === undefined) {
    return 7;
  }

  return Math.min(10, Math.max(1, Math.round(value)));
}

/** Trims required string fields during validation. */
function normalizeString(value: string): string {
  return value.trim();
}

/** Trims optional string fields and drops empty results. */
function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/** Validates one optional claim-support observation timestamp. */
function normalizeClaimSupportObservedAt(value: string, index: number, warnings: string[]): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }

  if (!isIsoTimestamp(normalized)) {
    warnings.push(`Entry ${index} provided invalid claim_support_observed_at ${JSON.stringify(value)} and it was dropped.`);
    return undefined;
  }

  return normalized;
}

/** Validates one optional claim-support provenance mode. */
function normalizeClaimSupportMode(value: StoreEntryInput["claim_support_mode"], index: number, warnings: string[]): StoreEntryInput["claim_support_mode"] {
  if (value && CLAIM_SUPPORT_MODES.includes(value)) {
    return value;
  }

  warnings.push(`Entry ${index} provided invalid claim_support_mode ${JSON.stringify(value)} and it was dropped.`);
  return undefined;
}

/** Checks whether a value is an array of string tags. */
function areValidTags(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((tag) => typeof tag === "string");
}

/** Trims tags and removes empty tag values. */
function normalizeTags(tags?: string[]): string[] {
  if (!tags) {
    return [];
  }

  return tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
}

/** Returns whether an optional id string matches the UUID format used by agenr entry ids. */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

/** Returns whether a timestamp string looks like a valid ISO 8601 instant. */
function isIsoTimestamp(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.includes("T") && !Number.isNaN(Date.parse(normalized));
}
