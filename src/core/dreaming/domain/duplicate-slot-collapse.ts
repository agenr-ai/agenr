/**
 * Pure detection and survivor-selection logic for duplicate exclusive-slot collapse.
 *
 * An exclusive claim slot should hold at most one active durable. When alias or
 * entity-family convergence rewrites several claim keys onto one canonical key,
 * the slot can end up with many active rows that all answer the same question.
 * This module detects those clusters and deterministically picks the single
 * durable that should survive a content-level collapse.
 */

import { resolveClaimSlotPolicy, type ClaimSlotPolicyConfig } from "../../claim-slot-policy.js";
import type { Durable } from "../../types.js";

/** One exclusive claim slot occupied by more than one active durable. */
export interface DuplicateSlotGroup {
  /** Canonical claim key shared by every group member. */
  claimKey: string;
  /** Active durables occupying the slot, in working-set order. */
  durables: Durable[];
}

/** Deterministic collapse plan for one duplicate exclusive-slot group. */
export interface DuplicateSlotCollapsePlan {
  /** Durable selected to remain active on the slot. */
  survivor: Durable;
  /** Durables that should be superseded by the survivor. */
  losers: Durable[];
}

/** Returns whether a durable is active for duplicate-slot detection. */
function isActiveForSlotCollapse(durable: Durable): boolean {
  return durable.valid_to === undefined && durable.superseded_by === undefined;
}

/**
 * Detects exclusive claim slots that hold more than one active durable.
 *
 * Multivalued slot policies (for example `preference` heads) are exempt because
 * those slots may legitimately contain several concurrent truths.
 *
 * @param durables - Working-set durables to scan.
 * @param config - Optional runtime slot-policy overrides.
 * @returns Duplicate exclusive-slot groups in first-seen claim-key order.
 */
export function detectDuplicateExclusiveSlotGroups(durables: Durable[], config?: ClaimSlotPolicyConfig): DuplicateSlotGroup[] {
  const byClaimKey = new Map<string, Durable[]>();
  for (const durable of durables) {
    const claimKey = durable.claim_key?.trim();
    if (!claimKey || !isActiveForSlotCollapse(durable)) {
      continue;
    }

    const group = byClaimKey.get(claimKey);
    if (group) {
      group.push(durable);
    } else {
      byClaimKey.set(claimKey, [durable]);
    }
  }

  const groups: DuplicateSlotGroup[] = [];
  for (const [claimKey, members] of byClaimKey) {
    if (members.length < 2) {
      continue;
    }

    if (resolveClaimSlotPolicy(claimKey, config).policy !== "exclusive") {
      continue;
    }

    groups.push({ claimKey, durables: members });
  }

  return groups;
}

/**
 * Selects the canonical survivor for one duplicate exclusive-slot group.
 *
 * Order of preference: trusted claim-key status over any other status, then
 * highest importance, then newest `created_at`, then lexicographically smallest
 * id as the final deterministic tiebreaker.
 *
 * @param durables - Group members occupying the same exclusive slot.
 * @returns Collapse plan with the survivor and the rows it supersedes.
 */
export function planDuplicateSlotCollapse(durables: Durable[]): DuplicateSlotCollapsePlan {
  if (durables.length === 0) {
    throw new Error("Cannot plan a duplicate slot collapse for an empty group.");
  }

  const ranked = [...durables].sort(compareSurvivorPreference);
  const survivor = ranked[0]!;
  return {
    survivor,
    losers: ranked.slice(1),
  };
}

/**
 * Returns whether one duplicate-slot group is safe to collapse automatically.
 *
 * Auto-apply requires every member to share the same durable type and carry a
 * trusted claim-key status. Mixed groups stay as operator-reviewed proposals.
 *
 * @param durables - Group members occupying the same exclusive slot.
 * @returns True when the group can be collapsed without operator review.
 */
export function isDuplicateSlotCollapseAutoApplyEligible(durables: Durable[]): boolean {
  if (durables.length < 2) {
    return false;
  }

  const type = durables[0]!.type;
  return durables.every((durable) => durable.type === type && durable.claim_key_status === "trusted");
}

/** Comparator ordering durables from most to least preferred survivor. */
function compareSurvivorPreference(a: Durable, b: Durable): number {
  const trustedA = a.claim_key_status === "trusted" ? 1 : 0;
  const trustedB = b.claim_key_status === "trusted" ? 1 : 0;
  if (trustedA !== trustedB) {
    return trustedB - trustedA;
  }

  if (a.importance !== b.importance) {
    return b.importance - a.importance;
  }

  const createdA = Date.parse(a.created_at);
  const createdB = Date.parse(b.created_at);
  if (!Number.isNaN(createdA) && !Number.isNaN(createdB) && createdA !== createdB) {
    return createdB - createdA;
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
