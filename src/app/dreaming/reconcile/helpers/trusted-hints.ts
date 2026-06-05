import {
  buildTrustedClaimKeySupportSeed as buildSharedTrustedClaimKeySupportSeed,
  normalizeGroundingTags as normalizeSharedGroundingTags,
  tokenizeGroundingText as tokenizeSharedGroundingText,
} from "../../../../core/claim-key-support.js";
import type { ClaimExtractionHints } from "../../../../core/store/claim-extraction.js";
import type { Durable } from "../../../../core/types.js";
import { MAX_CLEANUP_CLAIM_KEY_HINTS, MAX_CLEANUP_ENTITY_HINTS } from "../constants.js";
import type { TrustedCleanupHintDurable, TrustedCleanupHintSeed } from "../types.js";
import { countSetOverlap, normalizeStringArray } from "./utils.js";

export function buildTrustedCleanupHintSeed(durables: Durable[]): TrustedCleanupHintSeed {
  const sharedSeed = buildSharedTrustedClaimKeySupportSeed(durables);
  const claimKeyExamples = normalizeStringArray(sharedSeed.entries.map((durable) => durable.claimKey)).slice(0, MAX_CLEANUP_CLAIM_KEY_HINTS);
  const entityHints = normalizeStringArray(claimKeyExamples.map((claimKey) => claimKey.split("/", 1)[0] ?? "").filter((entity) => entity.length > 0)).slice(
    0,
    MAX_CLEANUP_ENTITY_HINTS,
  );

  return {
    globalEntityHints: entityHints,
    globalClaimKeyExamples: claimKeyExamples,
    durables: sharedSeed.entries,
  };
}

export function buildCleanupHintsForDurable(baseHints: TrustedCleanupHintSeed, durable: Durable): ClaimExtractionHints {
  const rankedDurables = baseHints.durables
    .map((trustedDurable) => ({
      trustedDurable,
      score: scoreTrustedHintRelevance(durable, trustedDurable),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      const createdAtDelta = right.trustedDurable.createdAt.localeCompare(left.trustedDurable.createdAt);
      if (createdAtDelta !== 0) {
        return createdAtDelta;
      }

      return left.trustedDurable.claimKey.localeCompare(right.trustedDurable.claimKey);
    });
  const relevantClaimKeyExamples = rankedDurables.map((candidate) => candidate.trustedDurable.claimKey);
  const claimKeyExamples = normalizeStringArray([...relevantClaimKeyExamples, ...baseHints.globalClaimKeyExamples]).slice(0, MAX_CLEANUP_CLAIM_KEY_HINTS);
  const entityHints = normalizeStringArray([
    ...rankedDurables.map((candidate) => candidate.trustedDurable.entity),
    ...claimKeyExamples.map((claimKey) => claimKey.split("/", 1)[0] ?? ""),
    ...baseHints.globalEntityHints,
  ]).slice(0, MAX_CLEANUP_ENTITY_HINTS);

  return {
    entityHints,
    claimKeyExamples,
    project: durable.project,
    userId: durable.user_id,
    tags: normalizeSharedGroundingTags(durable.tags),
    sourceContext: durable.source_context,
  };
}

export function scoreTrustedHintRelevance(durable: Durable, trustedDurable: TrustedCleanupHintDurable): number {
  const durableTagSet = new Set(normalizeSharedGroundingTags(durable.tags));
  const durableSourceTokens = new Set(tokenizeSharedGroundingText(durable.source_context));
  const durableSubjectTokens = new Set(tokenizeSharedGroundingText(durable.subject));
  const tagOverlap = countSetOverlap(durableTagSet, trustedDurable.tags);
  const sourceOverlap = countSetOverlap(durableSourceTokens, trustedDurable.sourceContextTokens);
  const subjectOverlap = countSetOverlap(durableSubjectTokens, trustedDurable.subjectTokens);

  return tagOverlap * 6 + sourceOverlap * 5 + subjectOverlap * 2 + (durable.type === trustedDurable.type ? 1 : 0);
}
