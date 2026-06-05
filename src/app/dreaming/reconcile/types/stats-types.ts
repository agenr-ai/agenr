import type { ClaimKeySupportEvaluation } from "../../../../core/claim-key-support.js";
import type { ClaimKeyEntityFamilyEvidence } from "../../../../core/claim-key-entity-family.js";
import type { ReconcileCircuitBreakerKind, ReconcileShadowBucket } from "../../../../core/dreaming/types.js";
import type { ClaimExtractionPreviewOutcome, ClaimExtractionResult } from "../../../../core/store/claim-extraction.js";
import type { DurableKind } from "../../../../core/types.js";
import type { SiblingSlotResonanceEvaluation } from "../../../../core/claim-key-slot-resonance.js";
import type { MissingBackfillPromotionLane } from "../constants.js";

/** Mutable counters used to detect unsafe auto-repair concentration. */
export interface ClaimKeyCircuitBreakerState {
  totalAutoMutations: number;
  blockedCollisions: number;
  appliedByClaimKey: Map<string, number>;
  appliedByEntity: Map<string, number>;
}

/** Circuit-breaker trip returned when reconcile auto-repairs become unsafe. */
export interface ClaimKeyCircuitBreakerTrip {
  kind: ReconcileCircuitBreakerKind;
  message: string;
}

/** Trusted claim key that can be reused from matched subject/type peers. */
export interface TrustedGroupReuseCandidate {
  claimKey: string;
  supportingDurableIds: string[];
}

/** Trusted durable summary used as grounding for claim-key cleanup hints. */
export interface TrustedCleanupHintDurable {
  id: string;
  claimKey: string;
  entity: string;
  attribute: string;
  type?: DurableKind;
  tags: string[];
  sourceContextTokens: string[];
  subjectTokens: string[];
  createdAt: string;
}

/** Global trusted hint seed shared across durable-specific previews. */
export interface TrustedCleanupHintSeed {
  globalEntityHints: string[];
  globalClaimKeyExamples: string[];
  durables: TrustedCleanupHintDurable[];
}

/** Support evaluation for a missing-key backfill, including sibling-slot resonance. */
export type MissingBackfillSupportEvaluation = ClaimKeySupportEvaluation & {
  siblingSlotResonance: SiblingSlotResonanceEvaluation;
};

/** Threshold lane selected for a missing-key backfill candidate. */
export interface MissingBackfillPromotionPolicy {
  lane: MissingBackfillPromotionLane;
  autoApplyThreshold: number;
}

/** Diagnostic record for one skipped missing-key backfill preview. */
export interface MissingBackfillSkipDiagnostic {
  durableId: string;
  outcome: "no_claim" | "malformed_output" | "rejected_candidate" | "low_confidence_candidate";
  confidence: number | null;
  path: ClaimExtractionResult["path"] | ClaimExtractionPreviewOutcome["path"] | null;
  warning: string | null;
  suggestedClaimKey: string | null;
}

/** Counters for missing-key backfill decisions in one reconcile pass. */
export interface MissingBackfillDecisionStats {
  autoAppliedTrustedGroupReuse: number;
  autoAppliedDeterministicRepair: number;
  autoAppliedMetadataRepair: number;
  autoAppliedSupportedPreview: number;
  autoAppliedGroundedFamilyPromotion: number;
  autoAppliedRelaxedStableSlotPromotion: number;
  autoAppliedPreviewModel: number;
  autoAppliedCompactedCandidate: number;
  proposedTrustedGroupReuse: number;
  proposedSupportedCandidate: number;
  proposedGroundedFamilyPromotion: number;
  proposedRelaxedStableSlotPromotion: number;
  proposedPreviewCandidate: number;
  proposedCompactedCandidate: number;
  noClaimWithWarnings: number;
}

/** Counters for one sibling-slot resonance shadow telemetry bucket. */
export interface SiblingSlotResonanceShadowBucketStats {
  candidateCount: number;
  resonanceApplicableCount: number;
  resonanceFiredCount: number;
  shadowQualifiedCount: number;
}

/** Aggregate sibling-slot resonance shadow telemetry for one reconcile pass. */
export interface SiblingSlotResonanceShadowStats {
  thresholdOnlyCandidateCount: number;
  resonanceApplicableCount: number;
  resonanceFiredCount: number;
  shadowQualifiedCount: number;
  resonanceFiredClaimKeys: string[];
  shadowQualifiedClaimKeys: string[];
  buckets: Map<ReconcileShadowBucket, SiblingSlotResonanceShadowBucketStats>;
}

/** Audit metadata for a threshold-only missing-key shadow candidate. */
export interface MissingBackfillShadowAudit {
  thresholdOnlyBucket: ReconcileShadowBucket;
  shadowWouldQualify: boolean;
}

/** Counters for entity-family convergence decisions in one reconcile pass. */
export interface EntityFamilyConvergenceDecisionStats {
  appliedClusters: number;
  appliedDurables: number;
  proposedClusters: number;
}

/** Audit metadata for one entity-family convergence decision. */
export interface EntityFamilyConvergenceAudit {
  competingEntityPrefixes: string[];
  canonicalEntityPrefix: string | null;
  canonicalSelectionReasons: string[];
  unresolvedReason: string | null;
  evidence: ClaimKeyEntityFamilyEvidence[];
  pairSupport: Array<{
    entityPrefixes: [string, string];
    supportingDurableIds: string[];
    sharedAttributes: string[];
    confidence: number;
    autoSafe: boolean;
    preferredCanonicalEntityPrefix: string | null;
    evidence: ClaimKeyEntityFamilyEvidence[];
  }>;
}
