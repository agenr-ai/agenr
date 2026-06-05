import { isTrustedClaimKeyForCleanup } from "../../../../core/claim-key.js";
import type { Durable } from "../../../../core/types.js";
import type { ClaimKeyLifecycleSnapshot, TrustedGroupReuseCandidate } from "../types.js";
import { normalizeStringArray } from "./utils.js";

/** Clones a durable record while copying mutable array fields. */
export function cloneDurable(durable: Durable): Durable {
  return {
    ...durable,
    tags: [...durable.tags],
    embedding: durable.embedding ? [...durable.embedding] : undefined,
  };
}

/** Returns whether a durable is active for reconcile collision checks. */
export function isDurableActive(durable: Durable): boolean {
  return durable.retired === false && !durable.superseded_by;
}

/** Finds durables that already occupy a claim key, excluding one durable id. */
export function findClaimKeyOccupants(durables: Durable[], claimKey: string, excludeDurableId: string): Durable[] {
  return durables.filter((durable) => durable.id !== excludeDurableId && durable.claim_key === claimKey);
}

/** Finds active durables that already occupy a claim key, excluding one durable id. */
export function findActiveClaimKeyOccupants(durables: Durable[], claimKey: string, excludeDurableId: string): Durable[] {
  return durables.filter((durable) => durable.id !== excludeDurableId && durable.claim_key === claimKey && isDurableActive(durable));
}

/** Counts claim-key clusters with more than one durable occupant. */
export function countExactKeyMultiActiveClusters(durables: Durable[]): number {
  const counts = new Map<string, number>();

  for (const durable of durables) {
    const claimKey = durable.claim_key?.trim();
    if (!claimKey) {
      continue;
    }

    counts.set(claimKey, (counts.get(claimKey) ?? 0) + 1);
  }

  return [...counts.values()].filter((count) => count >= 2).length;
}

/** Finds the unique trusted claim key reused by a durable's subject/type peers. */
export function findTrustedGroupReuseCandidate(durables: Durable[], trustedDurableIds: Set<string>, durable: Durable): TrustedGroupReuseCandidate | null {
  const normalizedSubject = durable.subject.trim().toLowerCase();
  if (normalizedSubject.length === 0) {
    return null;
  }

  const trustedPeers = durables.filter((candidate) => {
    if (candidate.id === durable.id || candidate.type !== durable.type) {
      return false;
    }

    if (!trustedDurableIds.has(candidate.id)) {
      return false;
    }

    if (candidate.subject.trim().toLowerCase() !== normalizedSubject) {
      return false;
    }

    const claimKey = candidate.claim_key?.trim();
    return Boolean(claimKey && isTrustedClaimKeyForCleanup(claimKey));
  });
  const trustedClaimKeys = normalizeStringArray(
    trustedPeers.flatMap((candidate) => {
      const claimKey = candidate.claim_key?.trim();
      return claimKey ? [claimKey] : [];
    }),
  );
  if (trustedClaimKeys.length !== 1) {
    return null;
  }

  const claimKey = trustedClaimKeys[0];
  if (!claimKey) {
    return null;
  }

  return {
    claimKey,
    supportingDurableIds: trustedPeers.map((candidate) => candidate.id),
  };
}

/** Captures claim-key lifecycle fields before a projected repair mutates them. */
export function snapshotClaimKeyLifecycle(durable: Durable): ClaimKeyLifecycleSnapshot {
  return {
    claimKey: durable.claim_key,
    claimKeyRaw: durable.claim_key_raw,
    claimKeyStatus: durable.claim_key_status,
    claimKeySource: durable.claim_key_source,
    claimKeyConfidence: durable.claim_key_confidence,
    claimKeyRationale: durable.claim_key_rationale,
  };
}

/** Restores claim-key lifecycle fields after a projected repair is rejected. */
export function restoreClaimKeyLifecycle(durable: Durable, snapshot: ClaimKeyLifecycleSnapshot): void {
  durable.claim_key = snapshot.claimKey;
  durable.claim_key_raw = snapshot.claimKeyRaw;
  durable.claim_key_status = snapshot.claimKeyStatus;
  durable.claim_key_source = snapshot.claimKeySource;
  durable.claim_key_confidence = snapshot.claimKeyConfidence;
  durable.claim_key_rationale = snapshot.claimKeyRationale;
}
