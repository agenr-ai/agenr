import type { ClaimKeyStatus, Durable } from "./types.js";

/** Minimal durable shape used to validate keyed lifecycle metadata. */
export type KeyedDurableLifecycleSubject = Pick<Durable, "claim_key" | "claim_key_status"> & {
  id?: string;
};

/** Keyed durable row with a persisted lifecycle status. */
export type KeyedDurableWithLifecycle = KeyedDurableLifecycleSubject & {
  claim_key: string;
  claim_key_status: ClaimKeyStatus;
};

/**
 * Returns whether one keyed durable row carries a persisted lifecycle status.
 *
 * @param entry - Durable row or observation carrying claim-key lifecycle fields.
 * @returns True when a non-empty claim key has lifecycle status.
 */
export function hasKeyedDurableLifecycleStatus(entry: KeyedDurableLifecycleSubject): entry is KeyedDurableWithLifecycle {
  return Boolean(entry.claim_key?.trim() && entry.claim_key_status);
}

/**
 * Asserts that keyed durables carry a persisted lifecycle status.
 *
 * @param entry - Durable row or observation carrying claim-key lifecycle fields.
 * @throws Error When a non-empty claim key is missing lifecycle status.
 */
export function assertKeyedDurableHasLifecycle(entry: KeyedDurableLifecycleSubject): void {
  if (!entry.claim_key?.trim()) {
    return;
  }

  if (!entry.claim_key_status) {
    const idSuffix = entry.id ? ` "${entry.id}"` : "";
    throw new Error(`Missing claim_key_status for keyed durable${idSuffix}.`);
  }
}

/**
 * Resolves the claim-key lifecycle label for one durable-like row.
 *
 * @param entry - Durable row carrying claim-key lifecycle fields.
 * @returns `no_key` when no claim key is stored, otherwise the persisted status.
 */
export function resolveKeyedDurableLifecycleStatus(entry: KeyedDurableLifecycleSubject): ClaimKeyStatus | "no_key" {
  if (!entry.claim_key?.trim()) {
    return "no_key";
  }

  assertKeyedDurableHasLifecycle(entry);
  if (!hasKeyedDurableLifecycleStatus(entry)) {
    throw new Error("Missing claim_key_status for keyed durable.");
  }

  return entry.claim_key_status;
}
