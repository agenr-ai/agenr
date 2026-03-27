import type { Entry, EntryType } from "../types.js";

/**
 * Input to the v1 recall pipeline.
 */
export interface RecallInput {
  text: string;
  limit?: number;
  threshold?: number;
  budget?: number;
  types?: EntryType[];
  tags?: string[];
  since?: string;
  until?: string;
  around?: string;
  aroundRadius?: number;
  sessionKey?: string;
}

/**
 * A single scored recall result with signal breakdown metadata.
 */
export interface RecallOutput {
  entry: Entry;
  score: number;
  scores: {
    relevance: number;
    vector: number;
    lexical: number;
    recency: number;
    importance: number;
  };
}

/**
 * Minimal entry fields needed during recall scoring before final hydration.
 */
export type RecallCandidateEntry = Pick<Entry, "id" | "subject" | "content" | "importance" | "expiry" | "created_at" | "embedding">;

/**
 * A candidate returned from vector search with ranking-time entry data.
 */
export interface VectorCandidate {
  entry: RecallCandidateEntry;
  vectorSim: number;
}

/**
 * A candidate returned from lexical FTS search with ranking-time entry data.
 *
 * BM25 rank is used for admission only and is not part of the final score.
 */
export interface FtsCandidate {
  entry: RecallCandidateEntry;
  rank: number;
  tier: "exact" | "all_tokens" | "any_tokens";
}

/**
 * Filters that the core recall pipeline can push down into adapter queries.
 */
export interface EntryFilters {
  types?: EntryType[];
  tags?: string[];
  since?: Date;
  until?: Date;
}
