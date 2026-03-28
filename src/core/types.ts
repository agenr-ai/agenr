/**
 * Core domain types for agenr.
 * These types have zero infrastructure dependencies.
 */

// ── Entry types ──────────────────────────────────────────────────────

/** Ordered list of supported durable knowledge entry categories. */
const ENTRY_TYPES = ["fact", "decision", "preference", "lesson", "todo", "relationship", "event", "reflection"] as const;
/**
 * Union of all supported knowledge entry categories.
 */
export type EntryType = (typeof ENTRY_TYPES)[number];

/** Ordered list of supported recall durability levels. */
const EXPIRY_LEVELS = ["core", "permanent", "temporary"] as const;

export { ENTRY_TYPES, EXPIRY_LEVELS };

/**
 * Union of all supported recall durability levels.
 */
export type Expiry = (typeof EXPIRY_LEVELS)[number];

/**
 * Canonical stored knowledge record.
 */
export interface Entry {
  id: string;
  type: EntryType;
  subject: string;
  content: string;
  importance: number;
  expiry: Expiry;
  tags: string[];
  source_file?: string;
  source_context?: string;
  embedding?: number[];
  content_hash?: string;
  norm_content_hash?: string;
  quality_score: number;
  recall_count: number;
  last_recalled_at?: string;
  superseded_by?: string;
  cluster_id?: string;
  retired: boolean;
  retired_at?: string;
  retired_reason?: string;
  created_at: string;
  updated_at: string;
}

// ── Store types ──────────────────────────────────────────────────────

/**
 * User-supplied fields for storing a new entry.
 */
export interface StoreEntryInput {
  type: EntryType;
  subject: string;
  content: string;
  importance?: number;
  expiry?: Expiry;
  tags?: string[];
  source_file?: string;
  source_context?: string;
  created_at?: string;
}

/**
 * Summary of a store operation outcome.
 */
export interface StoreResult {
  stored: number;
  skipped: number;
  rejected: number;
}

// ── Ingestion types ──────────────────────────────────────────────────

/**
 * Normalized transcript message emitted by transcript adapters.
 */
export interface TranscriptMessage {
  index: number;
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

/**
 * Chunk of transcript text prepared for extraction or summarization.
 */
export interface TranscriptChunk {
  chunk_index: number;
  text: string;
  message_range: [number, number];
}

/**
 * Parsed transcript with normalized messages and source metadata.
 */
export interface ParsedTranscript {
  messages: TranscriptMessage[];
  metadata: {
    sessionId?: string;
    sessionLabel?: string;
    startedAt?: string;
    modelsUsed?: string[];
  };
  warnings: string[];
}
