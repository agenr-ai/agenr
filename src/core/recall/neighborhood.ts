import type { Episode, Procedure } from "../types.js";

import { tokenize } from "./lexical.js";
import type { RecallCandidateEntry } from "./types.js";

/**
 * Neighborhood expansion and seeded rerank helpers.
 *
 * Bounded graph-style expansion and a distance-style reranker both sit after
 * RRF fusion. agenr does not have a graph DB, so "neighborhood" means a
 * bounded sweep over sibling claim keys, supersession chains, procedure
 * revisions, episode session families, and topical peers as computed from
 * the existing relational model.
 *
 * The helpers in this file are deliberately pure:
 * - `selectStrongSeeds()` picks retrieval leaders whose gap to the rest of
 *   the pack clearly earns them seed status.
 * - `seededRerank()` applies a small positive delta to ranked candidates
 *   that share lineage with at least one strong seed, without ever lifting
 *   a candidate that has no lineage signal.
 * - The domain-specific predicates (`sharesEntryLineage`,
 *   `sharesEpisodeLineage`, `sharesProcedureLineage`) encode what "shares
 *   lineage" means for entries, episodes, and procedures respectively.
 */

/**
 * Discriminated neighborhood family kinds used to describe one expansion
 * direction across the recall pipeline.
 *
 * - `supersession_chain` reaches along `superseded_by` pointers.
 * - `claim_key_sibling` reaches across rows sharing one claim-key slot.
 * - `procedure_revision` reaches across revisions of one procedure key.
 * - `session_family` reaches across episodes originating in the same
 *   session identity (same `source` plus `sourceId`).
 * - `topic_family` reaches across rows sharing a strong subject prefix and
 *   is the weakest, retired-only fallback for entries.
 */
export type NeighborhoodFamily = "supersession_chain" | "claim_key_sibling" | "procedure_revision" | "session_family" | "topic_family";

/**
 * Adapter-facing request for the bounded entry neighborhood expansion port.
 *
 * This is the generalized successor of the phase 1 `fetchPredecessors`
 * lookup. The adapter should honor the requested `families` exactly and
 * respect `includeRetired` as a hard gate so the default entry profile
 * never pulls retired rows into the candidate pool.
 */
export interface EntryNeighborhoodRequest {
  /** Seed entry IDs to expand around. */
  seedIds: string[];
  /** Maximum total rows the adapter may return. */
  budget: number;
  /** Families the adapter should traverse. */
  families: readonly NeighborhoodFamily[];
  /** When true, retired rows are eligible; when false, only active rows. */
  includeRetired?: boolean;
}

/** Default total-rows budget for one neighborhood expansion call. */
export const DEFAULT_NEIGHBORHOOD_BUDGET = 24;

/** Default top-N size used when choosing strong rerank seeds. */
export const DEFAULT_STRONG_SEED_TOP_N = 3;

/**
 * Minimum score gap that separates strong seeds from the pack.
 *
 * Keeping the floor small but non-zero prevents flat score landscapes
 * (common when RRF produces ties) from promoting every candidate into a
 * seed, which would collapse seededRerank into "boost everything".
 */
export const DEFAULT_STRONG_SEED_SCORE_GAP = 0.05;

/**
 * Default positive delta applied to candidates that share lineage with a
 * strong seed. Intentionally smaller than the existing historical lineage
 * boosts so the stage cannot override claim-key shaping or historical
 * trust suppression.
 */
export const DEFAULT_SEEDED_RERANK_WEIGHT = 0.03;

/** Shared shape used by all seededRerank callers. */
export interface SeededRerankCandidate {
  /** Stable identifier used to detect the seed itself and skip rerank. */
  id: string;
  /** Current ranked score in the 0-1 range. */
  score: number;
}

/** Tuning knobs for strong-seed selection and seededRerank. */
export interface SeededRerankOptions {
  /** Positive delta applied to lineage-matched candidates. */
  weight?: number;
  /** Top candidate count to consider as potential seeds. */
  topN?: number;
  /** Minimum score gap between the leader and the top-N follower. */
  scoreGapFloor?: number;
}

/**
 * Pick the top-ranked candidates that clearly stand apart from the pack.
 *
 * The score gap between the leader and the first candidate past the
 * `topN` cutoff must exceed `scoreGapFloor` for any seeds to qualify.
 * A flat ranking (common when every candidate earned the same RRF score)
 * therefore produces zero seeds and leaves the rest of the pipeline alone.
 *
 * @param candidates - Candidates after scoring but before final shaping.
 * @param options - Optional top-N and score-gap tuning.
 * @returns The strong-seed subset ordered from strongest to weakest.
 */
export function selectStrongSeeds<TCandidate extends SeededRerankCandidate>(
  candidates: readonly TCandidate[],
  options: SeededRerankOptions = {},
): TCandidate[] {
  if (candidates.length === 0) {
    return [];
  }

  const topN = Math.max(1, sanitizeInteger(options.topN, DEFAULT_STRONG_SEED_TOP_N));
  const floor = sanitizeUnit(options.scoreGapFloor ?? DEFAULT_STRONG_SEED_SCORE_GAP);
  const ordered = [...candidates].sort((left, right) => right.score - left.score);
  const leader = ordered[0];
  if (!leader || leader.score <= 0) {
    return [];
  }

  const followerScore = ordered[topN]?.score ?? 0;
  if (leader.score - followerScore < floor) {
    return [];
  }

  const cutoff = Math.max(leader.score - floor, followerScore);
  return ordered.slice(0, topN).filter((candidate) => candidate.score >= cutoff);
}

/**
 * Boost ranked candidates that share lineage with at least one strong seed.
 *
 * - Seeds themselves are left unchanged.
 * - Candidates without lineage evidence are left unchanged.
 * - Matched candidates receive `weight` added to their score, clamped to
 *   the 0-1 range.
 * - The rerank never lifts a candidate that has no lineage relationship
 *   to any seed, which is the core safety property called out in the plan.
 *
 * @param candidates - Ranked candidate list prior to rerank.
 * @param seeds - Strong seeds chosen via `selectStrongSeeds`.
 * @param sharesLineage - Domain-specific predicate returning true when the
 *   candidate shares structural or topical lineage with the supplied seed.
 * @param options - Tuning knobs (weight only has an effect here).
 * @returns Candidates with any lineage-boosted scores applied.
 */
export function seededRerank<TCandidate extends SeededRerankCandidate>(
  candidates: readonly TCandidate[],
  seeds: readonly TCandidate[],
  sharesLineage: (candidate: TCandidate, seed: TCandidate) => boolean,
  options: SeededRerankOptions = {},
): { candidates: TCandidate[]; boostedIds: string[] } {
  const boostedIds: string[] = [];
  if (candidates.length === 0 || seeds.length === 0) {
    return { candidates: [...candidates], boostedIds };
  }

  const weight = sanitizeUnit(options.weight ?? DEFAULT_SEEDED_RERANK_WEIGHT);
  if (weight <= 0) {
    return { candidates: [...candidates], boostedIds };
  }

  const seedIds = new Set(seeds.map((seed) => seed.id));
  const reranked = candidates.map((candidate) => {
    if (seedIds.has(candidate.id)) {
      return candidate;
    }

    const match = seeds.find((seed) => seed.id !== candidate.id && sharesLineage(candidate, seed));
    if (!match) {
      return candidate;
    }

    boostedIds.push(candidate.id);
    return {
      ...candidate,
      score: clampUnit(candidate.score + weight),
    };
  });

  return { candidates: reranked, boostedIds };
}

/**
 * Decide whether two entry candidates share lineage for rerank purposes.
 *
 * Three relationships qualify as lineage:
 * - Same `claim_key` (same slot in the claim-key model).
 * - Direct `superseded_by` link in either direction.
 * - Shared subject prefix wide enough to count as the same topic.
 *
 * @param candidate - Candidate entry under evaluation.
 * @param seed - Strong-seed entry the candidate is being compared to.
 * @returns True when the two entries share lineage, false otherwise.
 */
export function sharesEntryLineage(candidate: RecallCandidateEntry, seed: RecallCandidateEntry): boolean {
  if (candidate.id === seed.id) {
    return false;
  }

  if (candidate.claim_key && seed.claim_key && candidate.claim_key === seed.claim_key) {
    return true;
  }

  if (candidate.superseded_by === seed.id || seed.superseded_by === candidate.id) {
    return true;
  }

  return sharesTopicPrefix(candidate.subject, seed.subject);
}

/**
 * Decide whether two episodes belong to the same session family.
 *
 * - Same `source` plus `sourceId` is the strongest signal; it identifies
 *   the same originating session across storage and rehydration paths.
 * - A shared `transcriptHash` is the fallback when one side lacks a
 *   persisted `sourceId`, since episodes that land on the same transcript
 *   are structurally the same session even after re-ingest.
 *
 * @param candidate - Candidate episode under evaluation.
 * @param seed - Strong-seed episode the candidate is being compared to.
 * @returns True when the episodes share session lineage.
 */
export function sharesEpisodeLineage(candidate: Episode, seed: Episode): boolean {
  if (candidate.id === seed.id) {
    return false;
  }

  if (candidate.source === seed.source && candidate.sourceId !== undefined && candidate.sourceId === seed.sourceId) {
    return true;
  }

  if (candidate.transcriptHash && seed.transcriptHash && candidate.transcriptHash === seed.transcriptHash) {
    return true;
  }

  return false;
}

/**
 * Decide whether two procedures share the same procedure-key revision chain.
 *
 * @param candidate - Candidate procedure under evaluation.
 * @param seed - Strong-seed procedure the candidate is being compared to.
 * @returns True when both rows share one stable procedure key.
 */
export function sharesProcedureLineage(candidate: Procedure, seed: Procedure): boolean {
  if (candidate.id === seed.id) {
    return false;
  }

  return candidate.procedure_key === seed.procedure_key;
}

/** Minimum number of shared prefix tokens that count as topic lineage. */
const TOPIC_PREFIX_SHARED_MIN = 2;

/** Minimum prefix coverage ratio of the shorter side for topic lineage. */
const TOPIC_PREFIX_COVERAGE_MIN = 0.6;

/**
 * Check whether two subject strings share enough of a leading token prefix
 * to count as the same topic family.
 *
 * The shared prefix must be at least two tokens long and cover at least
 * 60% of the shorter side. That threshold mirrors the fallback "same
 * topic" rule already used by historical lineage shaping, so topic-family
 * behavior stays aligned across the two stages.
 *
 * @param leftSubject - First subject under comparison.
 * @param rightSubject - Second subject under comparison.
 * @returns True when the two subjects share enough of their leading prefix.
 */
function sharesTopicPrefix(leftSubject: string, rightSubject: string): boolean {
  const leftTokens = tokenize(leftSubject);
  const rightTokens = tokenize(rightSubject);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return false;
  }

  const length = Math.min(leftTokens.length, rightTokens.length);
  let shared = 0;
  for (let index = 0; index < length; index += 1) {
    if (leftTokens[index] !== rightTokens[index]) {
      break;
    }

    shared += 1;
  }

  if (shared < TOPIC_PREFIX_SHARED_MIN) {
    return false;
  }

  return shared / length >= TOPIC_PREFIX_COVERAGE_MIN;
}

/** Clamp a number into the inclusive 0-1 range. */
function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return value >= 1 ? 1 : value;
}

/** Sanitize an optional 0-1 input, falling back to the default on bad input. */
function sanitizeUnit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.min(1, value);
}

/** Sanitize an optional integer input with a safe default fallback. */
function sanitizeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
}
