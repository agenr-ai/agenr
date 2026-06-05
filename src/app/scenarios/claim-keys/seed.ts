import { randomUUID } from "node:crypto";

import { insertDurable, type SqlExecutor } from "../../../adapters/db/queries.js";
import { buildManualClaimKeyLifecycle, buildPrecomputedClaimKeyLifecycle, type ResolvedClaimKeyLifecycle } from "../../../core/claim-key-lifecycle.js";
import { normalizeClaimKey } from "../../../core/claim-key.js";
import { computeContentHash, computeNormContentHash } from "../../../core/store/hashing.js";
import { validateEntriesWithIndexes } from "../../../core/store/validation.js";
import type { Durable, StoreDurableInput } from "../../../core/types.js";
import type { ClaimKeyScenarioSeedEntry } from "./types.js";

const DEFAULT_SCENARIO_CREATED_AT = "2026-04-01T10:00:00.000Z";

/**
 * Builds one canonical scenario seed entry using the same validation and lifecycle shaping as production writes.
 *
 * @param seedEntry - Raw scenario seed entry payload.
 * @returns Canonical stored entry row ready for repository insertion.
 */
export function buildClaimKeyScenarioSeedEntry(seedEntry: ClaimKeyScenarioSeedEntry): Durable {
  const seedClaimKey = normalizeOptionalString(seedEntry.claim_key);
  const preserveLegacyStoredClaimKey = shouldPreserveLegacyStoredClaimKey(seedClaimKey);
  const validatedInput = validateSeedStoreInput(seedEntry, preserveLegacyStoredClaimKey);
  const lifecycle = preserveLegacyStoredClaimKey ? resolveLegacySeedClaimKeyLifecycle(seedEntry) : resolveSeedClaimKeyLifecycle(seedEntry, validatedInput);
  const createdAt = seedEntry.created_at?.trim() || validatedInput.created_at || DEFAULT_SCENARIO_CREATED_AT;
  const updatedAt = seedEntry.updated_at?.trim() || createdAt;

  return {
    id: seedEntry.id?.trim() || randomUUID(),
    type: validatedInput.type,
    subject: validatedInput.subject,
    content: validatedInput.content,
    importance: validatedInput.importance ?? 7,
    expiry: validatedInput.expiry ?? "temporary",
    tags: validatedInput.tags ?? [],
    source_file: validatedInput.source_file,
    source_context: validatedInput.source_context,
    embedding: undefined,
    content_hash: computeContentHash(validatedInput.content, validatedInput.source_file),
    norm_content_hash: computeNormContentHash(validatedInput.content),
    quality_score: 0.5,
    recall_count: 0,
    last_recalled_at: undefined,
    superseded_by: normalizeOptionalString(seedEntry.superseded_by),
    valid_from: validatedInput.valid_from,
    valid_to: validatedInput.valid_to,
    claim_key: preserveLegacyStoredClaimKey ? seedClaimKey : lifecycle?.claim_key,
    claim_key_raw: preserveLegacyStoredClaimKey ? normalizeOptionalString(seedEntry.claim_key_raw) : lifecycle?.claim_key_raw,
    claim_key_status: lifecycle?.claim_key_status,
    claim_key_source: lifecycle?.claim_key_source,
    claim_key_confidence: lifecycle?.claim_key_confidence,
    claim_key_rationale: lifecycle?.claim_key_rationale,
    claim_support_source_kind: lifecycle?.claim_support_source_kind,
    claim_support_locator: lifecycle?.claim_support_locator,
    claim_support_observed_at: lifecycle?.claim_support_observed_at,
    claim_support_mode: lifecycle?.claim_support_mode,
    supersession_kind: undefined,
    supersession_reason: undefined,
    cluster_id: undefined,
    user_id: validatedInput.user_id,
    project: validatedInput.project,
    retired: seedEntry.retired ?? false,
    retired_at: normalizeOptionalString(seedEntry.retired_at),
    retired_reason: normalizeOptionalString(seedEntry.retired_reason),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/**
 * Seeds scenario entries through the shared repository insert helper instead of ad hoc SQL writes.
 *
 * @param executor - SQL executor used by the scenario sandbox.
 * @param seedEntries - Raw scenario seed entries to insert in order.
 */
export async function seedClaimKeyScenarioEntries(executor: SqlExecutor, seedEntries: ClaimKeyScenarioSeedEntry[]): Promise<void> {
  for (const seedEntry of seedEntries) {
    const entry = buildClaimKeyScenarioSeedEntry(seedEntry);
    await insertDurable(executor, entry, [], entry.content_hash ?? computeContentHash(entry.content, entry.source_file));
  }
}

/**
 * Validates one seed entry through the same store-input validation used by production writes.
 *
 * @param seedEntry - Raw scenario seed entry payload.
 * @returns Canonical validated store input.
 */
function validateSeedStoreInput(seedEntry: ClaimKeyScenarioSeedEntry, preserveLegacyStoredClaimKey: boolean): StoreDurableInput {
  const validation = validateEntriesWithIndexes([
    {
      type: seedEntry.type,
      subject: seedEntry.subject,
      content: seedEntry.content,
      importance: seedEntry.importance,
      expiry: seedEntry.expiry,
      tags: seedEntry.tags,
      source_file: seedEntry.source_file,
      source_context: seedEntry.source_context,
      user_id: seedEntry.user_id,
      project: seedEntry.project,
      created_at: seedEntry.created_at,
      claim_key: preserveLegacyStoredClaimKey ? undefined : seedEntry.claim_key,
      claim_key_raw: seedEntry.claim_key_raw,
      claim_key_status: seedEntry.claim_key_status,
      claim_key_source: seedEntry.claim_key_source,
      claim_key_confidence: seedEntry.claim_key_confidence,
      claim_key_rationale: seedEntry.claim_key_rationale,
      claim_support_source_kind: seedEntry.claim_support_source_kind,
      claim_support_locator: seedEntry.claim_support_locator,
      claim_support_observed_at: seedEntry.claim_support_observed_at,
      claim_support_mode: seedEntry.claim_support_mode,
      valid_from: seedEntry.valid_from,
      valid_to: seedEntry.valid_to,
    },
  ]);

  const validated = validation.valid[0]?.input;
  if (!validated) {
    throw new Error(`Invalid scenario seed entry "${seedEntry.subject}": ${validation.errors.join(" ")}`);
  }

  if (validation.warnings.length > 0) {
    throw new Error(`Invalid scenario seed entry "${seedEntry.subject}": ${validation.warnings.join(" ")}`);
  }

  return validated;
}

/**
 * Resolves canonical lifecycle metadata for one scenario seed entry.
 *
 * Explicit lifecycle fields must be complete when present so the scenario
 * corpus cannot silently drift into a manual fallback path.
 *
 * @param seedEntry - Raw scenario seed entry payload.
 * @param validatedInput - Canonical validated store input.
 * @returns Canonical lifecycle payload, or undefined when the seed has no claim key.
 */
function resolveSeedClaimKeyLifecycle(seedEntry: ClaimKeyScenarioSeedEntry, validatedInput: StoreDurableInput): ResolvedClaimKeyLifecycle | undefined {
  if (!validatedInput.claim_key) {
    return undefined;
  }

  const hasExplicitLifecycleFields =
    seedEntry.claim_key_status !== undefined ||
    seedEntry.claim_key_source !== undefined ||
    seedEntry.claim_key_confidence !== undefined ||
    seedEntry.claim_key_rationale !== undefined;
  if (hasExplicitLifecycleFields) {
    const lifecycle = buildPrecomputedClaimKeyLifecycle(validatedInput);
    if (!lifecycle) {
      throw new Error(
        `Invalid scenario seed entry "${seedEntry.subject}": explicit claim-key lifecycle requires claim_key_status, claim_key_source, claim_key_confidence, and claim_key_rationale.`,
      );
    }

    return lifecycle;
  }

  return buildManualClaimKeyLifecycle({
    claimKey: validatedInput.claim_key,
    rawClaimKey: validatedInput.claim_key_raw ?? seedEntry.claim_key,
    supportSourceKind: validatedInput.claim_support_source_kind,
    supportLocator: validatedInput.claim_support_locator,
    supportObservedAt: validatedInput.claim_support_observed_at,
    supportMode: validatedInput.claim_support_mode,
  });
}

/**
 * Resolves lifecycle metadata for a seeded legacy malformed claim key.
 *
 * Legacy rows may intentionally keep a noncanonical stored claim key so
 * cleanup scenarios can exercise repair logic. Their lifecycle enums still
 * pass through the shared validated boundary parsing from the scenario loader.
 *
 * @param seedEntry - Raw scenario seed entry payload.
 * @returns Explicit lifecycle metadata when the seed provided it.
 */
function resolveLegacySeedClaimKeyLifecycle(seedEntry: ClaimKeyScenarioSeedEntry): ResolvedClaimKeyLifecycle | undefined {
  if (!seedEntry.claim_key) {
    return undefined;
  }

  const hasExplicitLifecycleFields =
    seedEntry.claim_key_status !== undefined ||
    seedEntry.claim_key_source !== undefined ||
    seedEntry.claim_key_confidence !== undefined ||
    seedEntry.claim_key_rationale !== undefined;
  if (!hasExplicitLifecycleFields) {
    return undefined;
  }

  if (
    seedEntry.claim_key_status === undefined ||
    seedEntry.claim_key_source === undefined ||
    seedEntry.claim_key_confidence === undefined ||
    seedEntry.claim_key_rationale === undefined
  ) {
    throw new Error(
      `Invalid scenario seed entry "${seedEntry.subject}": explicit claim-key lifecycle requires claim_key_status, claim_key_source, claim_key_confidence, and claim_key_rationale.`,
    );
  }

  return {
    claim_key: seedEntry.claim_key.trim(),
    claim_key_raw: normalizeOptionalString(seedEntry.claim_key_raw),
    claim_key_status: seedEntry.claim_key_status,
    claim_key_source: seedEntry.claim_key_source,
    claim_key_confidence: seedEntry.claim_key_confidence,
    claim_key_rationale: seedEntry.claim_key_rationale.trim(),
    claim_support_source_kind: normalizeOptionalString(seedEntry.claim_support_source_kind),
    claim_support_locator: normalizeOptionalString(seedEntry.claim_support_locator),
    claim_support_observed_at: normalizeOptionalString(seedEntry.claim_support_observed_at),
    claim_support_mode: seedEntry.claim_support_mode,
  };
}

/**
 * Returns whether one scenario seed should preserve its stored claim key as a legacy malformed value.
 *
 * @param claimKey - Raw scenario seed claim key.
 * @returns True when the helper should bypass canonical claim-key normalization for storage.
 */
function shouldPreserveLegacyStoredClaimKey(claimKey: string | undefined): boolean {
  if (!claimKey) {
    return false;
  }

  const normalized = normalizeClaimKey(claimKey);
  return !normalized.ok || normalized.value.claimKey !== claimKey;
}

/**
 * Trims optional strings and drops empty values.
 *
 * @param value - Raw optional string.
 * @returns Trimmed string, or undefined when empty.
 */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
