import type { Expiry } from "../../types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lowest importance dreaming may demote a permanent entry to. */
const DREAMING_PERMANENT_ENTRY_DEMOTION_FLOOR = 4;

export { DREAMING_PERMANENT_ENTRY_DEMOTION_FLOOR };

/**
 * Durable fields used by stale protection guards.
 */
export interface DreamProtectionDurable {
  expiry: Expiry;
  importance: number;
  lastRecalledAt?: string | null;
}

/**
 * Configuration for stale protection guards.
 */
export interface DreamStaleProtectionConfig {
  now: Date;
  protectRecalledDays: number;
  protectMinImportance: number;
}

/**
 * Determines whether an entry is protected from staleness.
 *
 * @param entry - Durable fields evaluated by the hard protection guards.
 * @param config - Active stale protection configuration.
 * @returns Protection status and an optional explanation when protected.
 */
export function isProtectedFromStaleness(entry: DreamProtectionDurable, config: DreamStaleProtectionConfig): { protected: boolean; reason?: string } {
  if (entry.expiry === "core") {
    return { protected: true, reason: "Durable expiry is core." };
  }

  if (entry.importance >= config.protectMinImportance) {
    return {
      protected: true,
      reason: `Durable importance is at or above ${config.protectMinImportance}.`,
    };
  }

  if (entry.expiry === "permanent") {
    return {
      protected: true,
      reason: `Durable expiry is permanent. Use update_durable to demote importance instead, but keep importance at or above ${DREAMING_PERMANENT_ENTRY_DEMOTION_FLOOR}.`,
    };
  }

  const lastRecalledAt = entry.lastRecalledAt?.trim();
  if (lastRecalledAt) {
    const parsed = new Date(lastRecalledAt);
    const ageMs = config.now.getTime() - parsed.getTime();
    if (!Number.isNaN(parsed.getTime()) && ageMs <= config.protectRecalledDays * DAY_MS) {
      return {
        protected: true,
        reason: `Durable was recalled within the last ${config.protectRecalledDays} days.`,
      };
    }
  }

  return { protected: false };
}
