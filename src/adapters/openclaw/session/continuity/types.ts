/**
 * Resolved predecessor facts used for summary and transcript-tail injection.
 */
export interface OpenClawSessionPredecessor {
  /**
   * Previous OpenClaw session UUID when known.
   */
  sessionId?: string;
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
 * Result from resolving predecessor continuity context for prompt injection.
 */
export interface PredecessorContinuityResult {
  /**
   * Continuity summary Markdown content (empty string when unavailable).
   */
  continuitySummaryContent: string;
  /**
   * Compact recent-session transcript tail (empty string when unavailable).
   */
  recentSessionContent: string;
}
