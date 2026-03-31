import { parseRelativeDate } from "../../../core/recall/temporal.js";
import type { EpisodeIngestModelInfo } from "../ports.js";
import type { CreateEpisodeIngestPlanOptions, EpisodeIngestPlan, EpisodeIngestPreflightResult } from "../types.js";
import { estimateEpisodeSummaryInputTokens, parseCandidateEndedAt } from "./shared.js";

/**
 * Creates a pure Stage 2 plan from Stage 1 preflight output and model metadata.
 *
 * @param preflight - Stage 1 candidate set and aggregate counts.
 * @param model - Summary-generation model metadata used for estimation.
 * @param options - Optional recent filter and reference time.
 * @returns Immutable Stage 2 execution plan.
 */
export function createEpisodeIngestPlan(
  preflight: EpisodeIngestPreflightResult,
  model: EpisodeIngestModelInfo,
  options: CreateEpisodeIngestPlanOptions = {},
): EpisodeIngestPlan {
  const cutoff = resolveRecentCutoff(options.recent, options.now);
  let excludedByRecent = 0;
  let excludedUndated = 0;

  const candidates = preflight.candidates.flatMap((candidate) => {
    const estimatedInputTokens = estimateEpisodeSummaryInputTokens(candidate.renderedTranscript);
    const plannedCandidate = {
      ...candidate,
      estimatedInputTokens,
    };

    if (!cutoff) {
      return [plannedCandidate];
    }

    const endedAt = parseCandidateEndedAt(candidate.endedAt);
    if (!endedAt) {
      excludedByRecent += 1;
      excludedUndated += 1;
      return [];
    }

    if (endedAt.getTime() < cutoff.getTime()) {
      excludedByRecent += 1;
      return [];
    }

    return [plannedCandidate];
  });

  const inputTokens = candidates.reduce((total, candidate) => total + candidate.estimatedInputTokens, 0);
  const outputTokens = candidates.length * 500;
  const estimatedCostUsd = (inputTokens / 1_000_000) * model.pricing.input + (outputTokens / 1_000_000) * model.pricing.output;

  return {
    candidates,
    model,
    estimate: {
      candidateCount: candidates.length,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd,
    },
    ...(options.recent?.trim() ? { recent: options.recent.trim() } : {}),
    ...(cutoff ? { recentCutoff: cutoff.toISOString() } : {}),
    totals: {
      preflightCandidates: preflight.candidates.length,
      selectedCandidates: candidates.length,
      excludedByRecent,
      excludedUndated,
    },
  };
}

/**
 * Resolves an optional recent filter into a concrete cutoff date.
 *
 * @param recent - Recent filter string supplied by the caller.
 * @param now - Optional reference time for relative parsing.
 * @returns Parsed cutoff date, or undefined when no recent filter was supplied.
 */
function resolveRecentCutoff(recent: string | undefined, now: Date | undefined): Date | undefined {
  const trimmedRecent = recent?.trim();
  if (!trimmedRecent) {
    return undefined;
  }

  const cutoff = parseRelativeDate(trimmedRecent, now ?? new Date());
  if (!cutoff) {
    throw new Error(`Unsupported recent value "${trimmedRecent}". Use day shorthand like 30d or an ISO timestamp.`);
  }

  return cutoff;
}
