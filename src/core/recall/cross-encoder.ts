import type { CrossEncoderPort } from "../ports.js";

import type { RecallCrossEncoderDegradedReason } from "./trace.js";

/**
 * Cross-encoder rerank orchestration helper.
 *
 * - Keeps core recall free of adapter concerns: the helper only needs a
 *   `CrossEncoderPort` contract defined in `src/core/ports.ts`.
 * - Reranks only the top-K shortlist supplied by the caller. Candidates
 *   past the shortlist keep their input order and composite score.
 * - Combines the provider score with the prior composite score through a
 *   linear blend: `alpha * crossEncoderScore + (1 - alpha) * prior`, so
 *   MMR, claim-key shaping, and seeded rerank still participate in the
 *   final ordering.
 * - Fails closed: any thrown or malformed adapter response short-circuits
 *   into a pass-through result with a trace-visible degraded reason.
 *
 * The helper is pure and deterministic given a deterministic port: it
 * does not mutate callers' inputs, does not read ambient state, and does
 * not log.
 */

/**
 * Default top-K shortlist size. Bounded small so cross-encoder latency
 * and provider cost stay predictable even at full recall fan-out.
 */
export const DEFAULT_CROSS_ENCODER_TOP_K = 10;

/**
 * Default blend weight between the cross-encoder score and the prior
 * composite score. Chosen to let the cross-encoder dominate while still
 * letting prior shaping stages shape the final order.
 */
export const DEFAULT_CROSS_ENCODER_ALPHA = 0.6;

/**
 * One input candidate for the cross-encoder rerank helper.
 *
 * @template TCandidate - Caller-provided candidate shape passed through untouched.
 */
export interface CrossEncoderRerankCandidate<TCandidate> {
  /** Stable identifier used to correlate provider scores back to the candidate. */
  id: string;
  /** Caller-provided free-form text fed into the cross-encoder. */
  text: string;
  /** Prior composite score retained for the linear blend. */
  score: number;
  /** Original candidate reference returned to the caller. */
  candidate: TCandidate;
}

/**
 * Call options for `applyCrossEncoderRerank`.
 */
export interface CrossEncoderRerankOptions<TCandidate> {
  /** Natural-language recall query text. */
  query: string;
  /** Candidates in their caller-preferred order. */
  candidates: readonly CrossEncoderRerankCandidate<TCandidate>[];
  /** Cross-encoder port when available. When undefined, the stage skips. */
  port: CrossEncoderPort | undefined;
  /** Whether the caller explicitly disabled the stage. */
  disabled?: boolean;
  /** Optional top-K override. Clamped into `[1, candidates.length]`. */
  topK?: number;
  /** Optional blend weight override. Clamped into `[0, 1]`. */
  alpha?: number;
}

/**
 * Result returned by the cross-encoder rerank helper.
 *
 * @template TCandidate - Caller-provided candidate shape passed through untouched.
 */
export interface CrossEncoderRerankResult<TCandidate> {
  /** Whether the stage actually invoked the cross-encoder port. */
  applied: boolean;
  /** Effective top-K size used by the stage. */
  k: number;
  /** Effective blend weight used by the stage. */
  alpha: number;
  /** Wall-clock latency of the stage in milliseconds. */
  latencyMs: number;
  /** Stable degraded-mode reason when the stage did not rerank. */
  degradedReason?: RecallCrossEncoderDegradedReason;
  /**
   * Candidates in their reranked order. Candidates past the shortlist
   * keep their input order and their prior score.
   */
  candidates: ReadonlyArray<{
    /** Original candidate reference. */
    candidate: TCandidate;
    /** Final composite score after blending. */
    score: number;
    /** Raw cross-encoder score when the candidate was reranked. */
    crossEncoderScore?: number;
  }>;
  /** Candidate IDs whose composite score was actually reshaped. */
  rescoredIds: string[];
}

/**
 * Apply a cross-encoder rerank over the top-K shortlist of candidates.
 *
 * The helper is pure: no IO happens outside the provided
 * `CrossEncoderPort`. The caller owns reading the resulting candidate
 * order and merging the returned scores back into its ranking model.
 *
 * @template TCandidate - Candidate payload shape returned by the caller.
 * @param options - Orchestration options including the port and limits.
 * @returns Reranked candidates with trace-visible facts for diagnostics.
 */
export async function applyCrossEncoderRerank<TCandidate>(options: CrossEncoderRerankOptions<TCandidate>): Promise<CrossEncoderRerankResult<TCandidate>> {
  const candidates = [...options.candidates];
  const k = resolveTopK(options.topK, candidates.length);
  const alpha = resolveAlpha(options.alpha);
  const startedAt = Date.now();

  const passthrough = (degradedReason?: RecallCrossEncoderDegradedReason): CrossEncoderRerankResult<TCandidate> => ({
    applied: false,
    k,
    alpha,
    latencyMs: elapsedMs(startedAt),
    ...(degradedReason ? { degradedReason } : {}),
    candidates: candidates.map((candidate) => ({
      candidate: candidate.candidate,
      score: candidate.score,
    })),
    rescoredIds: [],
  });

  if (options.disabled === true) {
    return passthrough("disabled");
  }

  if (!options.port) {
    return passthrough("not_configured");
  }

  if (candidates.length === 0) {
    return passthrough("no_candidates");
  }

  const shortlist = candidates.slice(0, k);
  const tail = candidates.slice(k);
  const query = options.query.trim();
  if (query.length === 0 || shortlist.length === 0) {
    return passthrough("no_candidates");
  }

  let scores: readonly { id: string; score: number }[];
  try {
    scores = await options.port.rank(
      query,
      shortlist.map((candidate) => ({ id: candidate.id, text: candidate.text })),
    );
  } catch {
    return passthrough("provider_error");
  }

  if (!Array.isArray(scores)) {
    return passthrough("provider_error");
  }

  const scoreById = new Map<string, number>();
  for (const entry of scores) {
    if (!entry || typeof entry.id !== "string" || typeof entry.score !== "number" || !Number.isFinite(entry.score)) {
      continue;
    }

    scoreById.set(entry.id, clampUnit(entry.score));
  }

  if (scoreById.size === 0) {
    return passthrough("provider_error");
  }

  const rescoredIds: string[] = [];
  const rescoredShortlist = shortlist.map((candidate) => {
    const crossEncoderScore = scoreById.get(candidate.id);
    if (crossEncoderScore === undefined) {
      return {
        candidate: candidate.candidate,
        score: candidate.score,
        id: candidate.id,
        rescored: false,
      };
    }

    const nextScore = clampUnit(alpha * crossEncoderScore + (1 - alpha) * candidate.score);
    if (nextScore !== candidate.score) {
      rescoredIds.push(candidate.id);
    }

    return {
      candidate: candidate.candidate,
      score: nextScore,
      crossEncoderScore,
      id: candidate.id,
      rescored: true,
    };
  });

  const reorderedShortlist = [...rescoredShortlist].sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    // Preserve caller order as a deterministic tie-break.
    return shortlist.findIndex((candidate) => candidate.id === left.id) - shortlist.findIndex((candidate) => candidate.id === right.id);
  });

  const shortlistOutput = reorderedShortlist.map(({ candidate, score, crossEncoderScore }) => ({
    candidate,
    score,
    ...(typeof crossEncoderScore === "number" ? { crossEncoderScore } : {}),
  }));
  const tailOutput = tail.map((candidate) => ({
    candidate: candidate.candidate,
    score: candidate.score,
  }));

  return {
    applied: true,
    k,
    alpha,
    latencyMs: elapsedMs(startedAt),
    candidates: [...shortlistOutput, ...tailOutput],
    rescoredIds,
  };
}

/**
 * Resolve the effective top-K from an optional override.
 *
 * @param value - Caller-provided top-K override.
 * @param total - Total candidate count available.
 * @returns Effective top-K clamped into `[1, total]`, or zero when there
 *   are no candidates.
 */
function resolveTopK(value: number | undefined, total: number): number {
  if (total <= 0) {
    return 0;
  }

  const raw = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_CROSS_ENCODER_TOP_K;
  return Math.max(1, Math.min(total, raw));
}

/**
 * Resolve the effective blend alpha from an optional override.
 *
 * @param value - Caller-provided alpha override.
 * @returns Alpha in the inclusive 0-1 range.
 */
function resolveAlpha(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CROSS_ENCODER_ALPHA;
  }

  return clampUnit(value);
}

/** Clamp a number into the inclusive 0-1 range. */
function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return value >= 1 ? 1 : value;
}

/** Returns a non-negative elapsed millisecond count for one stage. */
function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
