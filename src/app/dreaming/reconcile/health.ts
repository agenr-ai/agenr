import { detectClaimKeyEntityFamilyCandidates, detectClaimKeySingletonAliasCandidates } from "../../../core/claim-key-entity-family.js";
import type { ClaimKeyHealthSnapshot } from "../../../core/dreaming/types.js";
import type { Durable } from "../../../core/types.js";
import { inspectExistingClaimKey } from "./helpers/claim-key-inspection.js";
import { createEmptyClaimKeyInspectionTally, tallyExistingClaimKeyInspection, type ClaimKeyInspectionTally } from "./helpers/claim-key-health-tally.js";
import { countExactKeyMultiActiveClusters, isDurableActive } from "./helpers/durable.js";
import { findMixedKeyGroups } from "./helpers/mixed-groups.js";

/**
 * Builds a claim-key health snapshot using precomputed inspection counters.
 *
 * Inspection-class counts come from `tally`. Entity-family, mixed-group, and
 * exact-key cluster metrics still scan the current working set.
 *
 * @param durables - Durables included in the working set.
 * @param eligibleTypes - Durable types eligible for missing-key backfill.
 * @param tally - Inspection counts accumulated in one pass.
 * @returns Aggregate claim-key quality snapshot.
 */
export function buildClaimKeyHealthSnapshot(durables: Durable[], eligibleTypes: readonly string[], tally: ClaimKeyInspectionTally): ClaimKeyHealthSnapshot {
  const activeDurables = durables.filter((durable) => isDurableActive(durable));
  const withClaimKeys = durables.filter((durable) => typeof durable.claim_key === "string" && durable.claim_key.trim().length > 0);
  const entityFamilyCandidates = detectClaimKeyEntityFamilyCandidates(durables);
  const singletonAliasCandidates = detectClaimKeySingletonAliasCandidates(durables);

  return {
    totalDurables: durables.length,
    activeDurables: activeDurables.length,
    coverageCount: withClaimKeys.length,
    coveragePct: durables.length > 0 ? withClaimKeys.length / durables.length : 0,
    missingCount: tally.missingCount,
    eligibleMissingCount: tally.eligibleMissingCount,
    malformedOrNoncanonicalCount: tally.malformedOrNoncanonicalCount,
    suspectCanonicalCount: tally.suspectCanonicalCount,
    entityFamilyGroupCount: entityFamilyCandidates.length,
    suspiciousSingletonAliasCount: singletonAliasCandidates.length,
    mixedGroupCount: findMixedKeyGroups(durables).length,
    exactKeyMultiActiveClusterCount: countExactKeyMultiActiveClusters(activeDurables),
  };
}

/**
 * Inspects every durable once and returns the aggregate inspection tally.
 *
 * @param durables - Durables included in the working set.
 * @param eligibleTypes - Durable types eligible for missing-key backfill.
 * @returns Inspection counts accumulated in one pass.
 */
export function tallyClaimKeyHealthInspections(durables: Durable[], eligibleTypes: readonly string[]): ClaimKeyInspectionTally {
  const tally = createEmptyClaimKeyInspectionTally();

  for (const durable of durables) {
    tallyExistingClaimKeyInspection(inspectExistingClaimKey(durable), durable.type, eligibleTypes, tally);
  }

  return tally;
}

/**
 * Summarizes claim-key quality for one matched working set.
 *
 * @param durables - Durables included in the working set.
 * @param eligibleTypes - Durable types eligible for missing-key backfill.
 * @returns Aggregate claim-key quality snapshot.
 */
export function summarizeClaimKeyHealth(durables: Durable[], eligibleTypes: readonly string[]): ClaimKeyHealthSnapshot {
  return buildClaimKeyHealthSnapshot(durables, eligibleTypes, tallyClaimKeyHealthInspections(durables, eligibleTypes));
}
