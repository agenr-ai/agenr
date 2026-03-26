/**
 * Port interfaces — the boundary between core and adapters.
 *
 * Core logic depends ONLY on these interfaces, never on concrete implementations.
 * Adapters implement these interfaces to connect core to infrastructure.
 */

import type { Entry } from "./types.js";

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

  /** Find entries by vector similarity. */
  vectorSearch(embedding: number[], limit: number): Promise<Array<{ id: string; score: number }>>;

  /** Find entries by full-text search. */
  textSearch(query: string, limit: number): Promise<Array<{ id: string; score: number }>>;

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

  /** Record a recall event. */
  recordRecallEvent(entryId: string, query: string, sessionKey?: string): Promise<void>;

  /** Check if a file has been ingested (by path + hash). */
  getIngestLogEntry(filePath: string): Promise<{ fileHash: string; ingestedAt: string } | null>;

  /** Record that a file was ingested. */
  insertIngestLogEntry(filePath: string, fileHash: string, entryCount: number): Promise<void>;

  /** Initialize the database schema. */
  init(): Promise<void>;

  /** Close the database connection. */
  close(): Promise<void>;
}

// ── Embeddings ───────────────────────────────────────────────────────

/**
 * Embedding provider contract used by core ranking and storage flows.
 */
export interface EmbeddingPort {
  /** Compute embeddings for one or more texts. */
  embed(texts: string[]): Promise<number[][]>;
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
