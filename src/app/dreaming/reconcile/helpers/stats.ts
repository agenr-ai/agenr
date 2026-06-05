import type { ReconcileRepairCounts } from "../../../../core/dreaming/types.js";
import { SHADOW_BUCKET_ORDER } from "../constants.js";
import type { DurableSuggestionRecord, EntityFamilyConvergenceDecisionStats, MissingBackfillDecisionStats, SiblingSlotResonanceShadowStats } from "../types.js";

export function createEmptyMissingBackfillDecisionStats(): MissingBackfillDecisionStats {
  return {
    autoAppliedTrustedGroupReuse: 0,
    autoAppliedDeterministicRepair: 0,
    autoAppliedMetadataRepair: 0,
    autoAppliedSupportedPreview: 0,
    autoAppliedGroundedFamilyPromotion: 0,
    autoAppliedRelaxedStableSlotPromotion: 0,
    autoAppliedPreviewModel: 0,
    autoAppliedCompactedCandidate: 0,
    proposedTrustedGroupReuse: 0,
    proposedSupportedCandidate: 0,
    proposedGroundedFamilyPromotion: 0,
    proposedRelaxedStableSlotPromotion: 0,
    proposedPreviewCandidate: 0,
    proposedCompactedCandidate: 0,
    noClaimWithWarnings: 0,
  };
}

export function createEmptySiblingSlotResonanceShadowStats(): SiblingSlotResonanceShadowStats {
  return {
    thresholdOnlyCandidateCount: 0,
    resonanceApplicableCount: 0,
    resonanceFiredCount: 0,
    shadowQualifiedCount: 0,
    resonanceFiredClaimKeys: [],
    shadowQualifiedClaimKeys: [],
    buckets: new Map(
      SHADOW_BUCKET_ORDER.map((bucket) => [
        bucket,
        {
          candidateCount: 0,
          resonanceApplicableCount: 0,
          resonanceFiredCount: 0,
          shadowQualifiedCount: 0,
        },
      ]),
    ),
  };
}

export function createEmptyEntityFamilyConvergenceDecisionStats(): EntityFamilyConvergenceDecisionStats {
  return {
    appliedClusters: 0,
    appliedDurables: 0,
    proposedClusters: 0,
  };
}

export function createEmptyRepairCounts(): ReconcileRepairCounts {
  return {
    identifiedNormalizations: 0,
    appliedNormalizations: 0,
    identifiedBackfills: 0,
    appliedBackfills: 0,
    identifiedMetadataRewrites: 0,
    appliedMetadataRewrites: 0,
    identifiedEntityFamilyConvergences: 0,
    appliedEntityFamilyConvergences: 0,
    proposalsEmitted: 0,
    skippedNoClaim: 0,
    skippedLowConfidence: 0,
    skippedCollision: 0,
    flaggedAmbiguousProposals: 0,
  };
}

export function createEmptySuggestionRecord(): DurableSuggestionRecord {
  return {
    suggestion: null,
    warnings: [],
    previewOutcome: null,
  };
}

export function cloneRepairCounts(counts: ReconcileRepairCounts): ReconcileRepairCounts {
  return {
    identifiedNormalizations: counts.identifiedNormalizations,
    appliedNormalizations: counts.appliedNormalizations,
    identifiedBackfills: counts.identifiedBackfills,
    appliedBackfills: counts.appliedBackfills,
    identifiedMetadataRewrites: counts.identifiedMetadataRewrites,
    appliedMetadataRewrites: counts.appliedMetadataRewrites,
    identifiedEntityFamilyConvergences: counts.identifiedEntityFamilyConvergences,
    appliedEntityFamilyConvergences: counts.appliedEntityFamilyConvergences,
    proposalsEmitted: counts.proposalsEmitted,
    skippedNoClaim: counts.skippedNoClaim,
    skippedLowConfidence: counts.skippedLowConfidence,
    skippedCollision: counts.skippedCollision,
    flaggedAmbiguousProposals: counts.flaggedAmbiguousProposals,
  };
}
