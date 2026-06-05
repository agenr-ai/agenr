import type { ClaimKeyCompactnessEvaluation } from "../../../../core/claim-key-support.js";
import { HIGH_CONFIDENCE_BACKFILL_THRESHOLD, type MissingBackfillPromotionClass, type MissingBackfillPromotionLane } from "../constants.js";
import type { MissingBackfillSupportEvaluation } from "../types.js";

/** Shared rationale input for missing-key backfill proposal and apply text. */
interface MissingBackfillRationaleBase {
  originalClaimKey: string;
  targetClaimKey: string;
  confidence: number;
  metadataBackfillClaimKey: string | null;
  compactness: ClaimKeyCompactnessEvaluation;
}

/** Rationale input for a missing-key backfill proposal below auto-apply. */
interface MissingBackfillProposalRationaleInput extends MissingBackfillRationaleBase {
  autoApplyThreshold: number;
  promotionLane: MissingBackfillPromotionLane;
  trusted: boolean;
  support: MissingBackfillSupportEvaluation;
}

/** Rationale input for an auto-applied missing-key backfill. */
interface MissingBackfillApplyRationaleInput extends MissingBackfillRationaleBase {
  promotionLane: MissingBackfillPromotionLane;
  source: string;
  support: MissingBackfillSupportEvaluation;
}

/** Formats claim-extraction confidence for rationale text. */
function formatConfidence(confidence: number): string {
  return confidence.toFixed(2);
}

/** Returns whether metadata rewrote the preview claim key. */
function hasMetadataGrounding(input: MissingBackfillRationaleBase): boolean {
  return input.metadataBackfillClaimKey !== null && input.originalClaimKey !== input.targetClaimKey;
}

/** Returns whether compact canonicalization rewrote the preview claim key. */
function hasCompactionRewrite(input: MissingBackfillRationaleBase): boolean {
  return Boolean(input.compactness.compactedFrom && input.compactness.compactedFrom !== input.targetClaimKey);
}

/** Formats trailing compaction rationale for proposal text. */
function formatCompactionSuffix(input: MissingBackfillRationaleBase): string {
  if (!hasCompactionRewrite(input)) {
    return "";
  }

  return ` The candidate was compacted from "${input.compactness.compactedFrom}" to "${input.targetClaimKey}" because ${input.compactness.compactionReason}.`;
}

/** Formats inline compaction rationale for threshold explanation text. */
function formatInlineCompactionClause(input: MissingBackfillRationaleBase): string {
  if (!hasCompactionRewrite(input)) {
    return "";
  }

  return ` after safely compacting "${input.compactness.compactedFrom}" to "${input.targetClaimKey}" because ${input.compactness.compactionReason}`;
}

/** Formats trailing compaction rationale for auto-apply text. */
function formatApplyCompactionSuffix(input: MissingBackfillRationaleBase): string {
  if (!hasCompactionRewrite(input)) {
    return "";
  }

  return ` The candidate was compacted from "${input.compactness.compactedFrom}" because ${input.compactness.compactionReason}.`;
}

/** Formats the leading sentence for missing-key backfill rationale text. */
function formatPreviewLead(input: MissingBackfillRationaleBase): string {
  if (hasMetadataGrounding(input)) {
    return (
      `Backfill preview suggested "${input.originalClaimKey}" at confidence ${formatConfidence(input.confidence)}, ` +
      `and explicit metadata safely grounds that candidate to "${input.targetClaimKey}".`
    );
  }

  if (hasCompactionRewrite(input)) {
    return (
      `Backfill preview suggested "${input.compactness.compactedFrom}" at confidence ${formatConfidence(input.confidence)}, ` +
      `and compact canonicalization safely shortened it to "${input.targetClaimKey}" because ${input.compactness.compactionReason}.`
    );
  }

  return `Backfill preview suggested "${input.targetClaimKey}" at confidence ${formatConfidence(input.confidence)}.`;
}

/**
 * Builds the rationale for one missing-key cross-type collision proposal.
 */
export function buildMissingBackfillConflictRationale(input: MissingBackfillRationaleBase): string {
  return `${formatPreviewLead(input)}${formatCompactionSuffix(input)}`;
}

/**
 * Builds the rationale for one missing-key proposal below the auto-apply threshold.
 */
export function buildMissingBackfillProposalRationale(input: MissingBackfillProposalRationaleInput): string {
  if (!input.trusted) {
    return `Backfill preview suggested "${input.targetClaimKey}" at confidence ${formatConfidence(input.confidence)}, but the proposed key is still structurally suspect.`;
  }

  if (!input.compactness.compactEnoughForAutoApply) {
    return (
      `Backfill preview suggested "${input.targetClaimKey}" at confidence ${formatConfidence(input.confidence)}${formatInlineCompactionClause(input)}, ` +
      "but the resulting slot name is still too verbose or awkward to auto-apply safely."
    );
  }

  if (hasMetadataGrounding(input)) {
    return (
      `Backfill preview suggested "${input.originalClaimKey}" at confidence ${formatConfidence(input.confidence)}, ` +
      `and explicit metadata resolves that candidate to likely canonical key "${input.targetClaimKey}", ` +
      `but that supported repair stays below the auto-apply threshold of ${formatConfidence(input.autoApplyThreshold)}.`
    );
  }

  if (input.support.autoApplyClass !== null) {
    const promotionLead =
      input.promotionLane === "compacted_supported"
        ? "Supported evidence remained strong after compact canonicalization"
        : `Supported evidence from ${describeMissingBackfillPromotionClass(input.support.autoApplyClass)} exists`;
    return (
      `Backfill preview suggested "${input.targetClaimKey}" at confidence ${formatConfidence(input.confidence)}. ` +
      `${promotionLead} via ${input.support.rationaleFragments.join(", ")}, ` +
      `but the candidate stays below the auto-apply threshold of ${formatConfidence(input.autoApplyThreshold)}.`
    );
  }

  if (input.support.rationaleFragments.length > 0) {
    return (
      `Backfill preview suggested "${input.targetClaimKey}" at confidence ${formatConfidence(input.confidence)}. ` +
      `Structural support exists from ${input.support.rationaleFragments.join(", ")}, ` +
      `but the candidate stays below the auto-apply threshold of ${formatConfidence(input.autoApplyThreshold)}.`
    );
  }

  return (
    `Backfill preview suggested "${input.targetClaimKey}" at confidence ${formatConfidence(input.confidence)}, ` +
    `below the auto-apply threshold of ${formatConfidence(input.autoApplyThreshold)}.`
  );
}

/**
 * Builds the rationale for one auto-applied missing-key backfill.
 */
export function buildMissingBackfillApplyRationale(input: MissingBackfillApplyRationaleInput): string {
  if (hasMetadataGrounding(input)) {
    return (
      `Metadata-grounded claim-key backfill rewrote preview candidate "${input.originalClaimKey}" to "${input.targetClaimKey}" ` +
      `at confidence ${formatConfidence(input.confidence)} from ${input.source}.` +
      (hasCompactionRewrite(input)
        ? ` Compact canonicalization also shortened "${input.compactness.compactedFrom}" because ${input.compactness.compactionReason}.`
        : "")
    );
  }

  if (input.support.autoApplyClass !== null && input.confidence < HIGH_CONFIDENCE_BACKFILL_THRESHOLD) {
    const promotionPrefix = input.promotionLane === "compacted_supported" ? "Post-compaction supported claim-key backfill" : "Supported claim-key backfill";
    return (
      `${promotionPrefix} assigned "${input.targetClaimKey}" from ${input.source} at confidence ${formatConfidence(input.confidence)} ` +
      `through ${describeMissingBackfillPromotionClass(input.support.autoApplyClass)} using ${input.support.rationaleFragments.join(", ")}.` +
      formatApplyCompactionSuffix(input)
    );
  }

  return (
    `High-confidence claim-key backfill assigned "${input.targetClaimKey}" from ${input.source} at confidence ${formatConfidence(input.confidence)}.` +
    formatApplyCompactionSuffix(input)
  );
}

/** Formats a missing-key promotion class for human-readable rationale text. */
export function describeMissingBackfillPromotionClass(promotionClass: MissingBackfillPromotionClass): string {
  switch (promotionClass) {
    case "trusted_exact_reuse_grounded":
      return "trusted exact-key reuse with local grounding";
    case "trusted_family_template_grounded":
      return "trusted family reuse plus grounded template support";
    case "trusted_family_stable_slot":
      return "trusted family reuse plus a stable compact slot";
    case "trusted_family_grounded_alignment":
      return "trusted family reuse plus grounded dual lexical alignment";
  }
}
