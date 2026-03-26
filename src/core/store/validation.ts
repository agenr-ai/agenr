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
 * Validates and normalizes store inputs before they enter the write pipeline.
 *
 * @param inputs - Candidate entries to validate.
 * @returns Accepted entries plus aggregate rejection metadata.
 */
export function validateEntries(inputs: StoreEntryInput[]): ValidationResult {
  const valid: StoreEntryInput[] = [];
  const errors: string[] = [];

  for (const [index, input] of inputs.entries()) {
    const subject = normalizeString(input.subject);
    const content = normalizeString(input.content);

    if (!ENTRY_TYPES.includes(input.type)) {
      errors.push(`Entry ${index} has an invalid type.`);
      continue;
    }

    if (subject.length === 0) {
      errors.push(`Entry ${index} is missing a subject.`);
      continue;
    }

    if (content.length === 0) {
      errors.push(`Entry ${index} is missing content.`);
      continue;
    }

    if (input.expiry !== undefined && !EXPIRY_LEVELS.includes(input.expiry)) {
      errors.push(`Entry ${index} has an invalid expiry.`);
      continue;
    }

    if (input.tags !== undefined && !areValidTags(input.tags)) {
      errors.push(`Entry ${index} has invalid tags.`);
      continue;
    }

    if (input.importance !== undefined && !Number.isFinite(input.importance)) {
      errors.push(`Entry ${index} has an invalid importance.`);
      continue;
    }

    valid.push({
      type: input.type,
      subject,
      content,
      importance: clampImportance(input.importance),
      expiry: (input.expiry ?? "temporary") as Expiry,
      tags: normalizeTags(input.tags),
      source_file: normalizeOptionalString(input.source_file),
      source_context: normalizeOptionalString(input.source_context),
    });
  }

  return {
    valid,
    rejected: errors.length,
    errors,
  };
}

function clampImportance(value?: number): number {
  if (value === undefined) {
    return 7;
  }

  return Math.min(10, Math.max(1, Math.round(value)));
}

function normalizeString(value: string): string {
  return value.trim();
}

function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function areValidTags(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((tag) => typeof tag === "string");
}

function normalizeTags(tags?: string[]): string[] {
  if (!tags) {
    return [];
  }

  return tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
}
