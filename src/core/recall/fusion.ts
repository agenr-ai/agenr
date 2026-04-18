/**
 * Reciprocal rank fusion (RRF) helpers used by entry, episode, and procedure
 * recall to combine multiple retrieval channels into a single relevance signal.
 *
 * Modeled on graphiti's `rrf()` helper in
 * `graphiti_core/search/search_utils.py:1780`, with two local adaptations:
 *
 * - A larger default constant (`k = 60`) matching the canonical Cormack et al.
 *   RRF paper so early ranks do not dominate the fused score.
 * - A post-pass that normalizes scores into the `0-1` range so downstream
 *   composite scoring can mix fused relevance with recency and importance.
 */

/**
 * Default RRF rank constant. The Cormack et al. RRF paper uses `k = 60` as a
 * conservative anchor that flattens the contribution of the top handful of
 * ranks without letting any single channel dominate.
 */
export const DEFAULT_RRF_RANK_CONSTANT = 60;

/**
 * One input channel of ranked identifiers.
 *
 * Each channel should be an ordered list from most-relevant to least-relevant,
 * as produced by vector search, FTS, temporal match, or any other retrieval
 * path. Channels may overlap or be disjoint and ties inside a channel are
 * resolved by the caller before passing them in.
 */
export type RrfChannel = readonly string[];

/**
 * Fuse one or more ranked channels into a single normalized score map.
 *
 * An identifier's unnormalized RRF score is the sum across channels of
 * `1 / (rankIndex + k)`, where `rankIndex` is the candidate's zero-based
 * position inside that channel. Candidates missing from a channel contribute
 * nothing from that channel.
 *
 * The result is then normalized by the theoretical maximum for the supplied
 * channel count so that an identifier appearing at the top of every supplied
 * channel maps to `1.0` and a single appearance in one of `N` channels maps
 * to roughly `1/N` at the very top rank. Empty channels are ignored and do
 * not count toward the normalization denominator.
 *
 * The helper is deliberately pure and side-effect free so the composite
 * recall pipeline can invoke it for entries, episodes, and procedures
 * without depending on any adapter.
 *
 * @param channels - Ordered rank lists from each retrieval channel.
 * @param rankConstant - Optional override for the RRF rank constant `k`.
 * @returns Map from identifier to normalized RRF score in the `0-1` range.
 */
export function rrfFuse(channels: readonly RrfChannel[], rankConstant: number = DEFAULT_RRF_RANK_CONSTANT): Map<string, number> {
  const k = sanitizeRankConstant(rankConstant);
  const nonEmptyChannels = channels.filter((channel) => channel.length > 0);
  const scores = new Map<string, number>();

  if (nonEmptyChannels.length === 0) {
    return scores;
  }

  for (const channel of nonEmptyChannels) {
    // Track the first occurrence within each channel to keep ties deterministic,
    // avoid double-counting a candidate that an adapter emits twice, and compact
    // the rank index so duplicates do not shift other candidates' positions.
    const seenInChannel = new Set<string>();
    let compactedRank = 0;
    for (const id of channel) {
      if (id === undefined || seenInChannel.has(id)) {
        continue;
      }

      seenInChannel.add(id);
      const contribution = 1 / (compactedRank + k);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
      compactedRank += 1;
    }
  }

  // Theoretical maximum when a candidate is top-ranked in every non-empty
  // channel. Normalizing by this value keeps the fused relevance signal in
  // the `0-1` range the rest of recall scoring expects.
  const normalizationDenominator = nonEmptyChannels.length * (1 / k);
  for (const [id, score] of scores) {
    scores.set(id, clampUnit(score / normalizationDenominator));
  }

  return scores;
}

/**
 * Convenience wrapper for the common two-channel case used by entry and
 * procedure recall.
 *
 * @param vectorRanks - Vector retrieval channel, most-relevant first.
 * @param lexicalRanks - Lexical retrieval channel, most-relevant first.
 * @param rankConstant - Optional override for the RRF rank constant `k`.
 * @returns Map from identifier to normalized RRF score.
 */
export function rrfFuseVectorLexical(
  vectorRanks: readonly string[],
  lexicalRanks: readonly string[],
  rankConstant: number = DEFAULT_RRF_RANK_CONSTANT,
): Map<string, number> {
  return rrfFuse([vectorRanks, lexicalRanks], rankConstant);
}

/** Coerce the rank constant into a safe positive finite number. */
function sanitizeRankConstant(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_RRF_RANK_CONSTANT;
  }

  return value;
}

/** Clamp a number into the inclusive `0-1` range. */
function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return value >= 1 ? 1 : value;
}
