import type { Durable } from "../../../../core/types.js";
import { HIGH_CONFIDENCE_BACKFILL_THRESHOLD } from "../constants.js";
import type { ReconcilePassContext } from "../pass-context.js";
import type { DurableSuggestionRecord } from "../types.js";
import { buildMissingBackfillSkipDiagnostic, recordGroundedFamilyPromotionDecision, type MissingBackfillResolvedPreview } from "./missing-backfill.js";
import { resolveMissingBackfillNullOutcome } from "./suggestions.js";

/**
 * Records telemetry for one missing-key preview that ended without a claim.
 */
export function recordMissingBackfillNoClaimOutcome(ctx: ReconcilePassContext, durable: Durable, suggestionRecord: DurableSuggestionRecord): void {
  if (suggestionRecord.warnings.length > 0) {
    ctx.telemetry.missingDecisionStats.noClaimWithWarnings += 1;
  }
  ctx.telemetry.counts.skippedNoClaim += 1;
  ctx.telemetry.skippedDiagnostics.push(
    buildMissingBackfillSkipDiagnostic(durable, suggestionRecord, {
      outcomeOverride: resolveMissingBackfillNullOutcome(suggestionRecord),
    }),
  );
}

/**
 * Records telemetry for one missing-key preview skipped as low confidence.
 */
export function recordMissingBackfillLowConfidenceSkip(
  ctx: ReconcilePassContext,
  durable: Durable,
  suggestionRecord: DurableSuggestionRecord,
  targetClaimKey: string,
): void {
  ctx.telemetry.counts.skippedLowConfidence += 1;
  ctx.telemetry.skippedDiagnostics.push(
    buildMissingBackfillSkipDiagnostic(durable, suggestionRecord, {
      outcomeOverride: "low_confidence_candidate",
      suggestedClaimKey: targetClaimKey,
    }),
  );
}

/**
 * Records proposal-lane counters for one below-threshold missing-key candidate.
 */
export function recordMissingBackfillProposalLaneOutcome(ctx: ReconcilePassContext, resolved: MissingBackfillResolvedPreview): void {
  if (resolved.metadataBackfillClaimKey !== null || resolved.suggestion.path === "deterministic_repair" || resolved.support.supportedProposal) {
    ctx.telemetry.missingDecisionStats.proposedSupportedCandidate += 1;
  } else {
    ctx.telemetry.missingDecisionStats.proposedPreviewCandidate += 1;
  }
}

/**
 * Records post-persist counters for one missing-key proposal.
 */
export function recordMissingBackfillProposalPersisted(ctx: ReconcilePassContext, resolved: MissingBackfillResolvedPreview): void {
  recordGroundedFamilyPromotionDecision(ctx.telemetry.missingDecisionStats, resolved.support, "proposal");
  if (resolved.compactness.compactedFrom) {
    ctx.telemetry.missingDecisionStats.proposedCompactedCandidate += 1;
  }
}

/**
 * Records shared counters when one missing-key auto-apply is identified.
 */
export function recordMissingBackfillAutoApplyIdentified(ctx: ReconcilePassContext): void {
  ctx.telemetry.counts.identifiedBackfills += 1;
}

/**
 * Records shared counters when one missing-key auto-apply is persisted.
 */
export function recordMissingBackfillAutoApplyApplied(ctx: ReconcilePassContext): void {
  ctx.telemetry.counts.appliedBackfills += 1;
}

/**
 * Records lane-specific counters when one missing-key auto-apply updates the projected working set.
 */
export function recordMissingBackfillAutoApplyProjected(ctx: ReconcilePassContext, resolved: MissingBackfillResolvedPreview): void {
  if (resolved.metadataBackfillClaimKey !== null) {
    ctx.telemetry.missingDecisionStats.autoAppliedMetadataRepair += 1;
  } else if (resolved.suggestion.path === "deterministic_repair") {
    ctx.telemetry.missingDecisionStats.autoAppliedDeterministicRepair += 1;
  } else if (resolved.support.autoApplyClass !== null && resolved.suggestion.confidence < HIGH_CONFIDENCE_BACKFILL_THRESHOLD) {
    ctx.telemetry.missingDecisionStats.autoAppliedSupportedPreview += 1;
  } else {
    ctx.telemetry.missingDecisionStats.autoAppliedPreviewModel += 1;
  }
  recordGroundedFamilyPromotionDecision(ctx.telemetry.missingDecisionStats, resolved.support, "auto_apply");
  if (resolved.compactness.compactedFrom) {
    ctx.telemetry.missingDecisionStats.autoAppliedCompactedCandidate += 1;
  }
}

/**
 * Records telemetry for one trusted-group reuse staged as a proposal.
 */
export function recordMissingBackfillTrustedGroupReuseProposed(ctx: ReconcilePassContext): void {
  ctx.telemetry.missingDecisionStats.proposedTrustedGroupReuse += 1;
}

/**
 * Records telemetry for one trusted-group reuse auto-applied.
 */
export function recordMissingBackfillTrustedGroupReuseAutoApplied(ctx: ReconcilePassContext): void {
  ctx.telemetry.missingDecisionStats.autoAppliedTrustedGroupReuse += 1;
}
