import {
  defaultDirectiveTrigger,
  MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX,
  normalizeMemoryDirectiveClaimKey,
  parseDirectivePolarity,
  parseDirectiveTrigger,
  type ParsedDirectiveMetadata,
} from "../directives/model.js";
import {
  buildPrecomputedClaimKeyLifecycle,
  hasPrecomputedClaimKeyLifecycleFields,
  parseClaimKeyConfidence,
  parseClaimKeySource,
  parseClaimKeyStatus,
  parseClaimSupportMode,
} from "../claim-key-lifecycle.js";
import { validateTemporalValidityRange } from "../temporal-validity.js";
import { DURABLE_KINDS, EXPIRY_LEVELS, type Expiry, type StoreDurableInput } from "../types.js";
import { describeClaimKeyNormalizationFailure, normalizeClaimKey } from "../claim-key.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Result of validating a batch of store inputs.
 */
export interface ValidationResult {
  valid: StoreDurableInput[];
  rejected: number;
  errors: string[];
  warnings: string[];
}

/**
 * Validated store input paired with its original array index.
 */
export interface IndexedValidDurable {
  inputIndex: number;
  input: StoreDurableInput;
}

/**
 * Result of validating a batch while preserving input indexes.
 */
export interface IndexedValidationResult {
  valid: IndexedValidDurable[];
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
export function validateEntries(inputs: StoreDurableInput[]): ValidationResult {
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
export function validateEntriesWithIndexes(inputs: StoreDurableInput[]): IndexedValidationResult {
  const valid: IndexedValidDurable[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const rejectedInputIndexes: number[] = [];

  for (const [index, input] of inputs.entries()) {
    const subject = normalizeString(input.subject);
    const content = normalizeString(input.content);

    if (!DURABLE_KINDS.includes(input.type)) {
      errors.push(`Durable ${index} has an invalid type.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (subject.length === 0) {
      errors.push(`Durable ${index} is missing a subject.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (content.length === 0) {
      errors.push(`Durable ${index} is missing content.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (input.expiry !== undefined && !EXPIRY_LEVELS.includes(input.expiry)) {
      errors.push(`Durable ${index} has an invalid expiry.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (input.tags !== undefined && !areValidTags(input.tags)) {
      errors.push(`Durable ${index} has invalid tags.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (input.importance !== undefined && !Number.isFinite(input.importance)) {
      errors.push(`Durable ${index} has an invalid importance.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    if (input.supersedes !== undefined && !isUuid(input.supersedes)) {
      errors.push(`Durable ${index} has an invalid supersedes id.`);
      rejectedInputIndexes.push(index);
      continue;
    }

    const temporalValidity = validateTemporalValidityRange(input.valid_from, input.valid_to);
    if (!temporalValidity.ok) {
      errors.push(`Durable ${index} ${temporalValidity.message}`);
      rejectedInputIndexes.push(index);
      continue;
    }

    let normalizedClaimKey: string | undefined;
    if (input.claim_key !== undefined) {
      if (typeof input.claim_key !== "string") {
        warnings.push(`Durable ${index} provided a non-string claim key and it was dropped.`);
      } else if (input.type === "directive") {
        normalizedClaimKey = normalizeMemoryDirectiveClaimKey(input.claim_key);
        if (!normalizedClaimKey) {
          warnings.push(`Durable ${index} provided invalid directive claim key ${JSON.stringify(input.claim_key)} and it was dropped.`);
        }
      } else {
        const claimKey = normalizeClaimKey(input.claim_key);
        if (claimKey.ok) {
          normalizedClaimKey = claimKey.value.claimKey;
        } else {
          warnings.push(
            `Durable ${index} provided invalid claim key ${JSON.stringify(input.claim_key)} and it was dropped: ${describeClaimKeyNormalizationFailure(claimKey.reason)}.`,
          );
        }
      }
    }

    const directiveMetadata = validateDirectiveMetadata(input, normalizedClaimKey, index, errors, rejectedInputIndexes);
    if (!directiveMetadata.ok) {
      continue;
    }

    const claimKeyRaw = normalizedClaimKey ? normalizeOptionalString(input.claim_key_raw) : undefined;
    const claimKeyStatus = normalizedClaimKey ? normalizeClaimKeyStatus(input.claim_key_status, index, warnings) : undefined;
    const claimKeySource = normalizedClaimKey ? normalizeClaimKeySource(input.claim_key_source, index, warnings) : undefined;
    const claimKeyConfidence = normalizedClaimKey ? normalizeClaimKeyConfidence(input.claim_key_confidence, index, warnings) : undefined;
    const claimKeyRationale = normalizedClaimKey ? normalizeOptionalString(input.claim_key_rationale) : undefined;
    const claimSupportSourceKind = normalizedClaimKey ? normalizeOptionalString(input.claim_support_source_kind) : undefined;
    const claimSupportLocator = normalizedClaimKey ? normalizeOptionalString(input.claim_support_locator) : undefined;
    const claimSupportObservedAt =
      normalizedClaimKey && input.claim_support_observed_at !== undefined
        ? normalizeClaimSupportObservedAt(input.claim_support_observed_at, index, warnings)
        : undefined;
    const claimSupportMode =
      normalizedClaimKey && input.claim_support_mode !== undefined ? normalizeClaimSupportMode(input.claim_support_mode, index, warnings) : undefined;
    const hasPrecomputedLifecycleFields = hasPrecomputedClaimKeyLifecycleFields(input);
    const resolvedPrecomputedLifecycle =
      normalizedClaimKey && hasPrecomputedLifecycleFields
        ? buildPrecomputedClaimKeyLifecycle({
            claim_key: normalizedClaimKey,
            claim_key_raw: claimKeyRaw,
            claim_key_status: claimKeyStatus,
            claim_key_source: claimKeySource,
            claim_key_confidence: claimKeyConfidence,
            claim_key_rationale: claimKeyRationale,
            claim_support_source_kind: claimSupportSourceKind,
            claim_support_locator: claimSupportLocator,
            claim_support_observed_at: claimSupportObservedAt,
            claim_support_mode: claimSupportMode,
          })
        : undefined;

    if (hasPrecomputedLifecycleFields) {
      if (!normalizedClaimKey) {
        errors.push(`Durable ${index} provided claim-key lifecycle metadata without a valid claim key.`);
        rejectedInputIndexes.push(index);
        continue;
      }

      if (!resolvedPrecomputedLifecycle) {
        errors.push(
          `Durable ${index} provided partial or invalid claim-key lifecycle metadata. Complete bundles require claim_key_status, claim_key_source, claim_key_confidence, and claim_key_rationale.`,
        );
        rejectedInputIndexes.push(index);
        continue;
      }
    }

    valid.push({
      inputIndex: index,
      input: {
        type: input.type,
        subject,
        content,
        importance: clampImportance(input.importance),
        expiry: (input.expiry ?? (input.type === "directive" ? "core" : "temporary")) as Expiry,
        tags: normalizeTags(input.tags),
        source_file: normalizeOptionalString(input.source_file),
        source_context: normalizeOptionalString(input.source_context),
        user_id: normalizeOptionalString(input.user_id),
        project: normalizeOptionalString(input.project),
        created_at: normalizeOptionalString(input.created_at),
        supersedes: normalizeOptionalString(input.supersedes),
        claim_key: normalizedClaimKey,
        claim_key_raw: resolvedPrecomputedLifecycle?.claim_key_raw ?? claimKeyRaw,
        claim_key_status: resolvedPrecomputedLifecycle?.claim_key_status,
        claim_key_source: resolvedPrecomputedLifecycle?.claim_key_source,
        claim_key_confidence: resolvedPrecomputedLifecycle?.claim_key_confidence,
        claim_key_rationale: resolvedPrecomputedLifecycle?.claim_key_rationale,
        claim_support_source_kind: resolvedPrecomputedLifecycle?.claim_support_source_kind ?? claimSupportSourceKind,
        claim_support_locator: resolvedPrecomputedLifecycle?.claim_support_locator ?? claimSupportLocator,
        claim_support_observed_at: resolvedPrecomputedLifecycle?.claim_support_observed_at ?? claimSupportObservedAt,
        claim_support_mode: resolvedPrecomputedLifecycle?.claim_support_mode ?? claimSupportMode,
        valid_from: temporalValidity.value.validFrom,
        valid_to: temporalValidity.value.validTo,
        ...(directiveMetadata.metadata
          ? { directive_polarity: directiveMetadata.metadata.polarity, directive_trigger: directiveMetadata.metadata.trigger }
          : {}),
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

/** Validates directive-specific fields and applies trigger defaults. */
function validateDirectiveMetadata(
  input: StoreDurableInput,
  normalizedClaimKey: string | undefined,
  index: number,
  errors: string[],
  rejectedInputIndexes: number[],
): { ok: true; metadata?: ParsedDirectiveMetadata } | { ok: false } {
  const hasDirectiveMetadata = input.directive_polarity !== undefined || input.directive_trigger !== undefined;
  if (input.type !== "directive") {
    if (hasDirectiveMetadata) {
      errors.push(`Durable ${index} provided directive metadata on a non-directive durable.`);
      rejectedInputIndexes.push(index);
      return { ok: false };
    }

    return { ok: true };
  }

  if (!normalizedClaimKey?.startsWith(MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX)) {
    errors.push(`Durable ${index} directive claim_key must use the ${MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX} prefix.`);
    rejectedInputIndexes.push(index);
    return { ok: false };
  }

  const polarity = parseDirectivePolarity(input.directive_polarity);
  if (!polarity) {
    errors.push(`Durable ${index} directive_polarity must be abstain or proactive.`);
    rejectedInputIndexes.push(index);
    return { ok: false };
  }

  const trigger = input.directive_trigger === undefined ? defaultDirectiveTrigger(polarity) : parseDirectiveTrigger(input.directive_trigger);
  if (!trigger) {
    errors.push(`Durable ${index} directive_trigger must be session_start, always, or topic:<term>.`);
    rejectedInputIndexes.push(index);
    return { ok: false };
  }

  return { ok: true, metadata: { polarity, trigger } };
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
    warnings.push(`Durable ${index} provided invalid claim_support_observed_at ${JSON.stringify(value)} and it was dropped.`);
    return undefined;
  }

  return normalized;
}

/** Validates one optional claim-key lifecycle status. */
function normalizeClaimKeyStatus(value: StoreDurableInput["claim_key_status"], index: number, warnings: string[]): StoreDurableInput["claim_key_status"] {
  const parsed = parseClaimKeyStatus(value);
  if (parsed) {
    return parsed;
  }

  if (value !== undefined) {
    warnings.push(`Durable ${index} provided invalid claim_key_status ${JSON.stringify(value)} and it was dropped.`);
  }

  return undefined;
}

/** Validates one optional claim-key lifecycle source. */
function normalizeClaimKeySource(value: StoreDurableInput["claim_key_source"], index: number, warnings: string[]): StoreDurableInput["claim_key_source"] {
  const parsed = parseClaimKeySource(value);
  if (parsed) {
    return parsed;
  }

  if (value !== undefined) {
    warnings.push(`Durable ${index} provided invalid claim_key_source ${JSON.stringify(value)} and it was dropped.`);
  }

  return undefined;
}

/** Validates one optional claim-key lifecycle confidence. */
function normalizeClaimKeyConfidence(
  value: StoreDurableInput["claim_key_confidence"],
  index: number,
  warnings: string[],
): StoreDurableInput["claim_key_confidence"] {
  if (value === undefined) {
    return undefined;
  }

  const parsed = parseClaimKeyConfidence(value);
  if (parsed !== undefined) {
    return parsed;
  }

  warnings.push(`Durable ${index} provided invalid claim_key_confidence ${JSON.stringify(value)} and it was dropped.`);
  return undefined;
}

/** Validates one optional claim-support provenance mode. */
function normalizeClaimSupportMode(value: StoreDurableInput["claim_support_mode"], index: number, warnings: string[]): StoreDurableInput["claim_support_mode"] {
  const parsed = parseClaimSupportMode(value);
  if (parsed) {
    return parsed;
  }

  warnings.push(`Durable ${index} provided invalid claim_support_mode ${JSON.stringify(value)} and it was dropped.`);
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

/** Returns whether an optional id string matches the UUID format used by agenr durable ids. */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

/** Returns whether a timestamp string looks like a valid ISO 8601 instant. */
function isIsoTimestamp(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.includes("T") && !Number.isNaN(Date.parse(normalized));
}
