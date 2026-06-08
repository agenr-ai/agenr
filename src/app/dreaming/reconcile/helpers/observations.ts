import type { ClaimKeyHealthSnapshot, ReconcilePassSummary } from "../../../../core/dreaming/types.js";
import {
  SHADOW_BUCKET_ORDER,
  SHADOW_RESONANCE_MIN_CONFIDENCE,
  SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT,
  SHADOW_RESONANCE_MIN_GROUNDED_RATIO,
} from "../constants.js";
import type { ReconcilePassContext } from "../pass-context.js";
import type {
  ClaimKeyAliasConvergenceDecisionStats,
  EntityFamilyConvergenceDecisionStats,
  MissingBackfillDecisionStats,
  SiblingSlotResonanceShadowStats,
} from "../types.js";
import { describeShadowBucket } from "./utils.js";

/** Builds a completion observation for entity-family convergence decisions. */
export function buildEntityFamilyConvergenceObservation(stats: EntityFamilyConvergenceDecisionStats): string | null {
  if (stats.appliedClusters === 0 && stats.proposedClusters === 0) {
    return null;
  }

  return (
    `Entity-family convergence auto-applied ${stats.appliedDurables} durable rewrite${stats.appliedDurables === 1 ? "" : "s"} ` +
    `across ${stats.appliedClusters} family cluster${stats.appliedClusters === 1 ? "" : "s"} and staged ${stats.proposedClusters} ` +
    `unresolved family proposal${stats.proposedClusters === 1 ? "" : "s"}.`
  );
}

/** Builds a completion observation for same-entity claim-key alias convergence decisions. */
export function buildClaimKeyAliasConvergenceObservation(stats: ClaimKeyAliasConvergenceDecisionStats): string | null {
  if (stats.appliedClusters === 0 && stats.proposedClusters === 0) {
    return null;
  }

  return (
    `Claim-key alias convergence auto-applied ${stats.appliedDurables} durable rewrite${stats.appliedDurables === 1 ? "" : "s"} ` +
    `across ${stats.appliedClusters} alias cluster${stats.appliedClusters === 1 ? "" : "s"} and staged ${stats.proposedClusters} ` +
    `alias proposal${stats.proposedClusters === 1 ? "" : "s"}.`
  );
}

/** Builds a completion observation for missing-key backfill decisions. */
export function buildMissingDecisionObservation(stats: MissingBackfillDecisionStats): string | null {
  const autoAppliedParts = [
    stats.autoAppliedTrustedGroupReuse > 0 ? `${stats.autoAppliedTrustedGroupReuse} trusted-group reuses` : null,
    stats.autoAppliedMetadataRepair > 0 ? `${stats.autoAppliedMetadataRepair} metadata-grounded backfills` : null,
    stats.autoAppliedDeterministicRepair > 0 ? `${stats.autoAppliedDeterministicRepair} deterministic repairs` : null,
    stats.autoAppliedSupportedPreview > 0 ? `${stats.autoAppliedSupportedPreview} supported preview auto-applies` : null,
    stats.autoAppliedPreviewModel > 0 ? `${stats.autoAppliedPreviewModel} high-confidence preview suggestions` : null,
  ].filter((value): value is string => value !== null);
  const proposalParts = [
    stats.proposedTrustedGroupReuse > 0 ? `${stats.proposedTrustedGroupReuse} trusted-group reuse proposals` : null,
    stats.proposedSupportedCandidate > 0 ? `${stats.proposedSupportedCandidate} supported preview proposals` : null,
    stats.proposedPreviewCandidate > 0 ? `${stats.proposedPreviewCandidate} plain preview proposals` : null,
  ].filter((value): value is string => value !== null);
  if (autoAppliedParts.length === 0 && proposalParts.length === 0) {
    return null;
  }

  return `Missing-key decisions used ${autoAppliedParts.join(", ") || "no auto-applies"} and ${proposalParts.join(", ") || "no proposals"} after structural reuse checks.`;
}

/** Builds a completion observation for grounded-family promotion decisions. */
export function buildGroundedFamilyPromotionObservation(stats: MissingBackfillDecisionStats): string | null {
  const observations = [
    stats.autoAppliedGroundedFamilyPromotion > 0 || stats.proposedGroundedFamilyPromotion > 0
      ? `Grounded-family promotion auto-applied ${stats.autoAppliedGroundedFamilyPromotion} candidate${stats.autoAppliedGroundedFamilyPromotion === 1 ? "" : "s"} and staged ${stats.proposedGroundedFamilyPromotion} proposal${stats.proposedGroundedFamilyPromotion === 1 ? "" : "s"}.`
      : null,
    stats.autoAppliedRelaxedStableSlotPromotion > 0 || stats.proposedRelaxedStableSlotPromotion > 0
      ? `Relaxed stable-slot promotion auto-applied ${stats.autoAppliedRelaxedStableSlotPromotion} candidate${stats.autoAppliedRelaxedStableSlotPromotion === 1 ? "" : "s"} and staged ${stats.proposedRelaxedStableSlotPromotion} proposal${stats.proposedRelaxedStableSlotPromotion === 1 ? "" : "s"} after accepting one grounded family sibling.`
      : null,
  ].filter((value): value is string => value !== null);

  if (observations.length === 0) {
    return null;
  }

  return observations.join(" ");
}

/** Builds a completion observation for sibling-slot resonance shadow telemetry. */
export function buildSiblingSlotResonanceObservation(stats: SiblingSlotResonanceShadowStats): string | null {
  if (stats.thresholdOnlyCandidateCount === 0) {
    return null;
  }

  const bucketSummary = SHADOW_BUCKET_ORDER.map((bucket) => {
    const bucketStats = stats.buckets.get(bucket);
    const label = describeShadowBucket(bucket);
    return `${label} ${bucketStats?.resonanceFiredCount ?? 0}/${bucketStats?.candidateCount ?? 0}`;
  }).join(", ");

  return (
    `Shadow sibling-slot resonance fired for ${stats.resonanceFiredCount}/${stats.thresholdOnlyCandidateCount} threshold-only candidates ` +
    `(${bucketSummary}).`
  );
}

/** Builds a completion observation for candidates that the shadow rule would qualify. */
export function buildSiblingSlotResonanceShadowRuleObservation(stats: SiblingSlotResonanceShadowStats): string | null {
  if (stats.thresholdOnlyCandidateCount === 0) {
    return null;
  }

  if (stats.shadowQualifiedCount === 0) {
    return (
      "Shadow sibling-slot-resonance rule would have qualified 0 candidates " +
      `under grounded-family counts >= ${SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT}, grounded ratio >= ${SHADOW_RESONANCE_MIN_GROUNDED_RATIO.toFixed(2)}, ` +
      `confidence >= ${SHADOW_RESONANCE_MIN_CONFIDENCE.toFixed(2)}, and sibling-slot resonance.`
    );
  }

  return (
    `Shadow sibling-slot-resonance rule would have qualified ${stats.shadowQualifiedCount} candidate` +
    `${stats.shadowQualifiedCount === 1 ? "" : "s"}: ${stats.shadowQualifiedClaimKeys.join(", ")}.`
  );
}

/** Builds a completion observation for compact canonicalization decisions. */
export function buildMissingCompactionObservation(stats: MissingBackfillDecisionStats): string | null {
  if (stats.autoAppliedCompactedCandidate === 0 && stats.proposedCompactedCandidate === 0) {
    return null;
  }

  return (
    `Compact canonicalization rewrote ${stats.autoAppliedCompactedCandidate} missing-key candidate` +
    `${stats.autoAppliedCompactedCandidate === 1 ? "" : "s"} before auto-apply and ${stats.proposedCompactedCandidate} ` +
    `before unresolved proposal logging.`
  );
}

/**
 * Builds the completion observations appended to the reconcile pass summary.
 *
 * @param ctx - Mutable reconcile pass context after stage processing.
 * @param input - Working-set health snapshot and execution style metadata.
 * @returns Ordered observation strings for the completion summary.
 */
export function buildReconcilePassObservations(
  ctx: ReconcilePassContext,
  input: {
    before: ClaimKeyHealthSnapshot;
    executionStyle: ReconcilePassSummary["executionStyle"];
  },
): string[] {
  const { counts, missingDecisionStats, siblingSlotResonanceShadowStats, entityFamilyDecisionStats, aliasConvergenceDecisionStats } = ctx.telemetry;
  const observations = [
    `Reconcile reviewed ${input.before.totalDurables} durable${input.before.totalDurables === 1 ? "" : "s"} in ${input.executionStyle} mode.`,
    `Identified ${counts.identifiedNormalizations} normalizations, ${counts.identifiedBackfills} backfills, ${counts.identifiedMetadataRewrites} metadata-backed suspect-key rewrites, ${counts.identifiedEntityFamilyConvergences} entity-family convergence rewrites, and ${counts.identifiedAliasConvergences} claim-key alias convergence rewrites.`,
    `Emitted ${counts.proposalsEmitted} unresolved proposal${counts.proposalsEmitted === 1 ? "" : "s"}.`,
  ];

  if (counts.skippedNoClaim > 0 || counts.skippedLowConfidence > 0 || counts.skippedCollision > 0) {
    observations.push(
      `Skipped ${counts.skippedNoClaim} no-claim cases, ${counts.skippedLowConfidence} low-confidence cases, and ${counts.skippedCollision} collision cases.`,
    );
  }

  if (counts.flaggedAmbiguousProposals > 0) {
    observations.push(`Flagged ${counts.flaggedAmbiguousProposals} ambiguous proposal${counts.flaggedAmbiguousProposals === 1 ? "" : "s"} for later review.`);
  }

  const missingDecisionObservation = buildMissingDecisionObservation(missingDecisionStats);
  if (missingDecisionObservation) {
    observations.push(missingDecisionObservation);
  }

  const groundedFamilyObservation = buildGroundedFamilyPromotionObservation(missingDecisionStats);
  if (groundedFamilyObservation) {
    observations.push(groundedFamilyObservation);
  }

  if (ctx.options.includeShadowTelemetry === true) {
    const siblingSlotResonanceObservation = buildSiblingSlotResonanceObservation(siblingSlotResonanceShadowStats);
    if (siblingSlotResonanceObservation) {
      observations.push(siblingSlotResonanceObservation);
    }

    const siblingSlotResonanceShadowRuleObservation = buildSiblingSlotResonanceShadowRuleObservation(siblingSlotResonanceShadowStats);
    if (siblingSlotResonanceShadowRuleObservation) {
      observations.push(siblingSlotResonanceShadowRuleObservation);
    }
  }

  const missingCompactionObservation = buildMissingCompactionObservation(missingDecisionStats);
  if (missingCompactionObservation) {
    observations.push(missingCompactionObservation);
  }

  if (missingDecisionStats.noClaimWithWarnings > 0) {
    observations.push(
      `${missingDecisionStats.noClaimWithWarnings} missing-key previews ended without a safe claim after deterministic validation warnings or malformed output.`,
    );
  }

  const entityFamilyObservation = buildEntityFamilyConvergenceObservation(entityFamilyDecisionStats);
  if (entityFamilyObservation) {
    observations.push(entityFamilyObservation);
  }

  const aliasConvergenceObservation = buildClaimKeyAliasConvergenceObservation(aliasConvergenceDecisionStats);
  if (aliasConvergenceObservation) {
    observations.push(aliasConvergenceObservation);
  }

  return observations;
}

/**
 * Builds reconcile pass recommendations from post-pass health and breaker state.
 *
 * @param ctx - Mutable reconcile pass context after stage processing.
 * @param actualAfter - Health snapshot from the actual working set.
 * @returns Recommendation strings for the completion summary.
 */
export function buildReconcilePassRecommendations(ctx: ReconcilePassContext, actualAfter: ClaimKeyHealthSnapshot): string[] {
  const recommendations: string[] = [];
  const circuitBreakerMessage = ctx.telemetry.circuitBreaker?.message;
  if (circuitBreakerMessage) {
    recommendations.push(circuitBreakerMessage);
  }

  if (actualAfter.exactKeyMultiActiveClusterCount > 0) {
    recommendations.push(
      `Exact-key multi-active clusters remain at ${actualAfter.exactKeyMultiActiveClusterCount}. Run supersession after reconcile to adjudicate lineage separately.`,
    );
  }

  return recommendations;
}
