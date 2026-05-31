import type { EpisodeTranscriptIngestResult } from "../../app/episode-ingest/types.js";
import { EPISODE_SUMMARY_TIMEOUT_MESSAGE, EPISODE_SUMMARY_TIMEOUT_MS } from "./bounded-episode-summary.js";

/** Logger surface used by bounded episode ingest helpers. */
export type BoundedEpisodeIngestLogger = Pick<Console, "info">;

/**
 * Logs one bounded single-transcript episode ingest outcome.
 *
 * @param params - Logger, stable action label, context fields, and ingest result.
 * @returns True when ingest produced a persisted episode row.
 */
export function logBoundedEpisodeTranscriptIngestOutcome(params: {
  logger: BoundedEpisodeIngestLogger;
  actionLabel: string;
  context: string;
  filePath: string;
  result: EpisodeTranscriptIngestResult;
  failureModelRef?: string;
  /** Transcript path field name used in log lines. Defaults to `file`. */
  fileField?: string;
  /** Message-count field name used for short-session skip logs. Defaults to `materialTurns`. */
  shortCountField?: "materialTurns" | "cleanedMessages";
}): boolean {
  const prefix = `[agenr] ${params.actionLabel}`;
  const fileField = params.fileField ?? "file";
  const fileRef = `${fileField}=${params.filePath}`;
  const countField = params.shortCountField ?? "materialTurns";

  if (params.result.kind === "skipped") {
    const skipped = params.result.skipped;
    if (skipped.reason === "skipped_exists") {
      params.logger.info(`${prefix} skipped for ${params.context} ${fileRef} reason=already_exists episode=${skipped.existingEpisode?.id}`);
      return false;
    }

    if (skipped.reason === "skipped_short") {
      params.logger.info(`${prefix} skipped for ${params.context} ${fileRef} reason=too_short ${countField}=${skipped.messageCount}`);
      return false;
    }

    params.logger.info(`${prefix} skipped for ${params.context} ${fileRef} reason=${skipped.reason} ${countField}=${skipped.messageCount}`);
    return false;
  }

  if (params.result.kind === "invalid") {
    params.logger.info(`${prefix} skipped for ${params.context} ${fileRef} reason=invalid_transcript ${countField}=${params.result.invalid.messageCount}`);
    return false;
  }

  const session = params.result.session;
  if (session.action === "failed") {
    if (session.error === EPISODE_SUMMARY_TIMEOUT_MESSAGE) {
      params.logger.info(`${prefix} timed_out for ${params.context} ${fileRef} timeoutMs=${EPISODE_SUMMARY_TIMEOUT_MS}`);
      return false;
    }

    if (session.error === "invalid_response" && params.failureModelRef) {
      params.logger.info(`${prefix} failed for ${params.context} ${fileRef} reason=invalid_response model=${params.failureModelRef}`);
      return false;
    }

    params.logger.info(`${prefix} failed for ${params.context} ${fileRef} reason=${session.error ?? "unknown"}`);
    return false;
  }

  params.logger.info(`${prefix} ${session.action} for ${params.context} ${fileRef} episode=${session.episodeId}`);
  return true;
}
