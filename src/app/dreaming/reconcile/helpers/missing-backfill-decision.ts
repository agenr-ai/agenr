import { inspectClaimKey } from "../../../../core/claim-key.js";
import { evaluateClaimKeyCompactness } from "../../../../core/claim-key-support.js";
import type { ClaimExtractionResult } from "../../../../core/store/claim-extraction.js";
import type { Durable } from "../../../../core/types.js";
import type { ReconcilePassContext } from "../pass-context.js";
import { applyClaimKeyRepair } from "../pass-apply-handlers.js";
import type { DurableSuggestionRecord, ProposalAuditInput } from "../types.js";
import { resolveMetadataBackfillClaimKey } from "./claim-key-inspection.js";
import { resolveCrossTypeCollisionSiblingIds } from "./cross-type-collision-outcome.js";
import {
  buildMissingBackfillApplyRationale,
  buildMissingBackfillConflictRationale,
  buildMissingBackfillProposalRationale,
  resolveMissingBackfillAutoApplyBlocker,
  resolveMissingBackfillPromotionPolicy,
  resolveMissingBackfillProposalThreshold,
  type MissingBackfillResolvedPreview,
} from "./missing-backfill.js";
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
