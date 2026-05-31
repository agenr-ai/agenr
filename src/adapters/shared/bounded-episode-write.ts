import type { EpisodeIngestPorts, IngestEpisodeTranscriptOptions } from "../../app/episode-ingest/index.js";
import { ingestEpisodeTranscript } from "../../app/episode-ingest/index.js";
import { logBoundedEpisodeTranscriptIngestOutcome, type BoundedEpisodeIngestLogger } from "./bounded-episode-ingest-log.js";
import { EPISODE_SUMMARY_TIMEOUT_MS, EpisodeSummaryTimeoutError, raceEpisodeSummaryWithinTimeout } from "./bounded-episode-summary.js";
import { formatErrorMessage } from "./errors.js";

/** Logger surface used by bounded single-transcript episode writes. */
export type BoundedEpisodeWriteLogger = BoundedEpisodeIngestLogger & Pick<Console, "warn">;

/**
 * Runs one bounded single-transcript episode ingest with shared timeout, logging, and error handling.
 *
 * @param params - Host prelude facts plus ingest ports and options.
 * @returns Promise that resolves after the attempt is fully handled.
 */
export async function writeBoundedSingleTranscriptEpisode(params: {
  filePath: string;
  context: string;
  actionLabel: string;
  logger: BoundedEpisodeWriteLogger;
  ports: EpisodeIngestPorts;
  ingestOptions: IngestEpisodeTranscriptOptions;
  summaryDeadlineMs: number;
  fileField?: "file" | "predecessor";
  shortCountField?: "materialTurns" | "cleanedMessages";
  failureModelRef?: string;
  unexpectedFailureLevel?: "info" | "warn";
}): Promise<void> {
  const fileField = params.fileField ?? "file";
  const fileRef = `${fileField}=${params.filePath}`;

  try {
    const ingestResult = await raceEpisodeSummaryWithinTimeout(
      ingestEpisodeTranscript(params.filePath, params.ports, params.ingestOptions),
      EPISODE_SUMMARY_TIMEOUT_MS,
    );

    logBoundedEpisodeTranscriptIngestOutcome({
      logger: params.logger,
      actionLabel: params.actionLabel,
      context: params.context,
      filePath: params.filePath,
      ...(params.fileField ? { fileField: params.fileField } : {}),
      ...(params.shortCountField ? { shortCountField: params.shortCountField } : {}),
      result: ingestResult,
      ...(params.failureModelRef ? { failureModelRef: params.failureModelRef } : {}),
    });
  } catch (error) {
    if (error instanceof EpisodeSummaryTimeoutError) {
      params.logger.info(`[agenr] ${params.actionLabel} timed_out for ${params.context} ${fileRef} timeoutMs=${EPISODE_SUMMARY_TIMEOUT_MS}`);
      return;
    }

    const message = formatErrorMessage(error);
    if (params.unexpectedFailureLevel === "info") {
      params.logger.info(`[agenr] ${params.actionLabel} failed for ${params.context} ${fileRef} reason=${message}`);
      return;
    }

    params.logger.warn(`[agenr] ${params.actionLabel} failed for ${params.context} ${fileRef} reason=${message}`);
  }
}
