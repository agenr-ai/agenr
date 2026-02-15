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

export const EXPIRY_LEVELS = ["permanent", "temporary", "session-only"] as const;

export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export type Expiry = (typeof EXPIRY_LEVELS)[number];

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
}

export interface KnowledgeEntry {
  type: KnowledgeType;
  content: string;
  subject: string;
  confidence: ConfidenceLevel;
  expiry: Expiry;
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
