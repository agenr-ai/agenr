/**
 * Port interfaces — the boundary between core and adapters.
 *
 * Core logic depends ONLY on these interfaces, never on concrete implementations.
 * Adapters implement these interfaces to connect core to infrastructure.
 */

import type { Episode, EpisodeSource, Entry } from "./types.js";
import type { EpisodeInput, EpisodeUpsertResult, TemporalWindow } from "./episode/types.js";
import type { EntryFilters, FtsCandidate, VectorCandidate } from "./recall/types.js";

// ── Database ─────────────────────────────────────────────────────────

/**
 * Storage contract for persisting, updating, and querying knowledge entries.
 */
export interface DatabasePort {
  /** Insert a new entry with its embedding. */
  insertEntry(entry: Entry, embedding: number[], contentHash: string): Promise<string>;

  /** Drop expensive indexes and triggers before a bulk write phase begins. */
  prepareForBulkWrites(): Promise<void>;

  /** Rebuild expensive indexes and triggers after a bulk write phase ends. */
  finalizeBulkWrites(): Promise<void>;

  /** Get entries by IDs. */
  getEntries(ids: string[]): Promise<Entry[]>;

  /** Get a single entry by ID. */
  getEntry(id: string): Promise<Entry | null>;

  /** Check if content hashes already exist. Returns the set of existing hashes. */
  findExistingHashes(hashes: string[]): Promise<Set<string>>;

  /** Check if normalized content hashes already exist. Returns the set of existing hashes. */
  findExistingNormHashes(hashes: string[]): Promise<Set<string>>;

  /** Mark an entry as retired. */
  retireEntry(id: string, reason?: string): Promise<boolean>;

  /** Update entry fields (importance, expiry). */
  updateEntry(id: string, fields: { importance?: number; expiry?: string }): Promise<boolean>;

  /** Check if a file has been ingested (by path + hash). */
  getIngestLogEntry(filePath: string): Promise<{ fileHash: string; ingestedAt: string } | null>;

  /** Record that a file was ingested. */
  insertIngestLogEntry(filePath: string, fileHash: string, entryCount: number): Promise<void>;

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

  /** List non-retired episodes whose time range overlaps the requested window. */
  listEpisodesByTimeWindow(window: TemporalWindow, limit?: number): Promise<Episode[]>;

  /** Find episodes by vector similarity to a query embedding. */
  episodeVectorSearch(params: { embedding: number[]; limit: number }): Promise<Array<{ episode: Episode; vectorSim: number }>>;

  /** List non-retired episodes that still need embeddings. */
  listEpisodesWithoutEmbeddings(limit?: number): Promise<Episode[]>;

  /** Update only the embedding payload for an existing episode row. */
  updateEpisodeEmbedding(id: string, embedding: number[]): Promise<void>;
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
  vectorSearch(params: { embedding: number[]; limit: number; filters?: EntryFilters }): Promise<VectorCandidate[]>;

  /** Search FTS candidates with adapter-level filtering applied. */
  ftsSearch(params: { text: string; limit: number; filters?: EntryFilters }): Promise<FtsCandidate[]>;

  /** Hydrate fully populated entries for the final ranked result set. */
  hydrateEntries(ids: string[]): Promise<Entry[]>;

  /** Persist recall events for the returned entry set. */
  recordRecallEvents(params: { entryIds: string[]; query: string; sessionKey?: string }): Promise<void>;
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

// ── Transcript ───────────────────────────────────────────────────────

/**
 * Transcript source contract for parsing external session files into core types.
 */
export interface TranscriptPort {
  /** Parse a raw session file into a structured transcript. */
  parseFile(filePath: string, options?: { verbose?: boolean }): Promise<import("./types.js").ParsedTranscript>;
}
