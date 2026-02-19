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

export const IMPORTANCE_MIN = 1;
export const IMPORTANCE_MAX = 10;

export const EXPIRY_LEVELS = ["core", "permanent", "temporary"] as const;

export const SCOPE_LEVELS = ["private", "personal", "public"] as const;

export const KNOWLEDGE_PLATFORMS = ["openclaw", "claude-code", "codex"] as const;

export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export type Expiry = (typeof EXPIRY_LEVELS)[number];

export type Scope = (typeof SCOPE_LEVELS)[number];

export type KnowledgePlatform = (typeof KNOWLEDGE_PLATFORMS)[number];

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
  labelProjectMap?: Record<string, string>;
  forgetting?: {
    protect?: string[];
    scoreThreshold?: number;
    maxAgeDays?: number;
    enabled?: boolean;
  };
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
  canonical_key?: string;
  suppressedContexts?: string[];
  platform?: KnowledgePlatform;
  project?: string;
  importance: number;
  expiry: Expiry;
  scope?: Scope;
  tags: string[];
  created_at?: string;
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
  timestamp?: string;
}

export interface TranscriptChunk {
  chunk_index: number;
  message_start: number;
  message_end: number;
  text: string;
  context_hint: string;
  index?: number;
  totalChunks?: number;
  timestamp_start?: string;
  timestamp_end?: string;
}

export interface ParsedTranscript {
  file: string;
  messages: TranscriptMessage[];
  chunks: TranscriptChunk[];
  warnings: string[];
  metadata?: {
    sessionId?: string;
    platform?: string;
    startedAt?: string;
    model?: string;
    cwd?: string;
    sessionLabel?: string;
  };
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
  retired?: boolean;
  retired_at?: string;
  retired_reason?: string;
  suppressed_contexts?: string[];
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
  superseded: number;
  llm_dedup_calls: number;
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
    importance: number;
    recall: number;
    freshness: number;
    todoPenalty: number;
    fts: number;
  };
}

export interface RecallQuery {
  text?: string;
  limit?: number;
  types?: KnowledgeType[];
  tags?: string[];
  minImportance?: number;
  since?: string;
  expiry?: Expiry | Expiry[];
  scope?: Scope;
  context?: string;
  budget?: number;
  noBoost?: boolean;
  noUpdate?: boolean;
  platform?: KnowledgePlatform;
  project?: string | string[];
  excludeProject?: string | string[];
  projectStrict?: boolean;
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
  entries_superseded: number;
  dedup_llm_calls: number;
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

export interface RetirementRecord {
  id: string;
  created_at: string;
  canonical_key?: string;
  subject_pattern: string;
  match_type: "exact" | "contains";
  reason?: string;
  suppressed_contexts: string[];
}

export interface RetirementsLedger {
  version: 1;
  retirements: RetirementRecord[];
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
  raw?: boolean;
  dir?: string;
  platform?: string;
  auto?: boolean;
  onlineDedup?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  once?: boolean;
  json?: boolean;
  context?: string; // path to write CONTEXT.md after each cycle
}
