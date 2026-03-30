import type { Episode } from "../../core/types.js";
import type { SessionMetaSource } from "./ports.js";

/**
 * Skip reasons emitted by the Stage 1 episode-ingest preflight.
 */
export type EpisodeIngestSkipReason = "skipped_short" | "skipped_active" | "skipped_exists";

/**
 * Candidate session prepared for later LLM-backed episode generation.
 */
export interface EpisodeIngestCandidate {
  /**
   * Absolute transcript path.
   */
  filePath: string;
  /**
   * Stable session identifier when present in the transcript or registry.
   */
  sessionId?: string;
  /**
   * Stable source reference for a later episode write.
   */
  sourceRef: string;
  /**
   * Stable transcript-content hash.
   */
  transcriptHash: string;
  /**
   * Session start timestamp when available.
   */
  startedAt?: string;
  /**
   * Session end timestamp when available.
   */
  endedAt?: string;
  /**
   * Cleaned-message count used for eligibility checks.
   */
  messageCount: number;
  /**
   * Owning OpenClaw agent when known.
   */
  agentId: string | null;
  /**
   * Session surface when known.
   */
  surface: string | null;
  /**
   * Metadata provenance for the resolved surface and agent values.
   */
  metadataSource: SessionMetaSource;
  /**
   * Transcript text rendered for the future summary-generation step.
   */
  renderedTranscript: string;
  /**
   * Approximate input-token estimate based on rendered transcript size.
   */
  estimatedInputTokens: number;
  /**
   * Existing stored episode when `regenerate` keeps a dedup hit in the candidate set.
   */
  existingEpisode?: Episode;
}

/**
 * Skipped transcript recorded during Stage 1 preflight.
 */
export interface EpisodeIngestSkippedSession {
  /**
   * Absolute transcript path.
   */
  filePath: string;
  /**
   * Skip reason for this transcript.
   */
  reason: EpisodeIngestSkipReason;
  /**
   * Stable session identifier when present.
   */
  sessionId?: string;
  /**
   * Stable transcript-content hash.
   */
  transcriptHash: string;
  /**
   * Cleaned-message count observed during parsing.
   */
  messageCount: number;
  /**
   * Session start timestamp when available.
   */
  startedAt?: string;
  /**
   * Session end timestamp when available.
   */
  endedAt?: string;
  /**
   * Owning OpenClaw agent when known.
   */
  agentId: string | null;
  /**
   * Session surface when known.
   */
  surface: string | null;
  /**
   * Metadata provenance for the resolved fields.
   */
  metadataSource: SessionMetaSource;
  /**
   * Existing stored episode when the skip reason is `skipped_exists`.
   */
  existingEpisode?: Episode;
}

/**
 * Invalid transcript recorded during Stage 1 preflight.
 */
export interface EpisodeIngestInvalidSession {
  /**
   * Absolute transcript path.
   */
  filePath: string;
  /**
   * Stable session identifier when present.
   */
  sessionId?: string;
  /**
   * Stable transcript-content hash.
   */
  transcriptHash: string;
  /**
   * Cleaned-message count observed during parsing.
   */
  messageCount: number;
  /**
   * Metadata provenance for the resolved fields.
   */
  metadataSource: SessionMetaSource;
}

/**
 * Aggregate Stage 1 preflight result.
 */
export interface EpisodeIngestPreflightResult {
  /**
   * Discovery-order transcript files considered by the preflight run.
   */
  files: string[];
  /**
   * Eligible transcripts prepared for future summary generation.
   */
  candidates: EpisodeIngestCandidate[];
  /**
   * Non-invalid transcripts skipped during Stage 1 eligibility checks.
   */
  skipped: EpisodeIngestSkippedSession[];
  /**
   * Invalid transcript files with no stable session identity and no messages.
   */
  invalid: EpisodeIngestInvalidSession[];
  /**
   * Aggregate counts summarizing the preflight run.
   */
  totals: {
    discovered: number;
    candidates: number;
    skipped: number;
    invalid: number;
    skippedShort: number;
    skippedActive: number;
    skippedExists: number;
  };
}

/**
 * Runtime options for Stage 1 episode-ingest preflight.
 */
export interface PrepareEpisodeIngestOptions {
  /**
   * Keep dedup hits in the candidate set and attach the existing episode.
   */
  regenerate?: boolean;
  /**
   * Reference time for active-session detection.
   */
  now?: Date;
}
