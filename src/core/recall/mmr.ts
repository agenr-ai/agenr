import { cosineSimilarity } from "./scoring.js";

/**
 * Maximal Marginal Relevance (MMR) diversification helper used by entry,
 * episode, and procedure recall.
 *
 * - Compute pairwise cosine similarity between every candidate embedding.
 * - For each candidate, combine relevance (cosine similarity to the query)
 *   with a diversity penalty equal to the maximum pairwise similarity to
 *   any other candidate.
 * - Sort candidates by the combined MMR score.
 *
 * Unlike the classical iterative MMR, the one-shot variant does not need
 * the caller to track an already-selected set and produces a stable
 * re-ranking directly from the candidate list. It is a good fit for the
 * small shortlists that arrive after RRF, claim-key shaping, and seeded
 * lineage rerank.
 */

/**
 * Default MMR lambda chosen to favor relevance while still giving the
 * diversity penalty room to demote near-duplicate candidates. Matches the
 * value called out in the phase 3 plan.
 */
export const DEFAULT_MMR_LAMBDA = 0.7;

/**
 * Threshold above which two candidate embeddings are treated as near
 * duplicates for trace accounting. Only influences the
 * `droppedDuplicateCount` counter; it does not affect the MMR ordering.
 */
export const NEAR_DUPLICATE_SIMILARITY = 0.95;

/**
 * Input candidate consumed by the MMR helper.
 */
export interface MmrCandidate {
  /** Stable identifier used to match candidates back to the caller's list. */
  id: string;
  /** Optional embedding vector. Candidates without embeddings skip MMR. */
  embedding?: number[];
  /**
   * Optional caller-provided relevance signal in the 0-1 range. When
   * supplied, MMR uses this value as the relevance term instead of the
   * default `cos(queryVector, embedding)` fallback.
   *
   * Pipelines that have already performed shaping (historical lineage
   * boosts, claim-key trust and redundancy penalties) should pass their
   * shaped composite score so MMR respects that prior work instead of
   * silently undoing it.
   */
  relevance?: number;
}

/**
 * MMR reorder outcome returned to the caller.
 */
export interface MmrReorderResult {
  /** Whether MMR actually ran instead of passing through the input order. */
  applied: boolean;
  /** Effective lambda that was used during ranking. */
  lambda: number;
  /** Reordered candidate IDs. Includes every input candidate exactly once. */
  orderedIds: string[];
  /**
   * Number of candidates that MMR identified as near duplicates (max
   * pairwise similarity with another candidate at or above
   * `NEAR_DUPLICATE_SIMILARITY`) and pushed down in the final order.
   */
  droppedDuplicateCount: number;
  /**
   * IDs whose position changed from the input order as a result of MMR
   * re-ranking. Empty when MMR was skipped.
   */
  reorderedIds: string[];
}

/**
 * MMR call signature.
 */
export interface MmrOptions {
  /** Query embedding used as the relevance signal. */
  queryVector: number[];
  /** Candidates in their caller-preferred order. */
  candidates: readonly MmrCandidate[];
  /** Optional lambda override. Clamped into `[0, 1]`. */
  lambda?: number;
  /** Optional final result limit applied after MMR ordering. */
  limit?: number;
}

/**
 * Reorder candidates by maximal marginal relevance.
 *
 * The helper is pure and does not mutate any input. Candidates without a
 * usable embedding keep their input order after the embedded candidates,
 * so missing-embedding fallbacks degrade to pass-through rather than
 * crashing. When the query vector is empty or at most one candidate has
 * an embedding, MMR is skipped and the input order is returned as-is.
 *
 * @param options - Query embedding plus candidate list and tuning knobs.
 * @returns Reorder result with ordered IDs, MMR scores, and trace facts.
 */
export function maximalMarginalRelevance(options: MmrOptions): MmrReorderResult {
  const lambda = clampUnit(sanitizeNumber(options.lambda, DEFAULT_MMR_LAMBDA));
  const inputIds = options.candidates.map((candidate) => candidate.id);
  const limit = resolveLimit(options.limit, inputIds.length);

  const embeddedCandidates = options.candidates.filter((candidate) => hasUsableEmbedding(candidate.embedding));
  const unembeddedIds = options.candidates.filter((candidate) => !hasUsableEmbedding(candidate.embedding)).map((candidate) => candidate.id);

  const canApplyMmr = options.queryVector.length > 0 && embeddedCandidates.length >= 2;
  if (!canApplyMmr) {
    return {
      applied: false,
      lambda,
      orderedIds: sliceOrDefault(inputIds, limit),
      droppedDuplicateCount: 0,
      reorderedIds: [],
    };
  }

  const relevanceById = new Map<string, number>();
  for (const candidate of embeddedCandidates) {
    const overriddenRelevance = sanitizeUnit(candidate.relevance);
    const derivedRelevance = overriddenRelevance ?? cosineSimilarity(options.queryVector, candidate.embedding ?? []);
    relevanceById.set(candidate.id, derivedRelevance);
  }

  const pairwiseMaxById = computePairwiseMaxSimilarity(embeddedCandidates);

  const mmrScoreById = new Map<string, number>();
  for (const candidate of embeddedCandidates) {
    const relevance = relevanceById.get(candidate.id) ?? 0;
    const maxPairwise = pairwiseMaxById.get(candidate.id) ?? 0;
    mmrScoreById.set(candidate.id, lambda * relevance - (1 - lambda) * maxPairwise);
  }

  const rankedEmbeddedIds = [...embeddedCandidates]
    .sort((left, right) => {
      const leftScore = mmrScoreById.get(left.id) ?? 0;
      const rightScore = mmrScoreById.get(right.id) ?? 0;
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }

      // Stable fallback: preserve the caller's order for equal scores so
      // diverse candidates with tied MMR scores do not shuffle randomly.
      return inputIds.indexOf(left.id) - inputIds.indexOf(right.id);
    })
    .map((candidate) => candidate.id);

  const orderedIds = sliceOrDefault([...rankedEmbeddedIds, ...unembeddedIds], limit);
  const reorderedIds = inputIds.filter((id, index) => orderedIds[index] !== id);
  const droppedDuplicateCount = countDroppedDuplicates(rankedEmbeddedIds, inputIds, pairwiseMaxById);

  return {
    applied: true,
    lambda,
    orderedIds,
    droppedDuplicateCount,
    reorderedIds,
  };
}

/**
 * Compute each candidate's maximum pairwise cosine similarity against any
 * other candidate in the embedded-candidate set.
 *
 * Self-similarity is excluded by skipping the diagonal. When only a
 * single candidate has an embedding, the returned map is empty.
 *
 * @param embeddedCandidates - Candidate list restricted to rows with embeddings.
 * @returns Map from candidate ID to its max pairwise similarity.
 */
function computePairwiseMaxSimilarity(embeddedCandidates: readonly MmrCandidate[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const candidate of embeddedCandidates) {
    result.set(candidate.id, 0);
  }

  for (let outer = 0; outer < embeddedCandidates.length; outer += 1) {
    for (let inner = outer + 1; inner < embeddedCandidates.length; inner += 1) {
      const left = embeddedCandidates[outer]!;
      const right = embeddedCandidates[inner]!;
      const similarity = cosineSimilarity(left.embedding ?? [], right.embedding ?? []);
      if (similarity > (result.get(left.id) ?? 0)) {
        result.set(left.id, similarity);
      }
      if (similarity > (result.get(right.id) ?? 0)) {
        result.set(right.id, similarity);
      }
    }
  }

  return result;
}

/**
 * Count candidates that MMR identified as near duplicates and demoted
 * below their input position. A candidate counts as a dropped duplicate
 * when its max pairwise similarity to another candidate is at or above
 * `NEAR_DUPLICATE_SIMILARITY` and its MMR rank is worse than its input
 * rank.
 *
 * @param rankedEmbeddedIds - Candidates ordered by MMR score.
 * @param inputIds - Candidates in their caller-preferred order.
 * @param pairwiseMaxById - Precomputed max pairwise similarity per candidate.
 * @returns Count of near-duplicate candidates demoted by MMR.
 */
function countDroppedDuplicates(rankedEmbeddedIds: readonly string[], inputIds: readonly string[], pairwiseMaxById: Map<string, number>): number {
  const inputRankById = new Map<string, number>();
  inputIds.forEach((id, index) => inputRankById.set(id, index));

  let droppedDuplicates = 0;
  rankedEmbeddedIds.forEach((id, mmrRank) => {
    const inputRank = inputRankById.get(id);
    if (inputRank === undefined || mmrRank <= inputRank) {
      return;
    }

    const maxSimilarity = pairwiseMaxById.get(id) ?? 0;
    if (maxSimilarity >= NEAR_DUPLICATE_SIMILARITY) {
      droppedDuplicates += 1;
    }
  });

  return droppedDuplicates;
}

/**
 * Slice an ordered ID list by `limit` when present. A non-finite or zero
 * limit returns the full list so callers can opt out of the limit step
 * without guarding at the call site.
 *
 * @param ids - Full ordered ID list.
 * @param limit - Resolved limit, already sanitized.
 * @returns Sliced ID list.
 */
function sliceOrDefault(ids: readonly string[], limit: number | null): string[] {
  if (limit === null || limit >= ids.length) {
    return [...ids];
  }

  return ids.slice(0, limit);
}

/**
 * Resolve the optional limit into a finite positive integer.
 *
 * @param value - Caller-supplied optional limit.
 * @param totalCandidates - Size of the candidate list used as an upper bound.
 * @returns Effective limit or null when no limit should apply.
 */
function resolveLimit(value: number | undefined, totalCandidates: number): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.min(totalCandidates, Math.floor(value));
}

/**
 * Returns true when the embedding vector has at least one numeric entry.
 *
 * @param embedding - Candidate embedding or undefined.
 * @returns Whether the embedding can participate in MMR math.
 */
function hasUsableEmbedding(embedding: number[] | undefined): boolean {
  return Array.isArray(embedding) && embedding.length > 0;
}

/**
 * Clamp a number into the inclusive 0-1 range.
 *
 * @param value - Candidate number.
 * @returns Clamped value.
 */
function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return value >= 1 ? 1 : value;
}

/**
 * Return a finite number falling back to a default when needed.
 *
 * @param value - Optional input number.
 * @param fallback - Default used when the input is missing or invalid.
 * @returns Sanitized number.
 */
function sanitizeNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return value;
}

/**
 * Return a finite number clamped into `[0, 1]`, or null when the input
 * is missing or invalid so the caller can fall back to a derived value.
 *
 * @param value - Optional input number.
 * @returns Sanitized unit-range value or null.
 */
function sanitizeUnit(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return clampUnit(value);
}
