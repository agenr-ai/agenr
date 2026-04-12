/**
 * Structured claim-key health snapshot captured before or after one pass.
 */
export interface ClaimKeyHealthSnapshot {
  totalEntries: number;
  activeEntries: number;
  coverageCount: number;
  coveragePct: number;
  missingCount: number;
  eligibleMissingCount: number;
  malformedOrNoncanonicalCount: number;
  suspectCanonicalCount: number;
  entityFamilyGroupCount: number;
  suspiciousSingletonAliasCount: number;
  mixedGroupCount: number;
  exactKeyMultiActiveClusterCount: number;
}

/**
 * Aggregate repair counts captured during one claim-key-quality run.
 */
export interface ClaimKeyQualityRepairCounts {
  identifiedNormalizations: number;
  appliedNormalizations: number;
  identifiedBackfills: number;
  appliedBackfills: number;
  identifiedMetadataRewrites: number;
  appliedMetadataRewrites: number;
  identifiedEntityFamilyConvergences: number;
  appliedEntityFamilyConvergences: number;
  proposalsEmitted: number;
  skippedNoClaim: number;
  skippedLowConfidence: number;
  skippedCollision: number;
  skippedAmbiguous: number;
}

/**
 * Threshold-only cohort bucket used by shadow sibling-slot-resonance reporting.
 */
export type ClaimKeyQualityShadowBucket =
  | "high_density_grounded_family"
  | "large_grounding_diluted_grounded_family"
  | "thin_grounded_family_tail"
  | "relaxed_one_sibling_stable_slot"
  | "other_grounded_family_alignment";

/**
 * Stable machine-readable circuit-breaker categories for claim-key-quality runs.
 */
export type ClaimKeyQualityCircuitBreakerKind = "claim_key_concentration" | "entity_prefix_concentration" | "collision_spike";

/**
 * Summary counts for one threshold-only shadow-evaluation bucket.
 */
export interface ClaimKeyQualityShadowBucketSummary {
  bucket: ClaimKeyQualityShadowBucket;
  candidateCount: number;
  resonanceApplicableCount: number;
  resonanceFiredCount: number;
  shadowQualifiedCount: number;
}

/**
 * Shadow-only sibling-slot-resonance summary captured for threshold-only supported cases.
 */
export interface ClaimKeyQualitySiblingSlotResonanceShadowSummary {
  rule: {
    supportClass: "trusted_family_grounded_alignment";
    minFamilyReuseCount: number;
    minGroundedRatio: number;
    minConfidence: number;
    requiresSiblingSlotResonance: true;
  };
  thresholdOnlyCandidateCount: number;
  resonanceApplicableCount: number;
  resonanceFiredCount: number;
  shadowQualifiedCount: number;
  resonanceFiredClaimKeys: string[];
  shadowQualifiedClaimKeys: string[];
  buckets: ClaimKeyQualityShadowBucketSummary[];
}

/**
 * Structured claim-key-quality pass summary persisted on the surgeon run.
 */
export interface ClaimKeyQualityPassSummary {
  executionStyle: "autonomous" | "targeted";
  workingSet: {
    includeInactive: boolean;
    project: string | null;
    type: string | null;
    claimKeyPrefix: string | null;
    entryIds: string[];
  };
  before: ClaimKeyHealthSnapshot;
  after: ClaimKeyHealthSnapshot;
  projectedAfter?: ClaimKeyHealthSnapshot;
  counts: ClaimKeyQualityRepairCounts;
  shadowSiblingSlotResonance?: ClaimKeyQualitySiblingSlotResonanceShadowSummary | null;
  circuitBreaker?: {
    kind: ClaimKeyQualityCircuitBreakerKind;
    message: string;
  } | null;
}

/**
 * Structured unresolved claim-key proposal persisted for later adjudication.
 */
export type SurgeonProposalReviewStatus = "open" | "applied" | "rejected";

/**
 * Structured unresolved claim-key proposal persisted for later adjudication.
 */
export interface SurgeonRunProposal {
  id: string;
  runId: string;
  groupId: string;
  issueKind: string;
  scope: "single_entry" | "cluster";
  entryIds: string[];
  currentClaimKeys: string[];
  proposedClaimKeys: string[];
  rationale: string;
  confidence: number;
  source: string;
  eligibleForApply: boolean;
  createdAt: string;
  reviewStatus: SurgeonProposalReviewStatus;
  reviewedAt: string | null;
  reviewReason: string | null;
  appliedActionCount: number;
}

/**
 * Lifecycle states for one surgeon run.
 */
export type SurgeonRunStatus = "running" | "completed" | "failed" | "aborted" | "budget_exhausted" | "cost_capped" | "no_work" | "stalled";

/**
 * Minimal persisted completion summary for a surgeon run.
 */
export interface SurgeonCompletionSummary {
  actions_taken: number;
  entries_skipped: Array<{
    entry_id?: string;
    reason: string;
  }>;
  observations: string[];
  recommendations: string[];
  claim_key_quality?: ClaimKeyQualityPassSummary;
}
