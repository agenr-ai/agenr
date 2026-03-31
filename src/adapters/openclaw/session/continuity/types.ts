import type { OpenClawSessionContinuityKind } from "../session-key-parser.js";

/**
 * Resolved predecessor facts used for summary and transcript-tail injection.
 */
export interface OpenClawSessionPredecessor {
  /**
   * Previous OpenClaw session UUID.
   */
  sessionId: string;
  /**
   * Absolute path to the predecessor session transcript JSONL.
   */
  sessionFile: string;
}

/**
 * Structured continuity summary lookup facts for one predecessor session.
 */
export interface OpenClawContinuitySummaryFile {
  /**
   * Session UUID derived from the transcript filename.
   */
  sessionId: string;
  /**
   * Absolute path to the sidecar Markdown continuity summary file.
   */
  continuitySummaryPath: string;
  /**
   * Continuity summary Markdown contents.
   */
  content: string;
}

/**
 * Outcome returned after attempting to write a file-based continuity summary.
 */
export interface OpenClawContinuitySummaryWriteResult {
  /**
   * Final outcome classification for the continuity summary attempt.
   */
  status: "written" | "skipped" | "failed";
  /**
   * Stable skip or failure reason when no file was written.
   */
  reason?: string;
  /**
   * Absolute path to the written continuity summary file.
   */
  continuitySummaryPath?: string;
  /**
   * Continuity summary Markdown content when generation or reuse succeeded.
   */
  content?: string;
  /**
   * Number of cleaned transcript messages used for continuity summarization.
   */
  messageCount?: number;
  /**
   * Number of cleaned transcript characters sent to the LLM.
   */
  transcriptChars?: number;
  /**
   * Resolved continuity summary model identifier when an LLM call ran.
   */
  model?: string;
  /**
   * End-to-end LLM latency in milliseconds when a call ran.
   */
  durationMs?: number;
  /**
   * Bytes written to the sidecar continuity summary file.
   */
  bytesWritten?: number;
}

/**
 * Final predecessor-resolution strategy used for one session-start lookup.
 */
export type OpenClawContinuityResolutionStrategy = "resumed_from" | "sessions_json_scan" | "none";

/**
 * Stable `session_start.resumedFrom` lookup status captured for diagnostics.
 */
export type OpenClawContinuityResumedFromStatus =
  | "session_start_not_seen"
  | "session_start_seen_without_resumed_from"
  | "resumed_from_present_but_unresolved"
  | "resolved";

/**
 * Stable `sessions.json` fallback status captured for diagnostics.
 */
export type OpenClawContinuityFallbackStatus = "not_eligible" | "not_attempted" | "resolved" | "no_matching_sessions" | "missing_session_id";

/**
 * Stable final reason emitted when predecessor continuity resolves or fails.
 */
export type OpenClawContinuityResolutionReason =
  | "resolved"
  | "ineligible_session_kind"
  | "missing_agent_id"
  | "missing_sessions_dir"
  | "resumed_from_missing"
  | "resumed_from_not_found"
  | "sessions_json_no_matching_sessions"
  | "sessions_json_missing_session_id";

/**
 * Structured continuity-resolution diagnostics for one prompt-build session.
 */
export interface OpenClawContinuityResolutionSummary {
  /**
   * Active OpenClaw session UUID when available.
   */
  currentSessionId?: string;
  /**
   * Active OpenClaw session key when available.
   */
  currentSessionKey?: string;
  /**
   * Parsed continuity kind from the current session key.
   */
  kind: OpenClawSessionContinuityKind;
  /**
   * Stable continuity lane derived from the current session key.
   */
  stableLane: string | null;
  /**
   * Reports whether the current kind is continuity-eligible at all.
   */
  eligible: boolean;
  /**
   * Reports whether this agenr process observed and stored an OpenClaw
   * `session_start` event for the current session id before resolution ran.
   *
   * `false` means the tracker had no remembered event at resolution time. That
   * can indicate a real cold start, a process restart, or event ordering where
   * `before_prompt_build` ran before `session_start` was captured.
   */
  sessionStartObserved: boolean;
  /**
   * Session key captured from the remembered `session_start` event when present.
   */
  sessionStartSessionKey?: string;
  /**
   * Remembered predecessor UUID from `session_start.resumedFrom` when present.
   */
  resumedFrom?: string;
  /**
   * Reports whether `session_start.resumedFrom` was populated.
   */
  resumedFromPresent: boolean;
  /**
   * Structured outcome for the `resumedFrom` lookup path.
   *
   * Meanings:
   * - `session_start_not_seen`: the tracker had no remembered `session_start`
   *   event for the session id when continuity resolution ran
   * - `session_start_seen_without_resumed_from`: agenr captured `session_start`,
   *   but the event did not provide a non-empty `resumedFrom`
   * - `resumed_from_present_but_unresolved`: agenr captured a non-empty
   *   `resumedFrom`, but no predecessor transcript could be resolved from it
   * - `resolved`: the `resumedFrom` path resolved to a predecessor transcript
   */
  resumedFromStatus: OpenClawContinuityResumedFromStatus;
  /**
   * Reports whether the `resumedFrom` path resolved to a transcript.
   */
  resumedFromResolved: boolean;
  /**
   * Reports whether `sessions.json` fallback is allowed for the current kind.
   */
  fallbackEligible: boolean;
  /**
   * Reports whether `sessions.json` fallback actually ran.
   */
  fallbackAttempted: boolean;
  /**
   * Structured outcome for the `sessions.json` fallback path.
   */
  fallbackStatus: OpenClawContinuityFallbackStatus;
  /**
   * Number of `sessions.json` entries for the same agent before lane filtering.
   */
  sameAgentCandidateCount?: number;
  /**
   * Number of same-agent candidates that matched the current continuity lane.
   */
  laneMatchedCandidateCount?: number;
  /**
   * Number of lane-matched candidates that had the required fields to enter
   * fallback ranking (`sessionFile` and `updatedAt`).
   */
  rankedFallbackCandidateCount?: number;
  /**
   * Final strategy that produced the predecessor, or `none`.
   */
  strategy: OpenClawContinuityResolutionStrategy;
  /**
   * Stable final resolution reason.
   */
  reason: OpenClawContinuityResolutionReason;
  /**
   * Selected predecessor facts when resolution succeeded.
   */
  predecessor?: OpenClawSessionPredecessor;
  /**
   * Selected predecessor session key when the `sessions.json` fallback won.
   */
  predecessorSessionKey?: string;
}

/**
 * Result from predecessor lookup plus inspectable decision metadata.
 */
export interface OpenClawSessionPredecessorResolution {
  /**
   * Resolved predecessor identity when one was found.
   */
  predecessor?: OpenClawSessionPredecessor;
  /**
   * Structured diagnostics describing how predecessor lookup behaved.
   */
  resolution: OpenClawContinuityResolutionSummary;
}

/**
 * Result from resolving predecessor continuity context for prompt injection.
 */
export interface PredecessorContinuityResult {
  /**
   * Resolved predecessor identity when one was found.
   */
  predecessor?: OpenClawSessionPredecessor;
  /**
   * Structured predecessor-resolution diagnostics for inspection and logging.
   */
  resolution: OpenClawContinuityResolutionSummary;
  /**
   * Continuity summary Markdown content (empty string when unavailable).
   */
  continuitySummaryContent: string;
  /**
   * Compact recent-session transcript tail (empty string when unavailable).
   */
  recentSessionContent: string;
}
