import type { ClaimSlotPolicyConfig } from "../claim-slot-policy.js";
import type { EntryType } from "../types.js";

/**
 * Stable reason emitted when recall returns no final results.
 */
export type RecallNoResultReason =
  | "empty_query"
  | "limit_zero"
  | "no_candidates"
  | "below_threshold"
  | "hydrate_missing"
  | "degraded_no_candidates"
  | "degraded_below_threshold";

/**
 * Stable degraded-mode causes observed during one recall execution.
 */
export type RecallDegradedReason = "query_embedding_failed" | "vector_search_failed";

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
  /** Applied as-of reference point when present. */
  asOf?: {
    /** As-of anchor supplied by the caller in ISO format. */
    anchor: string;
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
 * Degraded-mode facts observed during one recall execution.
 */
export interface RecallDegradedTrace {
  /** Whether recall had to fall back to lexical-only ranking. */
  active: boolean;
  /** Stable degraded-mode causes observed during the run. */
  reasons: RecallDegradedReason[];
  /** Whether the final ranking ran without vector candidates. */
  lexicalOnly: boolean;
  /** User-facing notices that explain the degraded path. */
  notices: string[];
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
 * Claim-key shaping facts observed during one recall execution.
 */
export interface RecallClaimKeyTrace {
  /** Historical candidates that received a claim-key lineage bonus. */
  historicalBoosted: number;
  /** Historical same-slot candidates whose tentative lineage was suppressed. */
  tentativeLineageSuppressed: number;
  /** Current-state candidates down-ranked because a trusted same-slot peer exists. */
  trustPenalized: number;
  /** Current-state trusted same-slot duplicates down-ranked for diversity. */
  redundancyPenalized: number;
}

/**
 * MMR diversification facts observed during one recall execution.
 */
export interface RecallMmrTrace {
  /** Whether MMR actually reordered the shortlist for this execution. */
  applied: boolean;
  /** Effective lambda used when MMR ran, or the configured default when skipped. */
  lambda: number;
  /**
   * Candidates that MMR identified as near duplicates and demoted below
   * their input position. A zero count means no redundancy was observed.
   */
  droppedDuplicateCount: number;
  /** Candidate IDs whose position shifted relative to the input order. */
  reorderedIds: string[];
}

/**
 * Neighborhood expansion and seeded rerank facts observed during one recall execution.
 */
export interface RecallNeighborhoodTrace {
  /** Whether the adapter was asked to expand a lineage neighborhood. */
  expansionRequested: boolean;
  /** Whether the adapter exposes the expandNeighborhood port at all. */
  expansionAvailable: boolean;
  /** Family kinds requested from the adapter for this execution. */
  familiesRequested: string[];
  /** Whether retired rows were allowed into the expansion. */
  includeRetired: boolean;
  /** Seed entry IDs chosen before the adapter expansion. */
  seedIds: string[];
  /** Unique candidates returned by the adapter expansion. */
  expansionCandidates: number;
  /** Strong seed IDs chosen for seededRerank. */
  strongSeedIds: string[];
  /** Candidate IDs that received a seededRerank boost. */
  rerankBoostedIds: string[];
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
  /** Claim-key lineage and diversity shaping facts observed during ranking. */
  claimKey: RecallClaimKeyTrace;
  /** Neighborhood expansion and seeded rerank facts observed during ranking. */
  neighborhood: RecallNeighborhoodTrace;
  /** MMR diversification facts observed during ranking. */
  mmr: RecallMmrTrace;
  /** Whether recall had to degrade into lexical-only ranking. */
  degraded: RecallDegradedTrace;
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
 * Tunable ranking policy applied to one recall execution.
 *
 * Every field is optional so callers can opt into individual stages
 * without having to restate the full policy. Evals that A/B one stage
 * at a time rely on the per-stage kill switches here.
 */
export interface RecallRankingPolicy {
  /**
   * Whether to apply the MMR diversification stage. Defaults to
   * `"enabled"` so the default pipeline gets diversity out of the box.
   */
  mmr?: "enabled" | "disabled";
  /** Effective MMR lambda in the inclusive 0-1 range. */
  mmrLambda?: number;
}

/**
 * Optional execution controls for one recall call.
 */
export interface RecallExecutionOptions {
  /** Optional sink that receives a typed execution summary. */
  trace?: RecallTraceSink;
  /** Optional runtime slot-policy overrides used during claim-aware ranking. */
  slotPolicyConfig?: ClaimSlotPolicyConfig;
  /** Optional ranking policy overrides, including MMR toggles. */
  rankingPolicy?: RecallRankingPolicy;
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
