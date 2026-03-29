import type { Expiry } from "../../types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Entry fields used by retirement protection guards.
 */
export interface SurgeonProtectionEntry {
  expiry: Expiry;
  importance: number;
  lastRecalledAt?: string | null;
}

/**
 * Configuration for retirement protection guards.
 */
export interface SurgeonRetirementProtectionConfig {
  now: Date;
  protectRecalledDays: number;
  protectMinImportance: number;
}

/**
 * Determines whether an entry is protected from retirement.
 *
 * @param entry - Entry fields evaluated by the hard protection guards.
 * @param config - Active retirement protection configuration.
 * @returns Protection status and an optional explanation when protected.
 */
export function isProtectedFromRetirement(entry: SurgeonProtectionEntry, config: SurgeonRetirementProtectionConfig): { protected: boolean; reason?: string } {
  if (entry.expiry === "core") {
    return { protected: true, reason: "Entry expiry is core." };
  }

  if (entry.importance >= config.protectMinImportance) {
    return {
      protected: true,
      reason: `Entry importance is at or above ${config.protectMinImportance}.`,
    };
  }

  const lastRecalledAt = entry.lastRecalledAt?.trim();
  if (lastRecalledAt) {
    const parsed = new Date(lastRecalledAt);
    const ageMs = config.now.getTime() - parsed.getTime();
    if (!Number.isNaN(parsed.getTime()) && ageMs <= config.protectRecalledDays * DAY_MS) {
      return {
        protected: true,
        reason: `Entry was recalled within the last ${config.protectRecalledDays} days.`,
      };
    }
  }

  return { protected: false };
}
