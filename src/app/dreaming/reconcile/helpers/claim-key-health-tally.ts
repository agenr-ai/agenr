import type { Durable } from "../../../../core/types.js";
import { inspectExistingClaimKey, type ExistingClaimKeyInspection } from "./claim-key-inspection.js";

/**
 * Inspection outcome counts accumulated in one pass over a working set.
 */
export interface ClaimKeyInspectionTally {
  malformedOrNoncanonicalCount: number;
  suspectCanonicalCount: number;
  missingCount: number;
  eligibleMissingCount: number;
}

/**
 * Creates an empty inspection tally for one working-set scan.
 *
 * @returns Zeroed inspection counters.
 */
export function createEmptyClaimKeyInspectionTally(): ClaimKeyInspectionTally {
  return {
    malformedOrNoncanonicalCount: 0,
    suspectCanonicalCount: 0,
    missingCount: 0,
    eligibleMissingCount: 0,
  };
}

/**
 * Clones one inspection tally so projected and actual working sets can diverge safely.
 *
 * @param tally - Inspection tally to clone.
 * @returns Independent copy of the tally counters.
 */
export function cloneClaimKeyInspectionTally(tally: ClaimKeyInspectionTally): ClaimKeyInspectionTally {
  return {
    malformedOrNoncanonicalCount: tally.malformedOrNoncanonicalCount,
    suspectCanonicalCount: tally.suspectCanonicalCount,
    missingCount: tally.missingCount,
    eligibleMissingCount: tally.eligibleMissingCount,
  };
}

/**
 * Removes one durable inspection outcome from a tally.
 *
 * @param inspection - Existing claim-key inspection for one durable.
 * @param durableType - Durable type under inspection.
 * @param eligibleTypes - Durable types eligible for missing-key backfill.
 * @param tally - Mutable tally to update.
 */
export function untallyExistingClaimKeyInspection(
  inspection: ExistingClaimKeyInspection,
  durableType: string,
  eligibleTypes: readonly string[],
  tally: ClaimKeyInspectionTally,
): void {
  switch (inspection.kind) {
    case "malformed":
    case "noncanonical":
      tally.malformedOrNoncanonicalCount -= 1;
      break;
    case "suspect":
      tally.suspectCanonicalCount -= 1;
      break;
    case "missing":
      tally.missingCount -= 1;
      if (eligibleTypes.includes(durableType)) {
        tally.eligibleMissingCount -= 1;
      }
      break;
    default:
      break;
  }
}

/**
 * Re-inspects one durable and updates a tally from its previous inspection outcome.
 *
 * @param durable - Durable whose claim key may have changed.
 * @param previous - Inspection outcome recorded before the mutation.
 * @param eligibleTypes - Durable types eligible for missing-key backfill.
 * @param tally - Mutable tally to update.
 * @returns Fresh inspection outcome for the durable.
 */
export function refreshDurableInspectionTally(
  durable: Durable,
  previous: ExistingClaimKeyInspection,
  eligibleTypes: readonly string[],
  tally: ClaimKeyInspectionTally,
): ExistingClaimKeyInspection {
  const next = inspectExistingClaimKey(durable);
  untallyExistingClaimKeyInspection(previous, durable.type, eligibleTypes, tally);
  tallyExistingClaimKeyInspection(next, durable.type, eligibleTypes, tally);
  return next;
}

/**
 * Updates one inspection tally from a durable inspection outcome.
 *
 * @param inspection - Existing claim-key inspection for one durable.
 * @param durableType - Durable type under inspection.
 * @param eligibleTypes - Durable types eligible for missing-key backfill.
 * @param tally - Mutable tally to update.
 */
export function tallyExistingClaimKeyInspection(
  inspection: ExistingClaimKeyInspection,
  durableType: string,
  eligibleTypes: readonly string[],
  tally: ClaimKeyInspectionTally,
): void {
  switch (inspection.kind) {
    case "malformed":
    case "noncanonical":
      tally.malformedOrNoncanonicalCount += 1;
      break;
    case "suspect":
      tally.suspectCanonicalCount += 1;
      break;
    case "missing":
      tally.missingCount += 1;
      if (eligibleTypes.includes(durableType)) {
        tally.eligibleMissingCount += 1;
      }
      break;
    default:
      break;
  }
}
