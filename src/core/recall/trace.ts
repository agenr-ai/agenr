import type { EntryType } from "../types.js";

/**
 * Stable reason emitted when recall returns no final results.
 */
export type RecallNoResultReason = "empty_query" | "limit_zero" | "no_candidates" | "below_threshold" | "hydrate_missing";

/**
 * Active filter summary for one recall execution.
 */
export interface RecallFilterTrace {
  /** Active type filters after query normalization. */
  types: EntryType[];
  /** Active tag filters after query normalization. */
  tags: string[];
  /** Applied lower created-at bound in ISO format when present. */
  since?: string;
  /** Applied upper created-at bound in ISO format when present. */
  until?: string;
  /** Applied around-date anchor when present or inferred. */
  around?: {
    /** Whether the around-date came from explicit input or query inference. */
    source: "explicit" | "inferred";
    /** Normalized around-date anchor in ISO format. */
    anchor: string;
    /** Effective gaussian radius in days. */
    radiusDays: number;
  };
}

/**
 * Normalized ranking configuration used for one recall execution.
 */
export interface RecallRankingTrace {
  /** Effective result limit after normalization. */
  limit: number;
  /** Effective score threshold after normalization. */
  threshold: number;
  /** Effective token budget after normalization, or null when disabled. */
  budget: number | null;
  /** Stable no-result reason when recall returns no final entries. */
  noResultReason?: RecallNoResultReason;
}

/**
 * Core candidate counts observed inside one recall execution.
 */
export interface RecallCoreCandidateCountsTrace {
  /** Unique merged candidates after vector and lexical retrieval. */
  merged: number;
  /** Candidates that survived the score threshold. */
  thresholdQualified: number;
  /** Candidates retained after the token budget step. */
  budgetAccepted: number;
  /** Candidates retained after the final limit slice. */
  finalRanked: number;
  /** Entries returned after hydration and shaping. */
  returned: number;
}

/**
 * Core-only timings collected inside one recall execution.
 */
export interface RecallCoreTimingTrace {
  /** Time spent merging vector and lexical candidates. */
  mergeCandidatesMs: number;
  /** Time spent scoring and sorting merged candidates. */
  scoreCandidatesMs: number;
  /** Time spent applying the score threshold. */
  thresholdMs: number;
  /** Time spent applying the token budget. */
  budgetMs: number;
  /** Time spent shaping hydrated entries into the final output. */
  shapeResultsMs: number;
}

/**
 * Small typed execution summary emitted by the recall core.
 */
export interface RecallExecutionTraceSummary {
  /** Active filters and temporal anchors applied during execution. */
  filtering: RecallFilterTrace;
  /** Normalized ranking configuration plus any no-result reason. */
  ranking: RecallRankingTrace;
  /** Candidate counts observed inside the ranking flow. */
  candidateCounts: RecallCoreCandidateCountsTrace;
  /** Core-only timings observed inside the ranking flow. */
  timings: RecallCoreTimingTrace;
}

/**
 * Optional sink for receiving one typed recall execution summary.
 */
export interface RecallTraceSink {
  /**
   * Receives the final typed execution summary for one recall call.
   *
   * @param summary - Structured recall facts collected inside the core algorithm.
   */
  reportSummary(summary: RecallExecutionTraceSummary): void;
}

/**
 * Optional execution controls for one recall call.
 */
export interface RecallExecutionOptions {
  /** Optional sink that receives a typed execution summary. */
  trace?: RecallTraceSink;
}

const NOOP_RECALL_TRACE_SINK: RecallTraceSink = {
  reportSummary(): void {
    // Intentionally empty.
  },
};

/**
 * Returns the shared null-object recall trace sink used when no observation is requested.
 *
 * @returns Shared no-op trace sink.
 */
export function createNoopRecallTraceSink(): RecallTraceSink {
  return NOOP_RECALL_TRACE_SINK;
}
