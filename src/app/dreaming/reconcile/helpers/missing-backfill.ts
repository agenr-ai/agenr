import { inspectClaimKey } from "../../../../core/claim-key.js";
import type { ClaimKeyCompactnessEvaluation } from "../../../../core/claim-key-support.js";
import { evaluateClaimKeyCompactness } from "../../../../core/claim-key-support.js";
import type { ClaimExtractionResult } from "../../../../core/store/claim-extraction.js";
import type { Durable } from "../../../../core/types.js";
import type { ReconcilePassContext } from "../pass-context.js";
import { applyClaimKeyRepair } from "../pass-apply-handlers.js";
import {
  COMPACTED_SUPPORTED_AUTO_APPLY_BACKFILL_THRESHOLD,
  HIGH_CONFIDENCE_BACKFILL_THRESHOLD,
  PROPOSAL_CONFIDENCE_THRESHOLD,
  STRUCTURED_AUTO_APPLY_BACKFILL_THRESHOLD,
  SUPPORTED_PROPOSAL_CONFIDENCE_THRESHOLD,
} from "../constants.js";
import type {
  DurableSuggestionRecord,
  MissingBackfillDecisionStats,
  MissingBackfillPromotionPolicy,
  MissingBackfillSkipDiagnostic,
  MissingBackfillSupportEvaluation,
  ProposalAuditInput,
} from "../types.js";
import { resolveMetadataBackfillClaimKey } from "./claim-key-inspection.js";
import { resolveCrossTypeCollisionSiblingIds } from "./cross-type-collision-outcome.js";
import {
  recordMissingBackfillAutoApplyApplied,
  recordMissingBackfillAutoApplyIdentified,
  recordMissingBackfillAutoApplyProjected,
  recordMissingBackfillLowConfidenceSkip,
  recordMissingBackfillNoClaimOutcome,
  recordMissingBackfillProposalLaneOutcome,
  recordMissingBackfillProposalPersisted,
} from "./missing-backfill-stats.js";
import { buildMissingBackfillPersistInput } from "./proposal.js";
import { appendCrossTypeCollisionRationaleSuffix, persistReconcileProposal } from "./reconcile-proposal.js";
import { buildMissingBackfillShadowAudit, recordSiblingSlotResonanceShadowCandidate } from "./shadow-resonance.js";
import { evaluateMissingBackfillSupport } from "./suggestions.js";

import {
  buildMissingBackfillApplyRationale,
  buildMissingBackfillConflictRationale,
  buildMissingBackfillProposalRationale,
  describeMissingBackfillPromotionClass,
} from "./missing-backfill-rationale.js";

export {
  buildMissingBackfillApplyRationale,
  buildMissingBackfillConflictRationale,
  buildMissingBackfillProposalRationale,
  describeMissingBackfillPromotionClass,
};

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

/** Builds a compact diagnostic for one skipped missing-key preview. */
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

/** Formats a skipped missing-key diagnostic for pass recommendations. */
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

/** Resolves the promotion lane and auto-apply threshold for one backfill candidate. */
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

/** Resolves the proposal threshold for one missing-key backfill candidate. */
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

/** Returns the reason a missing-key backfill cannot be auto-applied. */
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

/** Records counters for grounded-family and relaxed stable-slot promotion decisions. */
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

/** Deterministic next action selected from one missing-key preview. */
type MissingDurablePreviewDecision =
  | { kind: "skip_no_claim"; suggestionRecord: DurableSuggestionRecord }
  | { kind: "skip_low_confidence"; suggestionRecord: DurableSuggestionRecord; targetClaimKey: string }
  | ({ kind: "propose_cross_type_collision"; activeSiblingIds: string[] } & MissingBackfillResolvedPreview)
  | ({ kind: "propose_below_auto_apply"; autoApplyThreshold: number; proposalThreshold: number; targetIsTrusted: boolean } & MissingBackfillResolvedPreview)
  | ({ kind: "auto_apply" } & MissingBackfillResolvedPreview);

/**
 * Builds resolved preview metadata for one missing-key backfill candidate.
 *
 * @param durable - Durable under review.
 * @param suggestion - Claim extraction preview result.
 * @param ctx - Mutable reconcile pass context.
 * @returns Resolved preview metadata for decision evaluation.
 */
export function buildMissingBackfillResolvedPreview(
  durable: Durable,
  suggestion: ClaimExtractionResult,
  ctx: ReconcilePassContext,
): MissingBackfillResolvedPreview {
  const metadataBackfillClaimKey = resolveMetadataBackfillClaimKey(durable, suggestion.claimKey!);
  const originalClaimKey = suggestion.compactedFrom ?? suggestion.claimKey!;
  const compactness = evaluateClaimKeyCompactness(metadataBackfillClaimKey ?? suggestion.claimKey!, {
    priorCompactedFrom: suggestion.compactedFrom ?? null,
    priorCompactionReason: suggestion.compactionReason ?? null,
  });
  const targetClaimKey = compactness.claimKey;
  const targetSource = metadataBackfillClaimKey ? "metadata_backfill_rewrite" : suggestion.path;
  const support = evaluateMissingBackfillSupport(durable, targetClaimKey, ctx.workingSet.trustedHints);
  const promotionPolicy = resolveMissingBackfillPromotionPolicy({
    metadataRepaired: metadataBackfillClaimKey !== null,
    previewPath: suggestion.path,
    support,
    compactness,
  });

  return {
    targetClaimKey,
    targetSource,
    originalClaimKey,
    compactness,
    promotionPolicy,
    support,
    suggestion,
    metadataBackfillClaimKey,
  };
}

/**
 * Evaluates one missing-key preview outcome into a deterministic decision.
 *
 * @param durable - Durable under review.
 * @param suggestionRecord - Cached claim-extraction preview record.
 * @param ctx - Mutable reconcile pass context.
 * @returns Decision describing the next reconcile action.
 */
export function evaluateMissingDurablePreview(
  durable: Durable,
  suggestionRecord: DurableSuggestionRecord,
  ctx: ReconcilePassContext,
): MissingDurablePreviewDecision {
  const suggestion = suggestionRecord.suggestion;
  if (!suggestion?.claimKey) {
    return { kind: "skip_no_claim", suggestionRecord };
  }

  const resolved = buildMissingBackfillResolvedPreview(durable, suggestion, ctx);
  const targetInspection = inspectClaimKey(resolved.targetClaimKey);
  const targetIsTrusted = targetInspection.suspectReasons.length === 0;
  const autoApplyThreshold = resolved.promotionPolicy.autoApplyThreshold;
  const proposalThreshold = resolveMissingBackfillProposalThreshold({
    metadataRepaired: resolved.metadataBackfillClaimKey !== null,
    previewPath: suggestion.path,
    support: resolved.support,
  });
  const activeSiblingIds = resolveCrossTypeCollisionSiblingIds(ctx.workingSet.projectedDurables, resolved.targetClaimKey, durable);
  if (activeSiblingIds.length > 0) {
    return {
      kind: "propose_cross_type_collision",
      activeSiblingIds,
      ...resolved,
    };
  }

  if (!targetIsTrusted || !resolved.compactness.compactEnoughForAutoApply || suggestion.confidence < autoApplyThreshold) {
    if (suggestion.confidence >= proposalThreshold) {
      return {
        kind: "propose_below_auto_apply",
        autoApplyThreshold,
        proposalThreshold,
        targetIsTrusted,
        ...resolved,
      };
    }

    return { kind: "skip_low_confidence", suggestionRecord, targetClaimKey: resolved.targetClaimKey };
  }

  return {
    kind: "auto_apply",
    ...resolved,
  };
}

/**
 * Executes one missing-key preview decision.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param durable - Durable under review.
 * @param decision - Evaluated preview decision.
 */
export async function executeMissingDurablePreviewDecision(
  ctx: ReconcilePassContext,
  durable: Durable,
  decision: MissingDurablePreviewDecision,
): Promise<void> {
  switch (decision.kind) {
    case "skip_no_claim": {
      recordMissingBackfillNoClaimOutcome(ctx, durable, decision.suggestionRecord);
      return;
    }
    case "propose_cross_type_collision": {
      await persistMissingBackfillProposal(ctx, durable, decision, {
        durableIds: [...new Set([durable.id, ...decision.activeSiblingIds])],
        rationale: appendCrossTypeCollisionRationaleSuffix(
          buildMissingBackfillConflictRationale({
            originalClaimKey: decision.originalClaimKey,
            targetClaimKey: decision.targetClaimKey,
            confidence: decision.suggestion.confidence,
            metadataBackfillClaimKey: decision.metadataBackfillClaimKey,
            compactness: decision.compactness,
          }),
          decision.targetClaimKey,
        ),
        audit: {},
      });
      return;
    }
    case "propose_below_auto_apply": {
      const autoApplyBlocker = resolveMissingBackfillAutoApplyBlocker({
        trusted: decision.targetIsTrusted,
        compactness: decision.compactness,
        confidence: decision.suggestion.confidence,
        autoApplyThreshold: decision.autoApplyThreshold,
      });
      const shadowAudit = buildMissingBackfillShadowAudit({
        support: decision.support,
        confidence: decision.suggestion.confidence,
        autoApplyBlocker,
      });
      await persistMissingBackfillProposal(ctx, durable, decision, {
        durableIds: [durable.id],
        rationale: buildMissingBackfillProposalRationale({
          originalClaimKey: decision.originalClaimKey,
          targetClaimKey: decision.targetClaimKey,
          confidence: decision.suggestion.confidence,
          autoApplyThreshold: decision.autoApplyThreshold,
          promotionLane: decision.promotionPolicy.lane,
          trusted: decision.targetIsTrusted,
          metadataBackfillClaimKey: decision.metadataBackfillClaimKey,
          compactness: decision.compactness,
          support: decision.support,
        }),
        audit: {
          autoApplyBlocker,
          shadow: shadowAudit ?? undefined,
        },
      });
      if (shadowAudit && ctx.options.includeShadowTelemetry === true) {
        recordSiblingSlotResonanceShadowCandidate(ctx.telemetry.siblingSlotResonanceShadowStats, decision.targetClaimKey, decision.support, shadowAudit);
      }
      recordMissingBackfillProposalLaneOutcome(ctx, decision);
      return;
    }
    case "skip_low_confidence": {
      recordMissingBackfillLowConfidenceSkip(ctx, durable, decision.suggestionRecord, decision.targetClaimKey);
      return;
    }
    case "auto_apply": {
      await applyClaimKeyRepair(
        ctx,
        durable.id,
        decision.targetClaimKey,
        {
          issueKind: "missing_claim_key",
          oldClaimKey: null,
          source: decision.targetSource,
          confidence: decision.suggestion.confidence,
          compactness: decision.compactness,
          promotion: decision.promotionPolicy,
          support: decision.support,
          rawClaimKey: decision.originalClaimKey,
          rationale: buildMissingBackfillApplyRationale({
            originalClaimKey: decision.originalClaimKey,
            targetClaimKey: decision.targetClaimKey,
            confidence: decision.suggestion.confidence,
            promotionLane: decision.promotionPolicy.lane,
            source: decision.targetSource,
            metadataBackfillClaimKey: decision.metadataBackfillClaimKey,
            compactness: decision.compactness,
            support: decision.support,
          }),
        },
        {
          onIdentified: () => {
            recordMissingBackfillAutoApplyIdentified(ctx);
          },
          onApplied: () => {
            recordMissingBackfillAutoApplyApplied(ctx);
          },
          onProjected: () => {
            recordMissingBackfillAutoApplyProjected(ctx, decision);
          },
        },
      );
    }
  }
}

/** Persists a missing-key backfill proposal and records proposal counters. */
async function persistMissingBackfillProposal(
  ctx: ReconcilePassContext,
  durable: Durable,
  resolved: MissingBackfillResolvedPreview,
  input: {
    rationale: string;
    durableIds: string[];
    audit: ProposalAuditInput;
  },
): Promise<void> {
  await persistReconcileProposal(ctx, {
    ...buildMissingBackfillPersistInput(durable, resolved, input),
    onPersisted: (passCtx) => {
      recordMissingBackfillProposalPersisted(passCtx, resolved);
    },
  });
}
