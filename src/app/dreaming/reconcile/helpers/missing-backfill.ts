import type { ClaimKeyCompactnessEvaluation } from "../../../../core/claim-key-support.js";
import type { ClaimExtractionResult } from "../../../../core/store/claim-extraction.js";
import type { Durable } from "../../../../core/types.js";
import {
  COMPACTED_SUPPORTED_AUTO_APPLY_BACKFILL_THRESHOLD,
  HIGH_CONFIDENCE_BACKFILL_THRESHOLD,
  PROPOSAL_CONFIDENCE_THRESHOLD,
  STRUCTURED_AUTO_APPLY_BACKFILL_THRESHOLD,
  SUPPORTED_PROPOSAL_CONFIDENCE_THRESHOLD,
  type MissingBackfillPromotionLane,
} from "../constants.js";
import type {
  DurableSuggestionRecord,
  MissingBackfillDecisionStats,
  MissingBackfillPromotionPolicy,
  MissingBackfillSkipDiagnostic,
  MissingBackfillSupportEvaluation,
} from "../types.js";

export {
  buildMissingBackfillApplyRationale,
  buildMissingBackfillConflictRationale,
  buildMissingBackfillProposalRationale,
  describeMissingBackfillPromotionClass,
} from "./missing-backfill-rationale.js";

/**
 * Resolved preview metadata for one missing-key backfill candidate.
 */
export interface MissingBackfillResolvedPreview {
  targetClaimKey: string;
  targetSource: string;
  originalClaimKey: string;
  compactness: ClaimKeyCompactnessEvaluation;
  promotionPolicy: MissingBackfillPromotionPolicy;
  support: MissingBackfillSupportEvaluation;
  suggestion: ClaimExtractionResult;
  metadataBackfillClaimKey: string | null;
}

export function buildMissingBackfillSkipDiagnostic(
  durable: Durable,
  suggestionRecord: DurableSuggestionRecord,
  options: {
    outcomeOverride: MissingBackfillSkipDiagnostic["outcome"];
    suggestedClaimKey?: string;
  },
): MissingBackfillSkipDiagnostic {
  const previewPath = suggestionRecord.suggestion?.path ?? suggestionRecord.previewOutcome?.path ?? null;
  const previewConfidence =
    suggestionRecord.suggestion?.confidence ??
    (typeof suggestionRecord.previewOutcome?.confidence === "number" ? suggestionRecord.previewOutcome.confidence : null);

  return {
    durableId: durable.id,
    outcome: options.outcomeOverride,
    confidence: previewConfidence,
    path: previewPath,
    warning: suggestionRecord.warnings[0] ?? null,
    suggestedClaimKey: options.suggestedClaimKey ?? suggestionRecord.suggestion?.claimKey ?? null,
  };
}

export function formatMissingBackfillSkipDiagnostic(diagnostic: MissingBackfillSkipDiagnostic): string {
  const parts = [
    `missing_claim_key:${diagnostic.outcome}`,
    diagnostic.path ? `path=${diagnostic.path}` : null,
    typeof diagnostic.confidence === "number" ? `confidence=${diagnostic.confidence.toFixed(2)}` : null,
    diagnostic.suggestedClaimKey ? `suggested=${diagnostic.suggestedClaimKey}` : null,
    diagnostic.warning ? `warning=${diagnostic.warning}` : null,
  ].filter((value): value is string => value !== null);

  return parts.join(" ");
}

export function resolveMissingBackfillPromotionPolicy(input: {
  previewPath: ClaimExtractionResult["path"];
  metadataRepaired: boolean;
  support: MissingBackfillSupportEvaluation;
  compactness: ClaimKeyCompactnessEvaluation;
}): MissingBackfillPromotionPolicy {
  if (input.metadataRepaired) {
    return {
      lane: "metadata_rewrite",
      autoApplyThreshold: STRUCTURED_AUTO_APPLY_BACKFILL_THRESHOLD,
    };
  }

  if (input.previewPath === "deterministic_repair") {
    return {
      lane: "deterministic_repair",
      autoApplyThreshold: STRUCTURED_AUTO_APPLY_BACKFILL_THRESHOLD,
    };
  }

  if (input.support.autoApplyClass !== null && input.compactness.compactedFrom) {
    return {
      lane: "compacted_supported",
      autoApplyThreshold: COMPACTED_SUPPORTED_AUTO_APPLY_BACKFILL_THRESHOLD,
    };
  }

  if (input.support.autoApplyClass !== null) {
    return {
      lane: "structured_supported",
      autoApplyThreshold: STRUCTURED_AUTO_APPLY_BACKFILL_THRESHOLD,
    };
  }

  return {
    lane: "high_confidence_preview",
    autoApplyThreshold: HIGH_CONFIDENCE_BACKFILL_THRESHOLD,
  };
}

export function resolveMissingBackfillProposalThreshold(input: {
  previewPath: ClaimExtractionResult["path"];
  metadataRepaired: boolean;
  support: MissingBackfillSupportEvaluation;
}): number {
  if (input.metadataRepaired || input.previewPath === "deterministic_repair" || input.support.supportedProposal) {
    return SUPPORTED_PROPOSAL_CONFIDENCE_THRESHOLD;
  }

  return PROPOSAL_CONFIDENCE_THRESHOLD;
}

export function resolveMissingBackfillAutoApplyBlocker(input: {
  trusted: boolean;
  compactness: ClaimKeyCompactnessEvaluation;
  confidence: number;
  autoApplyThreshold: number;
}): string | null {
  if (!input.trusted) {
    return "structurally_suspect_claim_key";
  }

  if (!input.compactness.compactEnoughForAutoApply) {
    return input.compactness.blockerReason;
  }

  if (input.confidence < input.autoApplyThreshold) {
    return "below_auto_apply_threshold";
  }

  return null;
}

export function recordGroundedFamilyPromotionDecision(
  stats: MissingBackfillDecisionStats,
  support: MissingBackfillSupportEvaluation,
  decision: "auto_apply" | "proposal",
): void {
  if (support.autoApplyClass === "trusted_family_grounded_alignment") {
    if (decision === "auto_apply") {
      stats.autoAppliedGroundedFamilyPromotion += 1;
    } else {
      stats.proposedGroundedFamilyPromotion += 1;
    }
  }

  if (support.relaxedStableSlotFamilyGate) {
    if (decision === "auto_apply") {
      stats.autoAppliedRelaxedStableSlotPromotion += 1;
    } else {
      stats.proposedRelaxedStableSlotPromotion += 1;
    }
  }
}
