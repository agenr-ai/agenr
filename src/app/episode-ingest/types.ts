import type { Episode, EpisodeActivityLevel } from "../../core/types.js";
import type { EpisodeIngestModelInfo, EpisodeIngestUsageStats, SessionMetaSource } from "./ports.js";

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
  /**
   * Max files to parse in parallel during preflight. Defaults to `20`.
   */
  preflightConcurrency?: number;
  /**
   * Called after each file completes Stage 1 preflight parsing.
   *
   * @param completed - Number of files completed so far.
   * @param total - Total number of discovered files.
   */
  onPreflightProgress?: (completed: number, total: number) => void;
}

/**
 * Options for the pure Stage 2 planning pass.
 */
export interface CreateEpisodeIngestPlanOptions {
  /**
   * Optional relative or absolute cutoff for candidate selection.
   */
  recent?: string;
  /**
   * Reference time used when parsing relative cutoffs.
   */
  now?: Date;
}

/**
 * Estimated Stage 2 token and cost usage for the selected candidates.
 */
export interface EpisodeIngestEstimate {
  /**
   * Number of selected candidates included in the estimate.
   */
  candidateCount: number;
  /**
   * Estimated input tokens across all selected candidates.
   */
  inputTokens: number;
  /**
   * Estimated output tokens across all selected candidates.
   */
  outputTokens: number;
  /**
   * Total estimated tokens across input and output.
   */
  totalTokens: number;
  /**
   * Estimated USD cost using model pricing and token estimates.
   */
  estimatedCostUsd: number;
}

/**
 * Pure Stage 2 execution plan derived from Stage 1 preflight output.
 */
export interface EpisodeIngestPlan {
  /**
   * Selected candidates to execute in newest-first order.
   */
  candidates: EpisodeIngestCandidate[];
  /**
   * Model information used to estimate the run.
   */
  model: EpisodeIngestModelInfo;
  /**
   * Aggregate estimate for the selected candidates.
   */
  estimate: EpisodeIngestEstimate;
  /**
   * Optional original recent filter string.
   */
  recent?: string;
  /**
   * Resolved ISO cutoff applied to the run when `recent` is set.
   */
  recentCutoff?: string;
  /**
   * Aggregate counts describing how the plan was derived.
   */
  totals: {
    preflightCandidates: number;
    selectedCandidates: number;
    excludedByRecent: number;
    excludedUndated: number;
  };
}

/**
 * Per-session execution action emitted by Stage 2.
 */
export type EpisodeIngestExecutionAction = "written" | "updated" | "unchanged" | "failed";

/**
 * One per-session Stage 2 execution result.
 */
export interface EpisodeIngestSessionResult {
  /**
   * Final outcome for the candidate.
   */
  action: EpisodeIngestExecutionAction;
  /**
   * Absolute transcript path for the processed candidate.
   */
  filePath: string;
  /**
   * Stable session identifier when available.
   */
  sessionId?: string;
  /**
   * Activity classification returned by the summary model when generation succeeded.
   */
  activityLevel?: EpisodeActivityLevel;
  /**
   * Persisted episode identifier when a database write or no-op completed.
   */
  episodeId?: string;
  /**
   * Error message when the candidate failed.
   */
  error?: string;
  /**
   * Actual usage consumed by this candidate's summary-generation client.
   */
  usage: EpisodeIngestUsageStats;
}

/**
 * Runtime options for the Stage 2 execution pass.
 */
export interface ExecuteEpisodeIngestPlanOptions {
  /**
   * Maximum number of concurrent summary-generation workers.
   */
  concurrency: number;
  /**
   * Generator version written onto persisted episode rows.
   */
  genVersion: string;
  /**
   * Optional callback invoked when one candidate finishes execution.
   */
  onProgress?: (completed: number, total: number, result: EpisodeIngestSessionResult) => void;
}

/**
 * Aggregate result emitted after executing a Stage 2 plan.
 */
export interface EpisodeIngestExecutionResult {
  /**
   * Per-session results in the original plan order.
   */
  sessions: EpisodeIngestSessionResult[];
  /**
   * Aggregate actual usage across all session workers.
   */
  usage: EpisodeIngestUsageStats;
  /**
   * Stable model identifier used during execution.
   */
  modelRef: string;
  /**
   * Aggregate counts summarizing execution outcomes.
   */
  totals: {
    attempted: number;
    written: number;
    updated: number;
    unchanged: number;
    failed: number;
  };
}
