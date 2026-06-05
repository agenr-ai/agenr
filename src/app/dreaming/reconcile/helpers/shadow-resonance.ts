import type { ReconcilePassSummary, ReconcileShadowBucket, ReconcileShadowBucketSummary } from "../../../../core/dreaming/types.js";
import {
  SHADOW_BUCKET_ORDER,
  SHADOW_RESONANCE_MIN_CONFIDENCE,
  SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT,
  SHADOW_RESONANCE_MIN_GROUNDED_RATIO,
} from "../constants.js";
import type { MissingBackfillShadowAudit, MissingBackfillSupportEvaluation, SiblingSlotResonanceShadowStats } from "../types.js";
import { normalizeStringArray } from "./utils.js";

/** Builds summary telemetry for the sibling-slot resonance shadow rule. */
export function buildSiblingSlotResonanceShadowSummary(stats: SiblingSlotResonanceShadowStats): ReconcilePassSummary["shadowSiblingSlotResonance"] {
  if (stats.thresholdOnlyCandidateCount === 0) {
    return null;
  }

  const buckets: ReconcileShadowBucketSummary[] = SHADOW_BUCKET_ORDER.map((bucket) => {
    const bucketStats = stats.buckets.get(bucket);
    return {
      bucket,
      candidateCount: bucketStats?.candidateCount ?? 0,
      resonanceApplicableCount: bucketStats?.resonanceApplicableCount ?? 0,
      resonanceFiredCount: bucketStats?.resonanceFiredCount ?? 0,
      shadowQualifiedCount: bucketStats?.shadowQualifiedCount ?? 0,
    };
  });

  return {
    rule: {
      supportClass: "trusted_family_grounded_alignment",
      minFamilyReuseCount: SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT,
      minGroundedRatio: SHADOW_RESONANCE_MIN_GROUNDED_RATIO,
      minConfidence: SHADOW_RESONANCE_MIN_CONFIDENCE,
      requiresSiblingSlotResonance: true,
    },
    thresholdOnlyCandidateCount: stats.thresholdOnlyCandidateCount,
    resonanceApplicableCount: stats.resonanceApplicableCount,
    resonanceFiredCount: stats.resonanceFiredCount,
    shadowQualifiedCount: stats.shadowQualifiedCount,
    resonanceFiredClaimKeys: [...stats.resonanceFiredClaimKeys],
    shadowQualifiedClaimKeys: [...stats.shadowQualifiedClaimKeys],
    buckets,
  };
}

/** Classifies a below-threshold supported backfill into a shadow telemetry bucket. */
export function resolveThresholdOnlyShadowBucket(support: MissingBackfillSupportEvaluation): ReconcileShadowBucket | null {
  if (support.relaxedStableSlotFamilyGate) {
    return "relaxed_one_sibling_stable_slot";
  }

  if (support.autoApplyClass !== "trusted_family_grounded_alignment") {
    return null;
  }

  const groundedRatio = support.familyReuseCount > 0 ? support.groundedFamilyReuseCount / support.familyReuseCount : 0;
  if (support.familyReuseCount >= SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT) {
    return groundedRatio >= SHADOW_RESONANCE_MIN_GROUNDED_RATIO ? "high_density_grounded_family" : "large_grounding_diluted_grounded_family";
  }

  if (support.familyReuseCount <= 5) {
    return "thin_grounded_family_tail";
  }

  return "other_grounded_family_alignment";
}

/** Builds shadow telemetry for a missing-key candidate blocked only by threshold. */
export function buildMissingBackfillShadowAudit(input: {
  support: MissingBackfillSupportEvaluation;
  confidence: number;
  autoApplyBlocker: string | null;
}): MissingBackfillShadowAudit | null {
  if (input.autoApplyBlocker !== "below_auto_apply_threshold") {
    return null;
  }

  const bucket = resolveThresholdOnlyShadowBucket(input.support);
  if (!bucket) {
    return null;
  }

  const groundedRatio = input.support.familyReuseCount > 0 ? input.support.groundedFamilyReuseCount / input.support.familyReuseCount : 0;
  return {
    thresholdOnlyBucket: bucket,
    shadowWouldQualify:
      input.support.autoApplyClass === "trusted_family_grounded_alignment" &&
      input.support.familyReuseCount >= SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT &&
      groundedRatio >= SHADOW_RESONANCE_MIN_GROUNDED_RATIO &&
      input.confidence >= SHADOW_RESONANCE_MIN_CONFIDENCE &&
      input.support.siblingSlotResonance.fired,
  };
}

/** Records sibling-slot resonance shadow counters for one threshold-only candidate. */
export function recordSiblingSlotResonanceShadowCandidate(
  stats: SiblingSlotResonanceShadowStats,
  claimKey: string,
  support: MissingBackfillSupportEvaluation,
  shadow: MissingBackfillShadowAudit,
): void {
  stats.thresholdOnlyCandidateCount += 1;
  if (support.siblingSlotResonance.applicable) {
    stats.resonanceApplicableCount += 1;
  }
  if (support.siblingSlotResonance.fired) {
    stats.resonanceFiredCount += 1;
    stats.resonanceFiredClaimKeys = normalizeStringArray([...stats.resonanceFiredClaimKeys, claimKey]);
  }
  if (shadow.shadowWouldQualify) {
    stats.shadowQualifiedCount += 1;
    stats.shadowQualifiedClaimKeys = normalizeStringArray([...stats.shadowQualifiedClaimKeys, claimKey]);
  }

  const bucketStats = stats.buckets.get(shadow.thresholdOnlyBucket);
  if (!bucketStats) {
    return;
  }

  bucketStats.candidateCount += 1;
  if (support.siblingSlotResonance.applicable) {
    bucketStats.resonanceApplicableCount += 1;
  }
  if (support.siblingSlotResonance.fired) {
    bucketStats.resonanceFiredCount += 1;
  }
  if (shadow.shadowWouldQualify) {
    bucketStats.shadowQualifiedCount += 1;
  }
}
