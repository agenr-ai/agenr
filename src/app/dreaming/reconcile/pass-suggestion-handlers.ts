import { previewClaimKeyExtraction } from "../../../core/store/claim-extraction.js";
import type { Durable } from "../../../core/types.js";
import { markAbortedIfSignalled } from "./helpers/effects.js";
import { claimExtractionUsage } from "./helpers/claim-extraction.js";
import { resolveExplicitMetadataRepair } from "./helpers/claim-key-inspection.js";
import { findClaimKeyOccupants, findTrustedGroupReuseCandidate } from "./helpers/durable.js";
import type { InspectedDurable } from "./helpers/partition.js";
import { createEmptySuggestionRecord } from "./helpers/stats.js";
import { buildCleanupHintsForDurable } from "./helpers/trusted-hints.js";
import type { ReconcilePassContext } from "./pass-context.js";
import type { ClaimExtractionPreviewLlm, DurableSuggestionRecord } from "./types.js";

/**
 * Returns whether missing-key stages should preload claim-extraction previews.
 *
 * @param ctx - Reconcile pass context.
 * @returns True when previews are enabled and an LLM factory is available.
 */
export function shouldPreloadSuggestions(ctx: ReconcilePassContext): boolean {
  return ctx.extraction.claimExtractionConfig.enabled && typeof ctx.deps.createClaimExtractionLlm === "function";
}

/**
 * Returns whether one missing durable needs an LLM preview before backfill decisions.
 *
 * @param ctx - Reconcile pass context.
 * @param item - Partitioned durable with its inspection outcome.
 * @returns True when trusted-group reuse does not already resolve the case.
 */
export function shouldPreviewMissingDurable(ctx: ReconcilePassContext, item: InspectedDurable): boolean {
  return findTrustedGroupReuseCandidate(ctx.workingSet.projectedDurables, ctx.workingSet.trustedReusableDurableIds, item.durable) === null;
}

/**
 * Returns whether one suspect durable still needs an LLM preview.
 *
 * @param ctx - Reconcile pass context.
 * @param item - Partitioned durable with its inspection outcome.
 * @returns True when metadata repair is unavailable or collides.
 */
export function shouldPreloadSuspectSuggestion(ctx: ReconcilePassContext, item: InspectedDurable): boolean {
  if (!ctx.extraction.claimExtractionConfig.eligibleTypes.includes(item.durable.type)) {
    return false;
  }

  if (item.inspection.kind !== "suspect") {
    return false;
  }

  const metadataRepair = resolveExplicitMetadataRepair(item.durable, item.inspection.inspection);
  return metadataRepair === null || findClaimKeyOccupants(ctx.workingSet.projectedDurables, metadataRepair, item.durable.id).length > 0;
}

/**
 * Preloads claim-key extraction previews for one stage with bounded concurrency.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param durables - Durables that should receive previews before stage processing.
 */
export async function preloadSuggestionsForStage(ctx: ReconcilePassContext, durables: Durable[]): Promise<void> {
  if (durables.length === 0 || !shouldPreloadSuggestions(ctx)) {
    return;
  }

  const workerCount = Math.min(ctx.extraction.previewConcurrency, durables.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      const llm = createTrackedClaimExtractionLlm(ctx);

      while (true) {
        if (ctx.telemetry.terminalStatus !== "completed") {
          return;
        }

        if (markAbortedIfSignalled(ctx)) {
          return;
        }

        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= durables.length) {
          return;
        }

        const durable = durables[currentIndex];
        if (!durable) {
          return;
        }

        await loadSuggestion(ctx, durable, llm);
        ctx.progressTracker.advancePreview();
      }
    }),
  );
}

/**
 * Loads or returns a cached claim-key extraction preview for one durable.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param durable - Durable under review.
 * @param llmOverride - Optional LLM instance reserved for parallel preload workers.
 * @returns Cached or freshly generated preview record.
 */
export async function loadSuggestion(
  ctx: ReconcilePassContext,
  durable: Durable,
  llmOverride?: ClaimExtractionPreviewLlm | null,
): Promise<DurableSuggestionRecord> {
  const cached = ctx.extraction.suggestionCache.get(durable.id);
  if (cached) {
    return cached;
  }

  if (!ctx.extraction.claimExtractionConfig.enabled || !ctx.extraction.claimExtractionConfig.eligibleTypes.includes(durable.type)) {
    const empty = createEmptySuggestionRecord();
    ctx.extraction.suggestionCache.set(durable.id, empty);
    return empty;
  }

  const llm = llmOverride ?? getFallbackClaimExtractionLlm(ctx);
  if (!llm) {
    const empty = createEmptySuggestionRecord();
    ctx.extraction.suggestionCache.set(durable.id, empty);
    return empty;
  }

  const warnings: string[] = [];
  let previewOutcome: DurableSuggestionRecord["previewOutcome"] = null;
  let suggestion: DurableSuggestionRecord["suggestion"];
  try {
    suggestion = await previewClaimKeyExtraction(
      {
        type: durable.type,
        subject: durable.subject,
        content: durable.content,
      },
      llm,
      ctx.extraction.claimExtractionConfig,
      {
        hints: buildCleanupHintsForDurable(ctx.workingSet.trustedHints, durable),
        onWarning: (warning) => warnings.push(warning),
        onPreviewOutcome: (outcome) => {
          previewOutcome = outcome;
        },
      },
    );
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    suggestion = null;
  }

  const record = { suggestion, warnings, previewOutcome };
  ctx.extraction.suggestionCache.set(durable.id, record);

  const usage = claimExtractionUsage(ctx.extraction.claimExtractionLlms);
  if (ctx.telemetry.terminalStatus === "completed" && ctx.options.costCapUsd > 0 && usage.estimatedCostUsd >= ctx.options.costCapUsd) {
    ctx.telemetry.terminalStatus = "cost_capped";
    ctx.telemetry.terminalError = `Cost cap exceeded while previewing claim-key repairs at ${usage.estimatedCostUsd.toFixed(4)} USD.`;
  }

  return record;
}

/**
 * Loads a claim-key preview and returns null when the pass has already stopped.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param durable - Durable under review.
 * @param llmOverride - Optional LLM instance reserved for parallel preload workers.
 * @returns Cached or freshly generated preview record, or null when the pass stopped.
 */
export async function loadSuggestionIfContinuing(
  ctx: ReconcilePassContext,
  durable: Durable,
  llmOverride?: ClaimExtractionPreviewLlm | null,
): Promise<DurableSuggestionRecord | null> {
  const record = await loadSuggestion(ctx, durable, llmOverride);
  if (ctx.telemetry.terminalStatus !== "completed") {
    return null;
  }

  return record;
}

function getFallbackClaimExtractionLlm(ctx: ReconcilePassContext): ClaimExtractionPreviewLlm | null {
  if (ctx.extraction.fallbackClaimExtractionLlm !== undefined) {
    return ctx.extraction.fallbackClaimExtractionLlm;
  }

  ctx.extraction.fallbackClaimExtractionLlm = createTrackedClaimExtractionLlm(ctx);
  return ctx.extraction.fallbackClaimExtractionLlm;
}

function createTrackedClaimExtractionLlm(ctx: ReconcilePassContext): ClaimExtractionPreviewLlm | null {
  const llm = ctx.deps.createClaimExtractionLlm ? ctx.deps.createClaimExtractionLlm() : null;
  if (llm && !ctx.extraction.claimExtractionLlms.includes(llm)) {
    ctx.extraction.claimExtractionLlms.push(llm);
  }

  return llm;
}
