import { ENTRY_TYPES, EXPIRY_LEVELS, type Expiry, type StoreEntryInput } from "../types.js";

/**
 * Result of validating a batch of store inputs.
 */
export interface ValidationResult {
  valid: StoreEntryInput[];
  rejected: number;
  errors: string[];
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
        created_at: normalizeOptionalString(input.created_at),
      },
    });
  }

  return {
    valid,
    rejected: errors.length,
    rejectedInputIndexes,
    errors,
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
