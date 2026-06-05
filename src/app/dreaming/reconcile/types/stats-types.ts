import type { ClaimKeySupportEvaluation } from "../../../../core/claim-key-support.js";
import type { ClaimKeyEntityFamilyEvidence } from "../../../../core/claim-key-entity-family.js";
import type { ReconcileCircuitBreakerKind, ReconcileShadowBucket } from "../../../../core/dreaming/types.js";
import type { ClaimExtractionPreviewOutcome, ClaimExtractionResult } from "../../../../core/store/claim-extraction.js";
import type { DurableKind } from "../../../../core/types.js";
import type { SiblingSlotResonanceEvaluation } from "../../../../core/claim-key-slot-resonance.js";
import type { MissingBackfillPromotionLane } from "../constants.js";

export interface ClaimKeyCircuitBreakerState {
  totalAutoMutations: number;
  blockedCollisions: number;
  appliedByClaimKey: Map<string, number>;
  appliedByEntity: Map<string, number>;
}

export interface ClaimKeyCircuitBreakerTrip {
  kind: ReconcileCircuitBreakerKind;
  message: string;
}

export interface TrustedGroupReuseCandidate {
  claimKey: string;
  supportingDurableIds: string[];
}

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

export interface TrustedCleanupHintSeed {
  globalEntityHints: string[];
  globalClaimKeyExamples: string[];
  durables: TrustedCleanupHintDurable[];
}

export type MissingBackfillSupportEvaluation = ClaimKeySupportEvaluation & {
  siblingSlotResonance: SiblingSlotResonanceEvaluation;
};

export interface MissingBackfillPromotionPolicy {
  lane: MissingBackfillPromotionLane;
  autoApplyThreshold: number;
}

export interface MissingBackfillSkipDiagnostic {
  durableId: string;
  outcome: "no_claim" | "malformed_output" | "rejected_candidate" | "low_confidence_candidate";
  confidence: number | null;
  path: ClaimExtractionResult["path"] | ClaimExtractionPreviewOutcome["path"] | null;
  warning: string | null;
  suggestedClaimKey: string | null;
}

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

export interface SiblingSlotResonanceShadowBucketStats {
  candidateCount: number;
  resonanceApplicableCount: number;
  resonanceFiredCount: number;
  shadowQualifiedCount: number;
}

export interface SiblingSlotResonanceShadowStats {
  thresholdOnlyCandidateCount: number;
  resonanceApplicableCount: number;
  resonanceFiredCount: number;
  shadowQualifiedCount: number;
  resonanceFiredClaimKeys: string[];
  shadowQualifiedClaimKeys: string[];
  buckets: Map<ReconcileShadowBucket, SiblingSlotResonanceShadowBucketStats>;
}

export interface MissingBackfillShadowAudit {
  thresholdOnlyBucket: ReconcileShadowBucket;
  shadowWouldQualify: boolean;
}

export interface EntityFamilyConvergenceDecisionStats {
  appliedClusters: number;
  appliedDurables: number;
  proposedClusters: number;
}

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
