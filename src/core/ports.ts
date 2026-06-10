/**
 * Port interfaces — the boundary between core and adapters.
 *
 * Core logic depends ONLY on these interfaces, never on concrete implementations.
 * Adapters implement these interfaces to connect core to infrastructure.
 */

import type { DurableUpdateInput, Episode, EpisodeSource, Durable, Procedure } from "./types.js";
import type { ClaimKeyEntityPrefixStats } from "./claim-key-entity-family.js";
import type { EpisodeInput, EpisodeUpsertResult, TemporalWindow } from "./episode/types.js";
import type { DurableNeighborhoodRequest } from "./recall/neighborhood.js";
import type { DurableFilters, FtsCandidate, RecallCandidateDurable, VectorCandidate } from "./recall/types.js";

// ── Database ─────────────────────────────────────────────────────────

/**
 * One active durable matched by store-time vector similarity search.
 */
export interface SimilarActiveDurable {
  /** Matched active durable. */
  durable: Durable;
  /** Cosine similarity between the query embedding and the durable embedding. */
  similarity: number;
}

/**
 * Storage contract for persisting, updating, and querying durables.
 */
export interface DatabasePort {
  /** Insert a new durable with its embedding. */
  insertDurable(durable: Durable, embedding: number[], contentHash: string): Promise<string>;

  /** Drop expensive indexes and triggers before a bulk write phase begins. */
  prepareForBulkWrites(): Promise<void>;

  /** Rebuild expensive indexes and triggers after a bulk write phase ends. */
  finalizeBulkWrites(): Promise<void>;

  /** Get durables by IDs. */
  getDurables(ids: string[]): Promise<Durable[]>;

  /** Get a single durable by ID. */
  getDurable(id: string): Promise<Durable | null>;

  /** Check if content hashes already exist. Returns the set of existing hashes. */
  findExistingHashes(hashes: string[]): Promise<Set<string>>;

  /** Check if normalized content hashes already exist. Returns the set of existing hashes. */
  findExistingNormHashes(hashes: string[]): Promise<Set<string>>;

  /** Close one durable's valid-time window so it becomes stale for current recall. */
  closeDurableValidity(id: string, reason?: string): Promise<boolean>;

  /** Supersede an active durable, linking it to the replacement durable. */
  supersedeDurable(oldId: string, newId: string, kind?: string, reason?: string): Promise<boolean>;

  /** Find active durables with the given claim key. */
  findActiveDurablesByClaimKey(claimKey: string): Promise<Durable[]>;

  /**
   * Find active durables nearest to one embedding by vector similarity.
   *
   * Used by store-time semantic dedup. Implementations must restrict results
   * to active rows (no successor, open valid-time window) and return matches
   * ordered by descending similarity.
   */
  findSimilarActiveDurables(embedding: number[], limit: number): Promise<SimilarActiveDurable[]>;

  /** Get distinct entity prefixes from existing claim keys. */
  getDistinctClaimKeyPrefixes(): Promise<string[]>;

  /** Get bounded full claim-key examples ordered for extraction hinting. */
  getClaimKeyExamples?(limit?: number): Promise<string[]>;

  /** Get active per-prefix claim-key counts for conservative alias-family handling. */
  getClaimKeyEntityPrefixStats?(): Promise<ClaimKeyEntityPrefixStats[]>;

  /** Update durable fields (importance, expiry, and temporal metadata). */
  updateDurable(id: string, fields: DurableUpdateInput): Promise<boolean>;

  /** Check if a file has been ingested (by path + hash). */
  getIngestLogEntry(filePath: string): Promise<{ fileHash: string; ingestedAt: string } | null>;

  /** Record that a file was ingested. */
  insertIngestLogEntry(filePath: string, fileHash: string, durableCount: number): Promise<void>;

  /** Initialize the database schema. */
  init(): Promise<void>;

  /** Close the database connection. */
  close(): Promise<void>;
}

/**
 * Storage contract for persisting and querying episodic memory records.
 */
export interface EpisodeDatabasePort {
  /** Get one episode by its stable `(source, sourceId)` identity. */
  getEpisodeBySourceId(source: EpisodeSource, sourceId: string): Promise<Episode | null>;

  /** Get one episode by fallback `(source, transcriptHash)` identity. */
  getEpisodeByTranscriptHash(source: EpisodeSource, transcriptHash: string): Promise<Episode | null>;

  /** Insert or update an episode using `summaryHash` change detection. */
  upsertEpisode(input: EpisodeInput): Promise<EpisodeUpsertResult>;

  /** List active episodes whose time range overlaps the requested window. */
  listEpisodesByTimeWindow(window: TemporalWindow, limit?: number): Promise<Episode[]>;

  /** Find episodes by vector similarity to a query embedding. */
  episodeVectorSearch(params: { embedding: number[]; limit: number }): Promise<Array<{ episode: Episode; vectorSim: number }>>;

  /** List active episodes that still need embeddings. */
  listEpisodesWithoutEmbeddings(limit?: number): Promise<Episode[]>;

  /** Update only the embedding payload for an existing episode row. */
  updateEpisodeEmbedding(id: string, embedding: number[]): Promise<void>;
}

/**
 * Storage contract for persisting and querying procedural-memory revisions.
 */
export interface ProcedureDatabasePort {
  /** Insert or update one procedure revision row. */
  upsertProcedure(procedure: Procedure): Promise<Procedure>;

  /** Get one active procedure by primary key. */
  getProcedure(id: string): Promise<Procedure | null>;

  /** Hydrate active procedures by ID while preserving caller order. */
  hydrateProcedures(ids: string[]): Promise<Procedure[]>;

  /** Get the currently active procedure revision for one stable key. */
  findActiveProcedureByKey(procedureKey: string): Promise<Procedure | null>;

  /** Find procedures by vector similarity to a query embedding. */
  procedureVectorSearch(params: { embedding: number[]; limit: number }): Promise<Array<{ procedure: Procedure; vectorSim: number }>>;

  /** Find procedures by lexical search over the procedure FTS index. */
  procedureFtsSearch(params: { text: string; limit: number }): Promise<Array<{ procedure: Procedure; rank: number }>>;

  /** List active procedures that still need embeddings. */
  listProceduresWithoutEmbeddings(limit?: number): Promise<Procedure[]>;

  /** Update only the embedding payload for an existing procedure row. */
  updateProcedureEmbedding(id: string, embedding: number[]): Promise<void>;

  /** Close one active procedure revision's valid-time window. */
  closeProcedureValidity(id: string, reason?: string): Promise<boolean>;

  /** Supersede one active procedure revision with a new revision. */
  supersedeProcedure(oldId: string, newId: string, reason?: string): Promise<boolean>;

  /**
   * Replace one active procedure revision with a new revision atomically.
   *
   * Owns the active-key unique-index and `superseded_by` foreign-key ordering so
   * callers do not reimplement the close-insert-link sequence. Must run inside a
   * write transaction.
   */
  replaceProcedureRevision(existingId: string, replacement: Procedure, reason?: string): Promise<Procedure>;
}

// ── Embeddings ───────────────────────────────────────────────────────

/**
 * Embedding provider contract used by core ranking and storage flows.
 */
export interface EmbeddingPort {
  /** Compute embeddings for one or more texts. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Query-time retrieval contract used by the v1 recall pipeline.
 */
export interface RecallPorts {
  /** Compute a single embedding for a recall query string. */
  embed(text: string): Promise<number[]>;

  /** Search vector candidates with adapter-level filtering applied. */
  vectorSearch(params: { embedding: number[]; limit: number; filters?: DurableFilters }): Promise<VectorCandidate[]>;

  /** Search FTS candidates with adapter-level filtering applied. */
  ftsSearch(params: { text: string; limit: number; filters?: DurableFilters }): Promise<FtsCandidate[]>;

  /**
   * Expand a typed neighborhood of durables around the provided seed IDs.
   *
   * The adapter honors `families` exactly and treats `includeHistorical` as a
   * hard gate. This is the generalized successor of the phase 1
   * `fetchPredecessors` lookup and is used by every durable ranking profile.
   * The default profile passes `includeHistorical: false`; historical-state
   * passes `includeHistorical: true` with a wider family set.
   */
  expandNeighborhood?(request: DurableNeighborhoodRequest): Promise<RecallCandidateDurable[]>;

  /** Hydrate fully populated durables for the final ranked result set. */
  hydrateDurables(ids: string[]): Promise<Durable[]>;

  /** Persist recall events for the returned durable set. */
  recordRecallEvents(params: { durableIds: string[]; query: string; sessionKey?: string }): Promise<void>;

  /**
   * Optional cross-encoder rerank port. When present, recall calls the
   * port for the top-K shortlist after MMR diversification and before
   * thresholding. The recall pipeline fails closed on adapter errors so
   * the cross-encoder can never drop recall below its pre-rerank
   * baseline.
   */
  crossEncoder?: CrossEncoderPort;
}

// ── LLM ──────────────────────────────────────────────────────────────

/**
 * LLM provider contract for free-form and structured completions.
 */
export interface LlmPort {
  /** Generate a completion from a system prompt and user message. */
  complete(systemPrompt: string, userMessage: string): Promise<string>;

  /** Generate a structured completion (JSON output). */
  completeJson<T>(systemPrompt: string, userMessage: string): Promise<T>;
}

// ── Cross-Encoder ────────────────────────────────────────────────────

/**
 * One passage handed to the cross-encoder for relevance scoring.
 */
export interface CrossEncoderPassage {
  /** Stable identifier used to correlate scores back to the caller. */
  id: string;
  /** Free-form text representation of the passage. */
  text: string;
}

/**
 * One scored passage returned by a cross-encoder ranker.
 */
export interface CrossEncoderScore {
  /** Stable identifier matching the input passage. */
  id: string;
  /** Relevance score in the inclusive 0-1 range. */
  score: number;
}

/**
 * Cross-encoder contract used by the recall pipeline to rerank a small
 * top-K shortlist. Implementations must be safe to call concurrently and
 * should bound provider concurrency internally so recall latency does
 * not spiral under load.
 *
 * Identifiers are passed through explicitly so core recall never has to
 * correlate by list position.
 */
export interface CrossEncoderPort {
  /**
   * Score each passage against the query.
   *
   * @param query - Natural-language recall query.
   * @param passages - Passages ordered in their caller-preferred order.
   * @returns Each passage's relevance score keyed by passage ID.
   */
  rank(query: string, passages: readonly CrossEncoderPassage[]): Promise<CrossEncoderScore[]>;
}

// ── Transcript ───────────────────────────────────────────────────────

/**
 * Transcript source contract for parsing external session files into core types.
 */
export interface TranscriptPort {
  /** Parse a raw session file into a structured transcript. */
  parseFile(filePath: string, options?: { verbose?: boolean }): Promise<import("./types.js").ParsedTranscript>;
}
