import type { Durable, DurableKind } from "../types.js";

/**
 * Internal ranking profiles that adjust recall scoring for specific query intents.
 */
export type RecallRankingProfile = "historical_state" | "entity_attribute";

/**
 * Supported attribute buckets for precision-first entity recall.
 */
export type EntityAttributeKind = "identity" | "location" | "email" | "phone" | "address";

/**
 * Narrow structured query shape for precision-first entity-attribute recall.
 */
export interface EntityAttributeQueryShape {
  kind: "entity_attribute";
  entityText: string;
  normalizedEntity: string;
  entityTokens: string[];
  attributeKind: EntityAttributeKind;
  attributeTokens: string[];
}

/**
 * Input to the v1 recall pipeline.
 */
export interface RecallInput {
  text: string;
  limit?: number;
  threshold?: number;
  budget?: number;
  types?: DurableKind[];
  tags?: string[];
  since?: string;
  until?: string;
  around?: string;
  aroundRadius?: number;
  asOf?: string;
  sessionKey?: string;
  rankingProfile?: RecallRankingProfile;
  queryShape?: EntityAttributeQueryShape;
}

/**
 * A single scored recall result with signal breakdown metadata.
 *
 * The composite `score` is built from `relevance`, `recency`, and `importance`.
 * `relevance` is the normalized reciprocal rank fusion (RRF) score computed in
 * `src/core/recall/fusion.ts`. `vector` and `lexical` are retained as
 * evidence-only diagnostics: they explain which retrieval channels admitted
 * the candidate and let traces inspect raw similarity, but neither participates
 * in the composite score directly now that RRF owns the fused signal.
 */
export interface RecallOutput {
  entry: Durable;
  score: number;
  scores: {
    /** Fused reciprocal rank fusion score used as the composite relevance signal. */
    relevance: number;
    /** Alias of `relevance` that makes the RRF origin explicit in traces. */
    rrf: number;
    /** Evidence-only raw vector similarity score. Not part of the composite. */
    vector: number;
    /** Evidence-only raw lexical overlap score. Not part of the composite. */
    lexical: number;
    recency: number;
    importance: number;
    historicalLineage: number;
    /** Seeded neighborhood rerank boost applied after RRF and historical lineage. */
    neighborhoodBoost: number;
    claimKeyTrustPenalty: number;
    claimKeyRedundancyPenalty: number;
    /**
     * Raw cross-encoder score in the 0-1 range when the rerank stage
     * produced one for this candidate. Absent when the candidate fell
     * outside the shortlist, when the stage was disabled, or when the
     * provider failed.
     */
    crossEncoder?: number;
  };
}

/**
 * Minimal entry fields needed during recall scoring before final hydration.
 */
export type RecallCandidateDurable = Pick<
  Durable,
  | "id"
  | "subject"
  | "content"
  | "importance"
  | "expiry"
  | "created_at"
  | "embedding"
  | "superseded_by"
  | "claim_key"
  | "claim_key_status"
  | "claim_support_observed_at"
  | "valid_from"
  | "valid_to"
  | "retired"
>;

/**
 * A candidate returned from vector search with ranking-time entry data.
 */
export interface VectorCandidate {
  entry: RecallCandidateDurable;
  vectorSim: number;
}

/**
 * A candidate returned from lexical FTS search with ranking-time entry data.
 *
 * BM25 rank controls admission order inside the lexical channel. That order
 * is then folded into the reciprocal rank fusion pass in
 * `src/core/recall/fusion.ts`, so the rank value itself is not part of the
 * final composite score.
 */
export interface FtsCandidate {
  entry: RecallCandidateDurable;
  rank: number;
  tier: "exact" | "all_tokens" | "any_tokens";
}

/**
 * Candidate shape after the vector and FTS admission paths are merged into one
 * entry-id keyed pool. Vector similarity is preserved when a candidate appeared
 * in the vector channel.
 */
export interface RecallMergedCandidate {
  entry: RecallCandidateDurable;
  vectorSim?: number;
}

/**
 * Merged recall candidate pool plus the per-channel ordered rank lists that
 * reciprocal rank fusion consumes. This is the single shape produced by the
 * merge stage and consumed by valid-time filtering and scoring.
 */
export interface RecallMergeOutcome {
  merged: Map<string, RecallMergedCandidate>;
  vectorRanks: string[];
  ftsRanks: string[];
}

/**
 * Filters that the core recall pipeline can push down into adapter queries.
 */
export interface DurableFilters {
  types?: DurableKind[];
  tags?: string[];
  since?: Date;
  until?: Date;
  /**
   * When set, adapter queries exclude durables whose valid-time window does not
   * contain this instant. Core recall still applies the same filter after merge
   * as defense in depth for non-SQL retrieval paths.
   */
  validAsOf?: Date;
}
