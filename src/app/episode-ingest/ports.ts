import type { EmbeddingPort, EpisodeDatabasePort, LlmPort, TranscriptPort } from "../../core/ports.js";

/**
 * Metadata provenance used during episode-ingest preflight.
 */
export type SessionMetaSource = "registry" | "reconstructed" | "none";

/**
 * Session metadata consumed by the episode-ingest preflight service.
 */
export interface SessionMeta {
  /**
   * Stable OpenClaw session identifier.
   */
  sessionId: string;
  /**
   * Stable source reference for later episode writes.
   */
  sourceRef: string;
  /**
   * Owning OpenClaw agent identifier when known.
   */
  agentId: string | null;
  /**
   * Surface identifier when known.
   */
  surface: string | null;
  /**
   * Provider identifier when known.
   */
  provider: string | null;
  /**
   * OpenClaw chat type when known.
   */
  chatType: string | null;
  /**
   * Provenance for the metadata.
   */
  metadataSource: SessionMetaSource;
}

/**
 * Per-million-token pricing for one summary-generation model.
 */
export interface EpisodeIngestLlmPricing {
  /**
   * USD cost per one million input tokens.
   */
  input: number;
  /**
   * USD cost per one million output tokens.
   */
  output: number;
  /**
   * USD cost per one million cache-read tokens.
   */
  cacheRead: number;
  /**
   * USD cost per one million cache-write tokens.
   */
  cacheWrite: number;
}

/**
 * Token and cost usage accumulated by one summary-generation client.
 */
export interface EpisodeIngestUsageStats {
  /**
   * Number of completion calls made.
   */
  calls: number;
  /**
   * Total prompt/input tokens sent.
   */
  inputTokens: number;
  /**
   * Total completion/output tokens received.
   */
  outputTokens: number;
  /**
   * Total cached input tokens read.
   */
  cacheReadTokens: number;
  /**
   * Total cached input tokens written.
   */
  cacheWriteTokens: number;
  /**
   * Total tokens consumed across all calls.
   */
  totalTokens: number;
  /**
   * Total model cost in USD.
   */
  totalCost: number;
}

/**
 * Metadata exposed by a Stage 2 summary-generation client.
 */
export interface EpisodeIngestLlmMetadata {
  /**
   * Stable `provider/model` identifier for display and persistence.
   */
  modelRef: string;
  /**
   * Per-million-token pricing used for Stage 2 cost estimation.
   */
  pricing: EpisodeIngestLlmPricing;
  /**
   * Accumulated usage stats since client creation.
   */
  usage: EpisodeIngestUsageStats;
}

/**
 * Model information needed by the pure Stage 2 planning pass.
 */
export type EpisodeIngestModelInfo = Pick<EpisodeIngestLlmMetadata, "modelRef" | "pricing">;

/**
 * LLM client contract used by Stage 2 episode generation.
 */
export interface EpisodeIngestLlmPort extends LlmPort {
  /**
   * Model metadata used for estimation and usage reporting.
   */
  metadata: EpisodeIngestLlmMetadata;
}

/**
 * Filesystem contract for episode-ingest transcript discovery.
 */
export interface EpisodeIngestFilePort {
  /**
   * Discovers transcript files from the provided target path.
   *
   * @param targetPath - File or directory to inspect.
   * @returns Sorted absolute transcript file paths.
   */
  discoverFiles(targetPath: string): Promise<string[]>;
}

/**
 * Registry lookup contract for active OpenClaw session metadata.
 */
export interface SessionRegistryPort {
  /**
   * Looks up one session by its stable identifier.
   *
   * @param sessionId - Stable OpenClaw session identifier.
   * @returns Matching session metadata, or `undefined`.
   */
  getSessionMeta(sessionId: string): Promise<SessionMeta | undefined>;

  /**
   * Lists all known registry-backed sessions.
   *
   * @returns Session metadata values in stable order.
   */
  listSessions(): Promise<SessionMeta[]>;
}

/**
 * Ports required by the Stage 1 episode-ingest preflight service.
 */
export interface EpisodeIngestPorts {
  /**
   * File discovery adapter used to enumerate transcript candidates.
   */
  files: EpisodeIngestFilePort;
  /**
   * Transcript parser used for normalized message extraction.
   */
  transcript: TranscriptPort;
  /**
   * Episode database used for idempotence checks.
   */
  episodes: EpisodeDatabasePort;
  /**
   * Optional embedding provider used for best-effort episode summary embeddings.
   */
  embedding?: EmbeddingPort;
  /**
   * Optional host-specific summary embedding strategy.
   *
   * When present, the app workflow uses this instead of `embedding` for
   * write-time summary embeddings.
   *
   * @param summary - Generated episode summary text.
   * @returns Embedding vector, or `undefined` when the host wants to skip it.
   */
  embedSummary?: (summary: string) => Promise<number[] | undefined>;
  /**
   * Factory for per-candidate summary-generation clients.
   */
  createSummaryLlm?: () => EpisodeIngestLlmPort;
  /**
   * Optional active-session registry used for authoritative metadata.
   */
  sessionRegistry?: SessionRegistryPort;
}
