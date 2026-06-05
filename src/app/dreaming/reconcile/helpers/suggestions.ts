import { buildDurableLocalLexicalTokens, evaluateClaimKeySupport as evaluateSharedClaimKeySupport } from "../../../../core/claim-key-support.js";
import { createEmptySiblingSlotResonanceEvaluation, evaluateSiblingSlotResonance } from "../../../../core/claim-key-slot-resonance.js";
import { inspectClaimKey } from "../../../../core/claim-key.js";
import type { Durable } from "../../../../core/types.js";
import type { DurableSuggestionRecord, MissingBackfillSupportEvaluation, TrustedCleanupHintSeed } from "../types.js";

/** Evaluates support evidence for a missing-key backfill candidate. */
export function evaluateMissingBackfillSupport(
  durable: Durable,
  targetClaimKey: string,
  trustedHints: TrustedCleanupHintSeed,
): MissingBackfillSupportEvaluation {
  const support = evaluateSharedClaimKeySupport(durable, targetClaimKey, { entries: trustedHints.durables });
  const inspection = inspectClaimKey(targetClaimKey);
  const normalized = inspection.normalized;
  if (!normalized) {
    return {
      ...support,
      siblingSlotResonance: createEmptySiblingSlotResonanceEvaluation(0),
    };
  }

  return {
    ...support,
    siblingSlotResonance: evaluateSiblingSlotResonance({
      candidateClaimKey: normalized.claimKey,
      localLexicalTokens: buildDurableLocalLexicalTokens(durable),
      groundedSiblings: support.supportingDurableIds
        .map((durableId) => trustedHints.durables.find((trustedDurable) => trustedDurable.id === durableId))
        .filter((trustedDurable): trustedDurable is NonNullable<typeof trustedDurable> => Boolean(trustedDurable))
        .map((trustedDurable) => ({
          entryId: trustedDurable.id,
          claimKey: trustedDurable.claimKey,
        })),
    }),
  };
}

/** Classifies why a missing-key preview did not produce an accepted suggestion. */
export function resolveMissingBackfillNullOutcome(suggestionRecord: DurableSuggestionRecord): "no_claim" | "malformed_output" | "rejected_candidate" {
  if (suggestionRecord.previewOutcome?.outcome === "no_claim") {
    return "no_claim";
  }

  if (suggestionRecord.previewOutcome?.outcome === "rejected_candidate") {
    return "rejected_candidate";
  }

  if (suggestionRecord.warnings.some((warning) => /json|unexpected token|unterminated|position \d+/iu.test(warning))) {
    return "malformed_output";
  }

  return "rejected_candidate";
}
