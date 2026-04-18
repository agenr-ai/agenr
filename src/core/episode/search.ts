import type { EpisodeDatabasePort } from "../ports.js";
import { rrfFuse } from "../recall/fusion.js";
import { cosineSimilarity } from "../recall/scoring.js";

import { activityScore, compareEpisodeMatches, recencyScore, scoreEpisodeMatch } from "./scoring.js";
import { resolveTemporalWindowBounds } from "./temporal-window.js";
import type { EpisodeQuery, EpisodeResult } from "./types.js";

const DEFAULT_LIMIT = 10;
const MIN_CANDIDATE_LIMIT = 25;
const MAX_CANDIDATE_LIMIT = 100;
const CANDIDATE_MULTIPLIER = 5;

/**
 * Executes temporal, semantic, or hybrid episode recall against the episode database port.
 *
 * @param query - Episode recall query with temporal and/or semantic inputs.
 * @param database - Episode database adapter used for overlap lookup.
 * @param now - Reference clock used for recency tie-breaking.
 * @returns Ranked episodes ordered by the active mode's scoring rules.
 */
export async function searchEpisodes(query: EpisodeQuery, database: EpisodeDatabasePort, now: Date = new Date()): Promise<EpisodeResult[]> {
  const limit = normalizeLimit(query.limit);
  if (limit === 0) {
    return [];
  }

  const normalizedEmbedding = normalizeEmbedding(query.embedding);
  const bounds = query.timeWindow ? resolveTemporalWindowBounds(query.timeWindow, now) : null;
  const hasTemporal = bounds !== null;
  const hasSemantic = normalizedEmbedding.length > 0;

  if (!hasTemporal && !hasSemantic) {
    return [];
  }

  if (hasTemporal && !hasSemantic) {
    const candidates = await database.listEpisodesByTimeWindow(query.timeWindow!, computeCandidateLimit(limit));
    return candidates
      .map((episode) => scoreEpisodeMatch(episode, bounds, now))
      .sort(compareEpisodeMatches)
      .slice(0, limit)
      .map((match) => match.result);
  }

  if (!hasTemporal) {
    const matches = await database.episodeVectorSearch({
      embedding: normalizedEmbedding,
      limit,
    });
    return matches
      .map((match) => buildSemanticResult(match.episode, match.vectorSim, now))
      .sort(compareSemanticEpisodeResults)
      .slice(0, limit);
  }

  const candidates = await database.listEpisodesByTimeWindow(query.timeWindow!, computeCandidateLimit(limit));
  const hybridResults = candidates.map((episode) => buildHybridResult(episode, normalizedEmbedding, bounds, now));
  return fuseHybridResultsWithRrf(hybridResults).slice(0, limit);
}

/**
 * Fuses temporal and semantic rank lists via reciprocal rank fusion for the
 * hybrid episode recall mode. Candidates without embeddings only appear in the
 * temporal channel, which naturally ranks them below embedded matches.
 *
 * @param hybridResults - Scored hybrid episode results.
 * @returns Candidates ordered by fused RRF score with deterministic tie-breakers.
 */
function fuseHybridResultsWithRrf(hybridResults: EpisodeResult[]): EpisodeResult[] {
  if (hybridResults.length === 0) {
    return [];
  }

  const temporalRanks = [...hybridResults]
    .sort((left, right) => compareDescending(left.scores.temporal, right.scores.temporal) || compareAscending(left.episode.id, right.episode.id))
    .map((result) => result.episode.id);

  const semanticRanks = [...hybridResults]
    .filter((result) => result.scores.semantic > 0)
    .sort((left, right) => compareDescending(left.scores.semantic, right.scores.semantic) || compareAscending(left.episode.id, right.episode.id))
    .map((result) => result.episode.id);

  const fusedScores = rrfFuse([temporalRanks, semanticRanks]);

  const fused = hybridResults.map((result) => ({
    ...result,
    score: Number((fusedScores.get(result.episode.id) ?? 0).toFixed(6)),
  }));

  return fused.sort(compareFusedEpisodeResults);
}

/**
 * Compares hybrid episode results using the fused RRF score as the primary
 * signal, then falling back to the existing semantic and temporal tie-breakers.
 *
 * @param left - Left candidate.
 * @param right - Right candidate.
 * @returns Negative when left should sort first.
 */
function compareFusedEpisodeResults(left: EpisodeResult, right: EpisodeResult): number {
  return (
    compareDescending(left.score, right.score) ||
    compareDescending(left.scores.semantic, right.scores.semantic) ||
    compareDescending(left.scores.temporal, right.scores.temporal) ||
    compareDescending(left.scores.activity, right.scores.activity) ||
    compareDescending(left.scores.recency, right.scores.recency) ||
    compareAscending(left.episode.startedAt, right.episode.startedAt) ||
    compareAscending(left.episode.id, right.episode.id)
  );
}

/**
 * Normalizes a candidate request limit into the supported range.
 *
 * @param value - Optional caller-supplied result limit.
 * @returns Normalized positive integer limit.
 */
function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }

  if (!Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }

  return Math.max(0, Math.trunc(value));
}

/**
 * Computes the broad overlap candidate budget used before in-memory scoring.
 *
 * @param limit - Requested final result limit.
 * @returns Candidate lookup budget constrained to a bounded range.
 */
function computeCandidateLimit(limit: number): number {
  return Math.min(Math.max(limit * CANDIDATE_MULTIPLIER, MIN_CANDIDATE_LIMIT), MAX_CANDIDATE_LIMIT);
}

/**
 * Normalizes an optional query embedding into a finite numeric vector.
 *
 * @param embedding - Optional raw embedding.
 * @returns Finite numeric embedding values.
 */
function normalizeEmbedding(embedding: number[] | undefined): number[] {
  if (!embedding || embedding.length === 0) {
    return [];
  }

  return embedding.map((value) => (Number.isFinite(value) ? value : 0));
}

/**
 * Builds one pure semantic episode result with semantic-first scoring facts.
 *
 * @param episode - Stored episode row.
 * @param semantic - Cosine similarity for the query and episode summary.
 * @param now - Reference clock used for recency tie-breaking.
 * @returns Ranked semantic episode result.
 */
function buildSemanticResult(episode: EpisodeResult["episode"], semantic: number, now: Date): EpisodeResult {
  const parsedEpisodeEnd = new Date(episode.endedAt ?? episode.startedAt);
  const episodeEnd = Number.isNaN(parsedEpisodeEnd.getTime()) ? now : parsedEpisodeEnd;
  const activity = activityScore(episode.activityLevel);
  const recency = recencyScore(episodeEnd, now);
  const normalizedSemantic = Number(semantic.toFixed(6));

  return {
    episode,
    score: normalizedSemantic,
    scores: {
      temporal: 0,
      semantic: normalizedSemantic,
      activity: Number(activity.toFixed(6)),
      recency: Number(recency.toFixed(6)),
    },
  };
}

/**
 * Builds one hybrid episode result by combining temporal overlap facts with
 * semantic similarity as the primary rank signal.
 *
 * @param episode - Stored episode row.
 * @param queryEmbedding - Query embedding used for similarity.
 * @param bounds - Resolved temporal bounds used for overlap scoring.
 * @param now - Reference clock used for recency tie-breaking.
 * @returns Ranked hybrid episode result.
 */
function buildHybridResult(
  episode: EpisodeResult["episode"],
  queryEmbedding: number[],
  bounds: NonNullable<ReturnType<typeof resolveTemporalWindowBounds>>,
  now: Date,
): EpisodeResult {
  const temporalMatch = scoreEpisodeMatch(episode, bounds, now);
  const semantic = Number(cosineSimilarity(queryEmbedding, episode.embedding ?? []).toFixed(6));

  return {
    episode,
    score: semantic,
    scores: {
      temporal: temporalMatch.result.scores.temporal,
      semantic,
      activity: temporalMatch.result.scores.activity,
      recency: temporalMatch.result.scores.recency,
    },
  };
}

/**
 * Compares semantic or hybrid episode results using semantic similarity first,
 * then temporal, activity, and recency tie-breakers.
 *
 * @param left - Left candidate.
 * @param right - Right candidate.
 * @returns Negative when left should sort first.
 */
function compareSemanticEpisodeResults(left: EpisodeResult, right: EpisodeResult): number {
  return (
    compareDescending(left.scores.semantic, right.scores.semantic) ||
    compareDescending(left.scores.temporal, right.scores.temporal) ||
    compareDescending(left.scores.activity, right.scores.activity) ||
    compareDescending(left.scores.recency, right.scores.recency) ||
    compareDescending(left.score, right.score) ||
    compareAscending(left.episode.startedAt, right.episode.startedAt) ||
    compareAscending(left.episode.id, right.episode.id)
  );
}

/**
 * Compares numbers in descending order.
 *
 * @param left - Left numeric value.
 * @param right - Right numeric value.
 * @returns Sort comparator output.
 */
function compareDescending(left: number, right: number): number {
  if (left === right) {
    return 0;
  }

  return right > left ? 1 : -1;
}

/**
 * Compares strings in ascending order.
 *
 * @param left - Left string value.
 * @param right - Right string value.
 * @returns Sort comparator output.
 */
function compareAscending(left: string, right: string): number {
  return left.localeCompare(right);
}
