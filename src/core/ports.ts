/**
 * Port interfaces — the boundary between core and adapters.
 *
 * Core logic depends ONLY on these interfaces, never on concrete implementations.
 * Adapters implement these interfaces to connect core to infrastructure.
 */

import type { Entry, RecallQuery, RecallResult, StoreEntryInput, StoreResult, TranscriptChunk } from "./types.js";

// ── Database ─────────────────────────────────────────────────────────

export interface DatabasePort {
  /** Insert a new entry with its embedding. */
  insertEntry(entry: Entry, embedding: number[], contentHash: string): Promise<string>;

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

export interface EmbeddingPort {
  /** Compute embeddings for one or more texts. */
  embed(texts: string[]): Promise<number[][]>;
}

// ── LLM ──────────────────────────────────────────────────────────────

export interface LlmPort {
  /** Generate a completion from a system prompt and user message. */
  complete(systemPrompt: string, userMessage: string): Promise<string>;

  /** Generate a structured completion (JSON output). */
  completeJson<T>(systemPrompt: string, userMessage: string): Promise<T>;
}

// ── Transcript ───────────────────────────────────────────────────────

export interface TranscriptPort {
  /** Parse a raw session file into a structured transcript. */
  parseFile(filePath: string, options?: { verbose?: boolean }): Promise<import("./types.js").ParsedTranscript>;
}
