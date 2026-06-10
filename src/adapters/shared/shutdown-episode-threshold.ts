import { resolveEpisodeActivityEligibility, type EpisodeActivityThreshold } from "../../app/episode-ingest/activity-threshold.js";
import { countMaterialTranscriptTurns } from "../../core/episode/transcript-render.js";
import type { ParsedTranscript } from "../../core/types.js";

/**
 * Phase 4 shutdown and session-end activity gate shared by Skeln and OpenClaw adapters.
 * Requires at least four material turns or ten minutes of session duration. The bar is
 * intentionally low: production corpora showed most real sessions never crossed the prior
 * eight-turn / twenty-minute gate, starving episodic memory.
 */
const HOST_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD: EpisodeActivityThreshold = {
  minMaterialTurns: 4,
  minDurationMs: 10 * 60 * 1000,
};

export { HOST_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD };

/**
 * Resolves phase 4 activity thresholds for host shutdown and session-end episode writes.
 *
 * Mirrors ingest eligibility enforced through `activityThreshold` in episode ingest options.
 * Exported for tests that assert the shared threshold contract without running ingest.
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
