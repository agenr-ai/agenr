import type { Episode, EpisodeActivityLevel, EpisodeSource } from "../types.js";

/**
 * Write-time episode payload before adapter-managed identity and lifecycle fields are applied.
 */
export interface EpisodeInput {
  source: EpisodeSource;
  sourceId?: string;
  sourceRef?: string;
  transcriptHash?: string;
  summaryHash?: string;
  agentId?: string;
  surface?: string;
  startedAt: string;
  endedAt?: string;
  summary: string;
  tags?: string[];
  activityLevel?: EpisodeActivityLevel;
  userId?: string;
  project?: string;
  genModel?: string;
  genVersion?: string;
  messageCount?: number;
  embedding?: number[];
}

/**
 * Calendar-aware temporal constraint used by future episode retrieval.
 */
export interface TemporalWindow {
  kind: "interval" | "anchor" | "open_start" | "open_end";
  start?: Date;
  end?: Date;
  anchor?: Date;
  radiusDays?: number;
  source: "explicit" | "inferred";
}

/**
 * Concrete interval bounds derived from a temporal window.
 */
export interface TemporalWindowBounds {
  start: Date;
  end: Date;
}

/**
 * Resolved temporal window plus stable metadata used by callers and tool output.
 */
export interface ResolvedTemporalWindow {
  window: TemporalWindow;
  bounds: TemporalWindowBounds;
  timezone: string;
  resolvedFrom: string;
}

/**
 * Episode-query shape accepted by the episodic recall pipeline.
 */
export interface EpisodeQuery {
  text: string;
  limit?: number;
  timeWindow?: TemporalWindow;
  embedding?: number[];
}

/**
 * Ranked episode result returned by future episodic recall flows.
 */
export interface EpisodeResult {
  episode: Episode;
  score: number;
  scores: {
    temporal: number;
    semantic: number;
    activity: number;
    recency: number;
  };
}

/**
 * Ranking-time facts used to explain why one episode matched a temporal query.
 */
export interface EpisodeMatchExplanation {
  overlapQuality: number;
  midpointProximity: number;
  activity: number;
  recency: number;
}

/**
 * Upsert outcome returned by episode persistence adapters.
 */
export interface EpisodeUpsertResult {
  episode: Episode;
  action: "inserted" | "updated" | "unchanged";
}
