/**
 * Core domain types for agenr.
 * These types have zero infrastructure dependencies.
 */

// ── Entry types ──────────────────────────────────────────────────────

export const ENTRY_TYPES = ["fact", "decision", "preference", "lesson", "todo", "relationship", "event", "reflection"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const EXPIRY_LEVELS = ["core", "permanent", "temporary"] as const;
export type Expiry = (typeof EXPIRY_LEVELS)[number];

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

export interface StoreEntryInput {
  type: EntryType;
  subject: string;
  content: string;
  importance?: number;
  expiry?: Expiry;
  tags?: string[];
  source_file?: string;
  source_context?: string;
}

export interface StoreResult {
  stored: number;
  skipped: number;
  rejected: number;
}

// ── Recall types ─────────────────────────────────────────────────────

export interface RecallQuery {
  query: string;
  limit?: number;
  tags?: string[];
  since?: string;
  types?: EntryType[];
}

export interface RecallResult {
  entries: ScoredEntry[];
  total: number;
}

export interface ScoredEntry {
  entry: Entry;
  score: number;
}

// ── Ingestion types ──────────────────────────────────────────────────

export interface TranscriptMessage {
  index: number;
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

export interface TranscriptChunk {
  chunk_index: number;
  text: string;
  message_range: [number, number];
}

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
