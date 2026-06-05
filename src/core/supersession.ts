import type { Expiry, DurableKind } from "./types.js";

/**
 * Stable failure reasons emitted by the shared supersession policy.
 */
export type SupersessionRuleFailureReason = "type_mismatch" | "milestone" | "core_expiry";

/**
 * Minimal entry shape needed to validate whether one entry may supersede another.
 */
export interface SupersessionCandidate {
  type: DurableKind;
  expiry: Expiry;
}

/**
 * Structured result returned by the shared supersession policy.
 */
export type SupersessionRuleValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: SupersessionRuleFailureReason;
    };

/**
 * Validates the hard supersession rules shared by manual and automatic linking.
 *
 * @param oldEntry - Older entry that would be superseded.
 * @param newEntry - Replacement entry that would become active.
 * @returns Structured validation result that accepts or rejects the link.
 */
export function validateSupersessionRules(oldEntry: SupersessionCandidate, newEntry: SupersessionCandidate): SupersessionRuleValidationResult {
  if (oldEntry.type !== newEntry.type) {
    return {
      ok: false,
      reason: "type_mismatch",
    };
  }

  if (oldEntry.type === "milestone") {
    return {
      ok: false,
      reason: "milestone",
    };
  }

  if (oldEntry.expiry === "core") {
    return {
      ok: false,
      reason: "core_expiry",
    };
  }

  return {
    ok: true,
  };
}

/**
 * Formats one shared supersession-policy failure into a user-facing reason string.
 *
 * @param reason - Stable supersession-policy failure reason.
 * @returns Human-readable explanation suitable for warnings and tool results.
 */
export function describeSupersessionRuleFailure(reason: SupersessionRuleFailureReason): string {
  switch (reason) {
    case "type_mismatch":
      return "Supersession requires both entries to have the same type.";
    case "milestone":
      return "Milestone entries are never superseded automatically.";
    case "core_expiry":
      return "Core-expiry entries are never superseded automatically.";
  }
}
