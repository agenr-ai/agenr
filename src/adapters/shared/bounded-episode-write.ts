import type { EpisodeIngestPorts, EpisodeTranscriptIngestResult, IngestEpisodeTranscriptOptions } from "../../app/episode-ingest/index.js";
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
 * @returns Ingest result when the attempt completed within the timeout, or
 *   undefined when it timed out or failed unexpectedly.
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
}): Promise<EpisodeTranscriptIngestResult | undefined> {
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

    return ingestResult;
  } catch (error) {
    if (error instanceof EpisodeSummaryTimeoutError) {
      params.logger.info(`[agenr] ${params.actionLabel} timed_out for ${params.context} ${fileRef} timeoutMs=${EPISODE_SUMMARY_TIMEOUT_MS}`);
      return undefined;
    }

    const message = formatErrorMessage(error);
    if (params.unexpectedFailureLevel === "info") {
      params.logger.info(`[agenr] ${params.actionLabel} failed for ${params.context} ${fileRef} reason=${message}`);
      return undefined;
    }

    params.logger.warn(`[agenr] ${params.actionLabel} failed for ${params.context} ${fileRef} reason=${message}`);
    return undefined;
  }
}
