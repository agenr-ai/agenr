import type { Api, Model } from "@mariozechner/pi-ai";

export const KNOWLEDGE_TYPES = [
  "fact",
  "decision",
  "preference",
  "todo",
  "relationship",
  "event",
  "lesson",
] as const;

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

export const EXPIRY_LEVELS = ["core", "permanent", "temporary", "session-only"] as const;

export const SCOPE_LEVELS = ["private", "personal", "public"] as const;

export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export type Expiry = (typeof EXPIRY_LEVELS)[number];

export type Scope = (typeof SCOPE_LEVELS)[number];

export type AgenrProvider = "anthropic" | "openai" | "openai-codex";
export type AgenrAuthMethod =
  | "anthropic-oauth"
  | "anthropic-token"
  | "anthropic-api-key"
  | "openai-subscription"
  | "openai-api-key";

export interface AgenrStoredCredentials {
  anthropicApiKey?: string;
  anthropicOauthToken?: string;
  openaiApiKey?: string;
}

export interface AgenrConfig {
  auth?: AgenrAuthMethod;
  provider?: AgenrProvider;
  model?: string;
  credentials?: AgenrStoredCredentials;
  embedding?: {
    provider?: "openai";
    model?: string;
    dimensions?: number;
    apiKey?: string;
  };
  db?: {
    path?: string;
  };
}

export interface KnowledgeEntry {
  type: KnowledgeType;
  content: string;
  subject: string;
  confidence: ConfidenceLevel;
  expiry: Expiry;
  scope?: Scope;
  tags: string[];
  source: {
    file: string;
    context: string;
  };
}

export interface ExtractionStats {
  chunks: number;
  successful_chunks: number;
  failed_chunks: number;
  raw_entries: number;
  deduped_entries: number;
  warnings: string[];
}

export interface PerFileExtractionResult {
  file: string;
  entries: KnowledgeEntry[];
  stats: ExtractionStats;
}

export interface ExtractionSummary {
  files: number;
  chunks: number;
  successful_chunks: number;
  failed_chunks: number;
  raw_entries: number;
  deduped_entries: number;
  warnings: number;
}

export interface ExtractionReport {
  version: string;
  extracted_at: string;
  provider: AgenrProvider;
  model: string;
  files: Record<
    string,
    {
      entries: KnowledgeEntry[];
      stats: ExtractionStats;
    }
  >;
  summary: ExtractionSummary;
}

export interface TranscriptMessage {
  index: number;
  role: "user" | "assistant";
  text: string;
}

export interface TranscriptChunk {
  chunk_index: number;
  message_start: number;
  message_end: number;
  text: string;
  context_hint: string;
  index?: number;
  totalChunks?: number;
}

export interface ParsedTranscript {
  file: string;
  messages: TranscriptMessage[];
  chunks: TranscriptChunk[];
  warnings: string[];
}

export interface ResolvedModel {
  provider: AgenrProvider;
  modelId: string;
  model: Model<Api>;
}

export interface ResolvedCredentials {
  apiKey: string;
  source: string;
}

export interface LlmClient {
  auth: AgenrAuthMethod;
  resolvedModel: ResolvedModel;
  credentials: ResolvedCredentials;
}

export interface StoredEntry extends KnowledgeEntry {
  id: string;
  embedding?: number[];
  created_at: string;
  updated_at: string;
  last_recalled_at?: string;
  recall_count: number;
  confirmations: number;
  contradictions: number;
  superseded_by?: string;
}

export interface StoreResult {
  added: number;
  updated: number;
  skipped: number;
  relations_created: number;
  total_entries: number;
  duration_ms: number;
}

export interface RecallResult {
  entry: StoredEntry;
  score: number;
  scores: {
    vector: number;
    recency: number;
    confidence: number;
    recall: number;
    fts: number;
  };
}

export interface RecallQuery {
  text?: string;
  limit?: number;
  types?: KnowledgeType[];
  tags?: string[];
  minConfidence?: ConfidenceLevel;
  since?: string;
  expiry?: Expiry;
  scope?: Scope;
  context?: string;
  budget?: number;
  noBoost?: boolean;
  noUpdate?: boolean;
}

export interface RecallCommandResult extends RecallResult {
  category?: "core" | "active" | "preferences" | "recent";
}

export interface RecallCommandResponse {
  query: string;
  results: RecallCommandResult[];
  total: number;
  budget_used?: number;
  budget_limit?: number;
}

export interface IngestLogEntry {
  id: string;
  file_path: string;
  content_hash?: string;
  ingested_at: string;
  entries_added: number;
  entries_updated: number;
  entries_skipped: number;
  duration_ms: number;
}

export type RelationType = "supersedes" | "contradicts" | "elaborates" | "related";

export interface EntryRelation {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: RelationType;
  created_at: string;
}

export interface WatchFileState {
  filePath: string;
  byteOffset: number;
  lastRunAt: string;
  totalEntriesStored: number;
  totalRunCount: number;
}

export interface WatchState {
  version: 1;
  files: Record<string, WatchFileState>;
}

export interface WatchOptions {
  interval?: number | string;
  minChunk?: number | string;
  db?: string;
  model?: string;
  provider?: string;
  classify?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  once?: boolean;
  json?: boolean;
}
