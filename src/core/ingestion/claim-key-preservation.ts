import type { ClaimSupportMode, StoreEntryInput } from "../types.js";
import { buildExplicitClaimKeyPreservationMetadata, mergeExplicitClaimKeyMetadata } from "../claim-key-lifecycle.js";

import type { DedupResult } from "./dedup.js";

/**
 * Support metadata available when preserving an explicit claim key.
 */
export interface ExplicitClaimKeySupportContext {
  /** Stable provenance bucket for the preserved key. */
  sourceKind?: string;
  /** Best-effort locator for where the explicit key was observed. */
  locator?: string;
  /** Observation timestamp for the preserved key when known. */
  observedAt?: string;
  /** Whether the support was copied explicitly or inferred. */
  mode?: ClaimSupportMode;
}

/**
 * Adds conservative support metadata to an entry that already carries an explicit claim key.
 *
 * @param entry - Extracted entry that may already contain a preserved claim key.
 * @param context - Best-effort support metadata visible at the extraction site.
 * @returns Entry with explicit claim-key support metadata filled in when possible.
 */
export function annotateExplicitClaimKeyEntry(entry: StoreEntryInput, context: ExplicitClaimKeySupportContext): StoreEntryInput {
  if (!entry.claim_key) {
    return entry;
  }

  return {
    ...entry,
    ...buildExplicitClaimKeyPreservationMetadata(entry, context),
  };
}

/**
 * Restores explicit claim-key metadata onto dedup survivors when the winning entry dropped it.
 *
 * @param originalEntries - Entries before dedup arbitration, aligned to original indexes.
 * @param dedupResult - Dedup result whose survivors may need preserved claim-key metadata reapplied.
 * @returns Survivors with explicit claim-key metadata restored when the cluster agrees on one key.
 */
export function restoreExplicitClaimKeysAfterDedup(originalEntries: StoreEntryInput[], dedupResult: DedupResult): StoreEntryInput[] {
  const claimKeyByKeptIndex = new Map<number, StoreEntryInput>();

  for (const clusterDetail of dedupResult.clusterDetails) {
    const candidate = resolveClusterClaimKeyCandidate(clusterDetail.entryIndices.map((index) => originalEntries[index]).filter(isDefined));
    if (!candidate) {
      continue;
    }

    for (const keptIndex of clusterDetail.kept) {
      claimKeyByKeptIndex.set(keptIndex, candidate);
    }
  }

  return dedupResult.survivors.map((survivor, offset) => {
    const originalIndex = dedupResult.survivorIndices[offset];
    if (originalIndex === undefined) {
      return survivor;
    }

    const candidate = claimKeyByKeptIndex.get(originalIndex);
    return candidate ? mergeExplicitClaimKeyMetadata(survivor, candidate) : survivor;
  });
}

/** Resolves one explicit claim-key candidate when every explicit entry in the cluster agrees on the slot. */
function resolveClusterClaimKeyCandidate(entries: StoreEntryInput[]): StoreEntryInput | undefined {
  const explicitEntries = entries.filter(hasExplicitClaimKey);
  if (explicitEntries.length === 0) {
    return undefined;
  }

  const distinctClaimKeys = new Set(explicitEntries.map((entry) => entry.claim_key));
  if (distinctClaimKeys.size !== 1) {
    return undefined;
  }

  return explicitEntries[0];
}

/** Returns whether an entry carries a non-empty explicit claim key. */
function hasExplicitClaimKey(entry: StoreEntryInput): entry is StoreEntryInput & { claim_key: string } {
  return typeof entry.claim_key === "string" && entry.claim_key.trim().length > 0;
}

/** Narrows undefined values away from mapped entry arrays. */
function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
