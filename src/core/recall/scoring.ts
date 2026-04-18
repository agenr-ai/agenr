import type { Expiry } from "../types.js";

const DAY_IN_MILLISECONDS = 1000 * 60 * 60 * 24;
const IMPORTANCE_FLOOR = 0.4;
const RELEVANCE_WEIGHT = 0.5;
const RECENCY_WEIGHT = 0.25;
const IMPORTANCE_WEIGHT = 0.25;

/**
 * Score breakdown returned for a ranked recall candidate.
 */
export interface CandidateScore {
  score: number;
  scores: {
    relevance: number;
    vector: number;
    lexical: number;
    recency: number;
    importance: number;
  };
}

/**
 * Compute the tier-aware half-life recency score for an entry.
 *
 * @param createdAt - Entry creation timestamp.
 * @param expiry - Entry durability tier.
 * @param now - Reference time for the age calculation.
 * @returns Normalized recency score in the 0-1 range.
 */
export function recencyScore(createdAt: Date | string, expiry: Expiry, now: Date = new Date()): number {
  if (expiry === "core") {
    return 1;
  }

  const createdDate = asValidDate(createdAt);
  const nowDate = asValidDate(now);
  if (!createdDate || !nowDate) {
    return 0;
  }

  const halfLifeDays = expiry === "permanent" ? 365 : 30;
  const daysOld = Math.max(0, (nowDate.getTime() - createdDate.getTime()) / DAY_IN_MILLISECONDS);
  return clampUnit(Math.pow(0.5, daysOld / halfLifeDays));
}

/**
 * Compute a gaussian recency score centered on an around-date query anchor.
 *
 * @param createdAt - Entry creation timestamp.
 * @param aroundDate - Temporal anchor inferred or provided by the user.
 * @param radiusDays - Standard deviation-like radius in days.
 * @returns Normalized temporal proximity score in the 0-1 range.
 */
export function gaussianRecency(createdAt: Date | string, aroundDate: Date, radiusDays: number): number {
  const createdDate = asValidDate(createdAt);
  const anchorDate = asValidDate(aroundDate);
  const normalizedRadius = sanitizeNonNegative(radiusDays);

  if (!createdDate || !anchorDate) {
    return 0;
  }

  if (normalizedRadius <= 0) {
    return createdDate.getTime() === anchorDate.getTime() ? 1 : 0;
  }

  const daysDelta = Math.abs(createdDate.getTime() - anchorDate.getTime()) / DAY_IN_MILLISECONDS;
  return clampUnit(Math.exp(-0.5 * (daysDelta / normalizedRadius) ** 2));
}

/**
 * Normalize an importance value from the 1-10 domain into the 0.4-1.0 score range.
 *
 * @param importance - Raw entry importance.
 * @returns Normalized importance score in the 0-1 range.
 */
export function importanceScore(importance: number): number {
  const clampedImportance = clampRange(sanitizeNonNegative(importance), 1, 10);
  return clampUnit(IMPORTANCE_FLOOR + ((clampedImportance - 1) / 9) * (1 - IMPORTANCE_FLOOR));
}

/**
 * Compute the final recall score and its component breakdown for a candidate.
 *
 * Callers are expected to supply the fused `relevance` signal through
 * reciprocal rank fusion. `vectorSim` and `lexical` are kept on the score
 * breakdown as evidence-only diagnostics so trace summaries can still
 * display the raw retrieval signals without influencing the composite.
 *
 * @param params - Candidate signal inputs.
 * @returns Final score plus signal breakdown.
 */
export function scoreCandidate(params: { relevance: number; vectorSim: number; lexical: number; recency: number; importance: number }): CandidateScore {
  const vector = clampUnit(sanitizeNonNegative(params.vectorSim));
  const lexical = clampUnit(sanitizeNonNegative(params.lexical));
  const recency = clampUnit(sanitizeNonNegative(params.recency));
  const importance = clampUnit(sanitizeNonNegative(params.importance));
  const relevance = clampUnit(sanitizeNonNegative(params.relevance));
  const score = clampUnit(relevance * RELEVANCE_WEIGHT + recency * RECENCY_WEIGHT + importance * IMPORTANCE_WEIGHT);

  return {
    score,
    scores: {
      relevance,
      vector,
      lexical,
      recency,
      importance,
    },
  };
}

/**
 * Compute cosine similarity between two numeric vectors.
 *
 * Non-finite coordinates are treated as zero and negative similarities are clamped
 * to zero because recall scoring only consumes a 0-1 signal.
 *
 * @param left - Left-hand vector.
 * @param right - Right-hand vector.
 * @returns Cosine similarity in the 0-1 range.
 */
export function cosineSimilarity(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  if (size === 0) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < size; index += 1) {
    const leftValue = sanitizeFinite(left[index]);
    const rightValue = sanitizeFinite(right[index]);
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }

  return clampUnit(dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)));
}

/** Convert a string or Date input into a valid Date, or null when invalid. */
const asValidDate = (value: Date | string): Date | null => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Clamp a number into the inclusive 0-1 range. */
const clampUnit = (value: number): number => clampRange(sanitizeNonNegative(value), 0, 1);

/** Clamp a number into an inclusive numeric range. */
const clampRange = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Convert non-finite numbers into zero and preserve finite values. */
const sanitizeFinite = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Convert non-finite and negative values into zero. */
const sanitizeNonNegative = (value: number | undefined): number => Math.max(0, sanitizeFinite(value));
