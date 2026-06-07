import { resolveEpisodeActivityEligibility, type EpisodeActivityThreshold } from "../../app/episode-ingest/activity-threshold.js";
import { countMaterialTranscriptTurns } from "../../core/episode/transcript-render.js";
import type { ParsedTranscript } from "../../core/types.js";

/** Phase 4 shutdown and session-end activity gate shared by Skeln and OpenClaw adapters. */
export const HOST_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD: EpisodeActivityThreshold = {
  minMaterialTurns: 8,
  minDurationMs: 20 * 60 * 1000,
};

/**
 * Resolves phase 4 activity thresholds for host shutdown and session-end episode writes.
 *
 * @param transcript - Parsed host session transcript.
 * @returns Eligibility decision and threshold facts.
 */
export function resolveHostShutdownEpisodeEligibility(transcript: ParsedTranscript) {
  return resolveEpisodeActivityEligibility(
    countMaterialTranscriptTurns(transcript.messages),
    transcript.metadata.startedAt,
    transcript.metadata.endedAt,
    HOST_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD,
  );
}
