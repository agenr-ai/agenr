import type { EpisodeDatabasePort } from "../ports.js";

import { compareEpisodeMatches, scoreEpisodeMatch } from "./scoring.js";
import { resolveTemporalWindowBounds } from "./temporal-window.js";
import type { EpisodeQuery, EpisodeResult } from "./types.js";

const DEFAULT_LIMIT = 10;
const MIN_CANDIDATE_LIMIT = 25;
const MAX_CANDIDATE_LIMIT = 100;
const CANDIDATE_MULTIPLIER = 5;

/**
 * Executes pure temporal episode recall against the episode database port.
 *
 * @param query - Episode recall query with a resolved temporal window.
 * @param database - Episode database adapter used for overlap lookup.
 * @param now - Reference clock used for recency tie-breaking.
 * @returns Ranked episodes ordered by overlap quality and temporal proximity.
 */
export async function searchEpisodes(query: EpisodeQuery, database: EpisodeDatabasePort, now: Date = new Date()): Promise<EpisodeResult[]> {
  const limit = normalizeLimit(query.limit);
  if (limit === 0) {
    return [];
  }

  const bounds = resolveTemporalWindowBounds(query.timeWindow, now);
  if (!bounds) {
    return [];
  }

  const candidates = await database.listEpisodesByTimeWindow(query.timeWindow, computeCandidateLimit(limit));
  return candidates
    .map((episode) => scoreEpisodeMatch(episode, bounds, now))
    .sort(compareEpisodeMatches)
    .slice(0, limit)
    .map((match) => match.result);
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
