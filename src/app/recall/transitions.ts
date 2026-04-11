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
  if (params.families.length === 0 || params.detectedIntent !== "historical_state") {
    return [];
  }

  return params.families.flatMap((family) => {
    const current = family.entries.find((entry) => entry.memoryState === "current");
    const prior = family.entries.find((entry) => entry.memoryState === "superseded" || entry.memoryState === "historical");
    if (!current && !prior) {
      return [];
    }

    const episodeContext = selectEpisodeContext(family, params.episodes);
    return [
      {
        familyKey: family.familyKey,
        claimKey: family.claimKey,
        slotPolicy: family.slotPolicy,
        subject: family.subject,
        ...(current ? { currentEntryId: current.entryId } : {}),
        ...(prior ? { priorEntryId: prior.entryId } : {}),
        summary: summarizeTransition(family.subject, current?.entryId, prior?.entryId),
        ...(episodeContext ? { episodeContext } : {}),
      },
    ];
  });
}

/**
 * Formats a concise transition summary for one claim family.
 *
 * @param subject - Family subject shown to the caller.
 * @param currentEntryId - Current entry when available.
 * @param priorEntryId - Prior entry when available.
 * @returns Human-readable transition explanation.
 */
function summarizeTransition(subject: string, currentEntryId: string | undefined, priorEntryId: string | undefined): string {
  if (currentEntryId && priorEntryId) {
    return `${subject} changed from ${priorEntryId} to ${currentEntryId}.`;
  }

  if (priorEntryId) {
    return `${subject} previously matched ${priorEntryId}; no current sibling was recalled.`;
  }

  return `${subject} is currently represented by ${currentEntryId}; no prior sibling was recalled.`;
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
