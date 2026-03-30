import type { Episode } from "../types.js";
import type { EpisodeMatchExplanation, EpisodeResult, TemporalWindowBounds } from "./types.js";

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * Ranking-time episode score plus the explanation tuple used for ordering.
 */
export interface ScoredEpisodeMatch {
  result: EpisodeResult;
  explanation: EpisodeMatchExplanation;
}

/**
 * Scores one episode against a resolved temporal interval.
 *
 * @param episode - Stored episode candidate.
 * @param bounds - Concrete interval bounds resolved from the query.
 * @param now - Reference clock used for recency tie-breaking.
 * @returns Ranked episode result plus the explanation tuple used for sorting.
 */
export function scoreEpisodeMatch(episode: Episode, bounds: TemporalWindowBounds, now: Date = new Date()): ScoredEpisodeMatch {
  const episodeStart = parseEpisodeDate(episode.startedAt);
  const episodeEnd = parseEpisodeDate(episode.endedAt ?? episode.startedAt);
  const overlapQuality = computeOverlapQuality(episodeStart, episodeEnd, bounds.start, bounds.end);
  const midpointProximity = computeMidpointProximity(episodeStart, episodeEnd, bounds.start, bounds.end);
  const activity = activityScore(episode.activityLevel);
  const recency = recencyScore(episodeEnd, now);
  const finalScore = overlapQuality * 0.75 + midpointProximity * 0.2 + activity * 0.04 + recency * 0.01;

  return {
    result: {
      episode,
      score: Number(finalScore.toFixed(6)),
      scores: {
        temporal: Number(overlapQuality.toFixed(6)),
        semantic: 0,
        activity: Number(activity.toFixed(6)),
        recency: Number(recency.toFixed(6)),
      },
    },
    explanation: {
      overlapQuality: Number(overlapQuality.toFixed(6)),
      midpointProximity: Number(midpointProximity.toFixed(6)),
      activity: Number(activity.toFixed(6)),
      recency: Number(recency.toFixed(6)),
    },
  };
}

/**
 * Compares two scored episode matches using the intended ranking precedence.
 *
 * @param left - Left match.
 * @param right - Right match.
 * @returns Negative when left should sort first, positive when right should sort first.
 */
export function compareEpisodeMatches(left: ScoredEpisodeMatch, right: ScoredEpisodeMatch): number {
  return (
    compareDescending(left.explanation.overlapQuality, right.explanation.overlapQuality) ||
    compareDescending(left.explanation.midpointProximity, right.explanation.midpointProximity) ||
    compareDescending(left.explanation.activity, right.explanation.activity) ||
    compareDescending(left.explanation.recency, right.explanation.recency) ||
    compareDescending(left.result.score, right.result.score) ||
    compareAscending(left.result.episode.startedAt, right.result.episode.startedAt) ||
    compareAscending(left.result.episode.id, right.result.episode.id)
  );
}

/**
 * Computes the primary interval-overlap quality using query coverage and episode precision.
 *
 * @param episodeStart - Episode start time.
 * @param episodeEnd - Episode end time.
 * @param queryStart - Query-window start time.
 * @param queryEnd - Query-window end time.
 * @returns Harmonic mean of query coverage and episode precision.
 */
export function computeOverlapQuality(episodeStart: Date, episodeEnd: Date, queryStart: Date, queryEnd: Date): number {
  const overlapStart = Math.max(episodeStart.getTime(), queryStart.getTime());
  const overlapEnd = Math.min(episodeEnd.getTime(), queryEnd.getTime());
  const overlapMs = Math.max(0, overlapEnd - overlapStart);
  if (overlapMs <= 0) {
    return 0;
  }

  const queryDurationMs = Math.max(1, queryEnd.getTime() - queryStart.getTime());
  const episodeDurationMs = Math.max(1, episodeEnd.getTime() - episodeStart.getTime());
  const coverage = overlapMs / queryDurationMs;
  const precision = overlapMs / episodeDurationMs;
  if (coverage <= 0 || precision <= 0) {
    return 0;
  }

  const beta = 0.5;
  const betaSquared = beta * beta;
  return ((1 + betaSquared) * precision * coverage) / (betaSquared * precision + coverage);
}

/**
 * Computes midpoint proximity as the secondary temporal ordering signal.
 *
 * @param episodeStart - Episode start time.
 * @param episodeEnd - Episode end time.
 * @param queryStart - Query-window start time.
 * @param queryEnd - Query-window end time.
 * @returns Normalized midpoint proximity in the inclusive 0-1 range.
 */
export function computeMidpointProximity(episodeStart: Date, episodeEnd: Date, queryStart: Date, queryEnd: Date): number {
  const episodeMidpoint = (episodeStart.getTime() + episodeEnd.getTime()) / 2;
  const queryMidpoint = (queryStart.getTime() + queryEnd.getTime()) / 2;
  const queryDurationMs = Math.max(1, queryEnd.getTime() - queryStart.getTime());
  const distanceMs = Math.abs(episodeMidpoint - queryMidpoint);
  return 1 / (1 + distanceMs / queryDurationMs);
}

/**
 * Normalizes the episode activity enum into a numeric tie-break score.
 *
 * @param value - Stored episode activity level.
 * @returns Numeric score where substantial ranks above minimal and none.
 */
export function activityScore(value: Episode["activityLevel"]): number {
  switch (value) {
    case "substantial":
      return 1;
    case "minimal":
      return 0.5;
    case "none":
      return 0;
    default:
      return 0.25;
  }
}

/**
 * Computes a light recency tie-break score from an episode end time.
 *
 * @param episodeEnd - Episode end timestamp.
 * @param now - Reference clock.
 * @returns Normalized recency score in the inclusive 0-1 range.
 */
export function recencyScore(episodeEnd: Date, now: Date): number {
  const ageMs = Math.max(0, now.getTime() - episodeEnd.getTime());
  const ageDays = ageMs / DAY_IN_MILLISECONDS;
  return 1 / (1 + ageDays / 90);
}

/**
 * Parses a stored ISO timestamp into a valid Date object.
 *
 * @param value - Stored ISO timestamp.
 * @returns Parsed Date.
 */
function parseEpisodeDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Episode timestamp is invalid: ${value}`);
  }

  return parsed;
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
