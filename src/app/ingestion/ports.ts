import type { EmbeddingPort, LlmPort, TranscriptPort, DatabasePort } from "../../core/ports.js";

/**
 * Snapshot of token and cost usage accumulated by one LLM client instance.
 */
export interface UsageStats {
  /** Number of completion calls made. */
  calls: number;
  /** Total prompt/input tokens sent. */
  inputTokens: number;
  /** Total completion/output tokens received. */
  outputTokens: number;
  /** Total cached input tokens read. */
  cacheReadTokens: number;
  /** Total cached input tokens written. */
  cacheWriteTokens: number;
  /** Total tokens consumed across all calls. */
  totalTokens: number;
  /** Total model cost in USD. */
  totalCost: number;
}

/**
 * Metadata exposed by an ingestion LLM client.
 */
export interface IngestionLlmMetadata {
  /** Context window size in tokens. */
  contextWindowTokens: number;
  /** Max output tokens exposed by the model metadata. */
  maxOutputTokens: number;
  /** Accumulated usage stats since client creation. */
  usage: UsageStats;
}

/**
 * LLM client contract used by the application-layer ingestion service.
 */
export interface IngestionLlmPort extends LlmPort {
  /** Runtime metadata used for chunk sizing and usage reporting. */
  metadata: IngestionLlmMetadata;
}

/**
 * Filesystem contract for transcript discovery and hashing.
 */
export interface IngestFilePort {
  /**
   * Discovers transcript files from a target file or directory path.
   *
   * @param targetPath - File or directory to inspect for transcript files.
   * @param options - Optional discovery flags.
   * @returns Sorted absolute transcript file paths.
   */
  discoverFiles(targetPath: string, options?: { recursive?: boolean }): Promise<string[]>;

  /**
   * Computes the stable content hash for one transcript file.
   *
   * @param filePath - Transcript file path to hash.
   * @returns SHA-256 digest for the file contents.
   */
  computeFileHash(filePath: string): Promise<string>;
}

/**
 * Ports required by the application-layer ingest orchestration service.
 */
export interface IngestPathPorts {
  /** Filesystem adapter used for transcript discovery and hashing. */
  files: IngestFilePort;
  /** Transcript adapter used to parse raw session files. */
  transcript: TranscriptPort;
  /** Database adapter used for ingest-log checks and persistence. */
  db: DatabasePort;
  /** Embedding adapter shared across dedup and store phases. */
  embedding: EmbeddingPort;
  /** Factory for per-file extraction LLM clients. */
  createExtractionLlm: () => IngestionLlmPort;
  /** Optional factory for the dedup arbitration model. */
  createDedupLlm?: () => IngestionLlmPort;
}
