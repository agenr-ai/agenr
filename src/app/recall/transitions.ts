import { tokenize } from "../../core/recall/lexical.js";
import type { EpisodeResult } from "../../core/episode/types.js";

import type { ClaimCentricRecallFamily } from "./claim-centric.js";
import type { ClaimTransitionExplanation, UnifiedRecallDetectedIntent } from "./types.js";

/**
 * Builds compact read-side claim-transition explanations from recalled families.
 *
 * @param params - Recalled claim families, matched episodes, and detected intent.
 * @returns Transition summaries suitable for tool and eval surfaces.
 */
export function buildClaimTransitionExplanations(params: {
  families: ClaimCentricRecallFamily[];
  episodes: EpisodeResult[];
  detectedIntent: UnifiedRecallDetectedIntent;
}): ClaimTransitionExplanation[] {
  if (params.families.length === 0 || params.detectedIntent === "temporal_narrative") {
    return [];
  }

  return params.families.flatMap((family) => {
    const current = family.durables.find((entry) => entry.memoryState === "current");
    const prior = family.durables.find((entry) => entry.memoryState === "superseded" || entry.memoryState === "historical");
    if (!shouldExplainFamilyTransition(current, prior, params.detectedIntent)) {
      return [];
    }

    const episodeContext = selectEpisodeContext(family, params.episodes);
    return [
      {
        familyKey: family.familyKey,
        claimKey: family.claimKey,
        slotPolicy: family.slotPolicy,
        subject: family.subject,
        ...(current ? { currentDurableId: current.durableId } : {}),
        ...(prior ? { priorDurableId: prior.durableId } : {}),
        summary: summarizeTransition(family.subject, current?.durableId, prior?.durableId),
        ...(episodeContext ? { episodeContext } : {}),
      },
    ];
  });
}

/**
 * Decides whether one recalled family should emit a transition explanation.
 *
 * Historical-state queries can explain one-sided current or prior evidence.
 * Other intents only emit a transition when both prior and current rows are
 * present, which keeps factual recall from producing noisy pseudo-history.
 *
 * @param current - Current family row when one was recalled.
 * @param prior - Prior family row when one was recalled.
 * @param detectedIntent - Unified routing intent bucket.
 * @returns True when the family should produce a transition explanation.
 */
function shouldExplainFamilyTransition(
  current: ClaimCentricRecallFamily["durables"][number] | undefined,
  prior: ClaimCentricRecallFamily["durables"][number] | undefined,
  detectedIntent: UnifiedRecallDetectedIntent,
): boolean {
  if (detectedIntent === "historical_state") {
    return Boolean(current || prior);
  }

  return Boolean(current && prior);
}

/**
 * Formats a concise transition summary for one claim family.
 *
 * @param subject - Family subject shown to the caller.
 * @param currentDurableId - Current entry when available.
 * @param priorDurableId - Prior entry when available.
 * @returns Human-readable transition explanation.
 */
function summarizeTransition(subject: string, currentDurableId: string | undefined, priorDurableId: string | undefined): string {
  if (currentDurableId && priorDurableId) {
    return `${subject} changed from ${priorDurableId} to ${currentDurableId}.`;
  }

  if (priorDurableId) {
    return `${subject} previously matched ${priorDurableId}; no current sibling was recalled.`;
  }

  return `${subject} is currently represented by ${currentDurableId}; no prior sibling was recalled.`;
}

/**
 * Picks one nearby episode that appears relevant to a claim-family transition.
 *
 * @param family - Claim family under explanation.
 * @param episodes - Episodes returned by unified recall.
 * @returns Compact episode context, or undefined when none look relevant.
 */
function selectEpisodeContext(family: ClaimCentricRecallFamily, episodes: EpisodeResult[]): ClaimTransitionExplanation["episodeContext"] | undefined {
  if (episodes.length === 0) {
    return undefined;
  }

  const familyTokens = new Set(
    tokenize(`${family.subject} ${family.claimKey ?? ""}`)
      .filter((token) => token.length > 1)
      .map((token) => token.toLowerCase()),
  );
  if (familyTokens.size === 0) {
    return undefined;
  }

  let bestMatch: EpisodeResult | undefined;
  let bestScore = 0;
  let bestOverlap = 0;
  for (const episode of episodes) {
    const episodeTokens = new Set(
      tokenize(`${episode.episode.summary} ${episode.episode.tags.join(" ")}`)
        .filter((token) => token.length > 1)
        .map((token) => token.toLowerCase()),
    );
    let overlap = 0;
    for (const token of familyTokens) {
      if (episodeTokens.has(token)) {
        overlap += 1;
      }
    }

    const score = overlap + episode.score;
    if (score > bestScore) {
      bestScore = score;
      bestOverlap = overlap;
      bestMatch = episode;
    }
  }

  if (!bestMatch || bestOverlap <= 0) {
    return undefined;
  }

  return {
    episodeId: bestMatch.episode.id,
    startedAt: bestMatch.episode.startedAt,
    ...(bestMatch.episode.endedAt ? { endedAt: bestMatch.episode.endedAt } : {}),
    summary: bestMatch.episode.summary,
  };
}
