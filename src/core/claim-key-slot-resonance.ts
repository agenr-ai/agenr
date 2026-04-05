/* eslint-disable jsdoc/require-jsdoc */

import { compactClaimKey, normalizeClaimKey } from "./claim-key.js";

const FAMILY_GENERIC_TOKEN_MIN_COUNT = 3;
const FAMILY_GENERIC_TOKEN_RATIO = 0.5;
const MIN_RESONANT_SHARED_TOKENS = 2;
const MIN_RESONANT_SHAPE_COUNT = 2;

/**
 * One grounded sibling candidate inspected for slot-resonance support.
 */
export interface SiblingSlotResonanceSibling {
  entryId: string;
  claimKey: string;
}

/**
 * Deterministic slot-resonance evidence derived from grounded family siblings.
 */
export interface SiblingSlotResonanceEvaluation {
  applicable: boolean;
  fired: boolean;
  groundedSiblingCount: number;
  resonantSiblingCount: number;
  dominantShape: string | null;
  dominantShapeCount: number;
  dominantShapeGroundedShare: number;
  localShapeTokenCoverage: number;
  discriminativeCandidateTokens: string[];
  familyGenericTokens: string[];
  dominantSiblingEntryIds: string[];
  dominantSiblingClaimKeys: string[];
}

/**
 * Evaluates whether grounded family siblings converge on the same compact slot shape.
 *
 * The signal is deliberately narrow. It only fires when multiple grounded siblings
 * echo the same candidate attribute shape after compact canonicalization, and when
 * the target entry's own lexical evidence covers that repeated shape.
 *
 * @param input - Candidate claim key, local lexical tokens, and grounded sibling claim keys.
 * @returns Deterministic resonance evidence for shadow-mode inspection.
 */
export function evaluateSiblingSlotResonance(input: {
  candidateClaimKey: string;
  localLexicalTokens: string[];
  groundedSiblings: SiblingSlotResonanceSibling[];
}): SiblingSlotResonanceEvaluation {
  const candidateTokens = extractAttributeTokens(input.candidateClaimKey);
  const groundedSiblingAttributes = input.groundedSiblings
    .map((sibling) => ({
      entryId: sibling.entryId,
      claimKey: sibling.claimKey,
      tokens: extractAttributeTokens(sibling.claimKey),
    }))
    .filter((sibling) => sibling.tokens.length > 0);

  if (candidateTokens.length < MIN_RESONANT_SHARED_TOKENS || groundedSiblingAttributes.length === 0) {
    return createEmptySiblingSlotResonanceEvaluation(groundedSiblingAttributes.length);
  }

  const familyTokenFrequency = countFamilyTokenFrequency(groundedSiblingAttributes.map((sibling) => sibling.tokens));
  const familyGenericCutoff = Math.max(FAMILY_GENERIC_TOKEN_MIN_COUNT, Math.ceil(groundedSiblingAttributes.length * FAMILY_GENERIC_TOKEN_RATIO));
  const familyGenericTokens = candidateTokens.filter((token) => (familyTokenFrequency.get(token) ?? 0) >= familyGenericCutoff);
  const discriminativeCandidateTokens = candidateTokens.filter((token) => !familyGenericTokens.includes(token));
  const localLexicalTokenSet = new Set(input.localLexicalTokens);
  const resonantShapes = new Map<string, { siblingEntryIds: string[]; siblingClaimKeys: string[] }>();
  let resonantSiblingCount = 0;

  for (const sibling of groundedSiblingAttributes) {
    const resonanceShapeTokens = resolveResonanceShapeTokens(candidateTokens, discriminativeCandidateTokens, sibling.tokens);
    if (resonanceShapeTokens.length < MIN_RESONANT_SHARED_TOKENS) {
      continue;
    }

    resonantSiblingCount += 1;
    const resonanceShape = resonanceShapeTokens.join("_");
    const existing = resonantShapes.get(resonanceShape);
    if (existing) {
      existing.siblingEntryIds.push(sibling.entryId);
      existing.siblingClaimKeys.push(sibling.claimKey);
      continue;
    }

    resonantShapes.set(resonanceShape, {
      siblingEntryIds: [sibling.entryId],
      siblingClaimKeys: [sibling.claimKey],
    });
  }

  const dominantShapeEntry = [...resonantShapes.entries()].sort((left, right) => {
    const countDelta = right[1].siblingEntryIds.length - left[1].siblingEntryIds.length;
    if (countDelta !== 0) {
      return countDelta;
    }

    const tokenCountDelta = right[0].split("_").length - left[0].split("_").length;
    if (tokenCountDelta !== 0) {
      return tokenCountDelta;
    }

    return left[0].localeCompare(right[0]);
  })[0];
  const dominantShape = dominantShapeEntry?.[0] ?? null;
  const dominantShapeCount = dominantShapeEntry?.[1].siblingEntryIds.length ?? 0;
  const dominantShapeTokens = dominantShape ? dominantShape.split("_").filter((token) => token.length > 0) : [];
  const localShapeTokenCoverage =
    dominantShapeTokens.length > 0 ? dominantShapeTokens.filter((token) => localLexicalTokenSet.has(token)).length / dominantShapeTokens.length : 0;
  const fired = dominantShapeTokens.length >= MIN_RESONANT_SHARED_TOKENS && dominantShapeCount >= MIN_RESONANT_SHAPE_COUNT && localShapeTokenCoverage === 1;

  return {
    applicable: true,
    fired,
    groundedSiblingCount: groundedSiblingAttributes.length,
    resonantSiblingCount,
    dominantShape,
    dominantShapeCount,
    dominantShapeGroundedShare: groundedSiblingAttributes.length > 0 ? dominantShapeCount / groundedSiblingAttributes.length : 0,
    localShapeTokenCoverage,
    discriminativeCandidateTokens,
    familyGenericTokens,
    dominantSiblingEntryIds: dominantShapeEntry ? [...dominantShapeEntry[1].siblingEntryIds] : [],
    dominantSiblingClaimKeys: dominantShapeEntry ? [...dominantShapeEntry[1].siblingClaimKeys] : [],
  };
}

/**
 * Returns an empty sibling-slot-resonance evaluation.
 *
 * @param groundedSiblingCount - Number of grounded siblings available for inspection.
 * @returns Empty deterministic resonance evidence.
 */
export function createEmptySiblingSlotResonanceEvaluation(groundedSiblingCount: number): SiblingSlotResonanceEvaluation {
  return {
    applicable: false,
    fired: false,
    groundedSiblingCount,
    resonantSiblingCount: 0,
    dominantShape: null,
    dominantShapeCount: 0,
    dominantShapeGroundedShare: 0,
    localShapeTokenCoverage: 0,
    discriminativeCandidateTokens: [],
    familyGenericTokens: [],
    dominantSiblingEntryIds: [],
    dominantSiblingClaimKeys: [],
  };
}

function extractAttributeTokens(claimKey: string): string[] {
  const compacted = compactClaimKey(claimKey);
  if (compacted) {
    return compacted.attribute.split("_").filter((token) => token.length > 0);
  }

  const normalized = normalizeClaimKey(claimKey);
  if (!normalized.ok) {
    return [];
  }

  return normalized.value.attribute.split("_").filter((token) => token.length > 0);
}

function countFamilyTokenFrequency(attributes: string[][]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const tokens of attributes) {
    for (const token of new Set(tokens)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return counts;
}

function resolveResonanceShapeTokens(candidateTokens: string[], discriminativeCandidateTokens: string[], siblingTokens: string[]): string[] {
  const siblingTokenSet = new Set(siblingTokens);
  const sharedTokens = candidateTokens.filter((token) => siblingTokenSet.has(token));
  if (sharedTokens.length < MIN_RESONANT_SHARED_TOKENS) {
    return [];
  }

  const sharedDiscriminativeTokens = discriminativeCandidateTokens.filter((token) => siblingTokenSet.has(token));
  const sharedSpan = findLongestSharedContiguousSpan(candidateTokens, siblingTokens);
  if (sharedSpan.length >= MIN_RESONANT_SHARED_TOKENS) {
    return sharedSpan;
  }

  const candidateHead = candidateTokens[candidateTokens.length - 1];
  const siblingHead = siblingTokens[siblingTokens.length - 1];
  if (candidateHead && siblingHead && candidateHead === siblingHead && sharedDiscriminativeTokens.length >= 1) {
    return dedupeOrderedTokens([...sharedDiscriminativeTokens, candidateHead]);
  }

  if (sharedDiscriminativeTokens.length >= MIN_RESONANT_SHARED_TOKENS) {
    return sharedDiscriminativeTokens;
  }

  return [];
}

function findLongestSharedContiguousSpan(candidateTokens: string[], siblingTokens: string[]): string[] {
  let best: string[] = [];

  for (let start = 0; start < candidateTokens.length; start += 1) {
    for (let end = start + MIN_RESONANT_SHARED_TOKENS; end <= candidateTokens.length; end += 1) {
      const span = candidateTokens.slice(start, end);
      if (span.length < best.length) {
        continue;
      }

      if (includesContiguousSpan(siblingTokens, span)) {
        if (span.length > best.length || span.join("_").localeCompare(best.join("_")) < 0) {
          best = span;
        }
      }
    }
  }

  return best;
}

function includesContiguousSpan(tokens: string[], span: string[]): boolean {
  if (span.length === 0 || span.length > tokens.length) {
    return false;
  }

  for (let start = 0; start <= tokens.length - span.length; start += 1) {
    let matched = true;
    for (let index = 0; index < span.length; index += 1) {
      if (tokens[start + index] !== span[index]) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return true;
    }
  }

  return false;
}

function dedupeOrderedTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const token of tokens) {
    if (seen.has(token)) {
      continue;
    }

    seen.add(token);
    deduped.push(token);
  }

  return deduped;
}
