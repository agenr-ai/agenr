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
 * Optional MMR diversification controls plumbed through to episode recall.
 *
 * Unified recall enables this for broad factual and mixed intents, where
 * same-session episodes can otherwise crowd the shortlist. The hybrid
 * ranking path is the only path that applies MMR; temporal-only and
 * pure-semantic modes already have sufficient diversity.
 */
export interface EpisodeMmrOptions {
  /** Whether to diversify the hybrid shortlist with MMR. */
  enabled: boolean;
  /** Optional lambda override in the inclusive 0-1 range. */
  lambda?: number;
  /**
   * Optional minimum pool-size gate forwarded to the shared MMR helper.
   * Defaults to the core `DEFAULT_MMR_MIN_POOL_SIZE` when unset; `0`
   * disables the gate so MMR runs on every non-empty shortlist.
   */
  minPoolSize?: number;
}

/**
 * Optional cross-encoder rerank controls plumbed through to episode recall.
 *
 * Unified recall wires this whenever a cross-encoder port is available
 * and the ranking policy leaves the stage enabled. The helper itself
 * fails closed on provider errors, so a broken cross-encoder cannot
 * drop episode recall below its pre-rerank baseline.
 */
export interface EpisodeCrossEncoderOptions {
  /** Whether to run the cross-encoder rerank stage. */
  enabled: boolean;
  /** Cross-encoder adapter to invoke when the stage is enabled. */
  port: import("../ports.js").CrossEncoderPort;
  /** Optional top-K shortlist override. */
  topK?: number;
  /** Optional blend alpha override in the inclusive 0-1 range. */
  alpha?: number;
}

/**
 * Episode-query shape accepted by the episodic recall pipeline.
 */
export interface EpisodeQuery {
  text: string;
  limit?: number;
  timeWindow?: TemporalWindow;
  embedding?: number[];
  /** Optional MMR diversification knobs applied to hybrid ranking. */
  mmr?: EpisodeMmrOptions;
  /** Optional cross-encoder rerank knobs applied to hybrid ranking. */
  crossEncoder?: EpisodeCrossEncoderOptions;
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
    /**
     * Raw cross-encoder score in the 0-1 range when the rerank stage
     * produced one for this episode. Absent when the candidate fell
     * outside the shortlist, when the stage was disabled, or when the
     * provider failed.
     */
    crossEncoder?: number;
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
