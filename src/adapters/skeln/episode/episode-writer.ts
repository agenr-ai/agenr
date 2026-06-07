import { resolveEpisodeActivityEligibility, type EpisodeActivityThreshold } from "../../../app/episode-ingest/activity-threshold.js";
import { countMaterialTranscriptTurns } from "../../../core/episode/transcript-render.js";
import type { ParsedTranscript } from "../../../core/types.js";
import { HOST_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD, resolveHostShutdownEpisodeEligibility } from "../../shared/shutdown-episode-threshold.js";
import type { AgenrSkelnServices } from "../runtime.js";
import { type SkelnSessionEpisodeTarget, writeSkelnBoundedSessionEpisode } from "./bounded-session-episode.js";

const SKELN_EPISODE_GENERATOR_VERSION = "skeln-episodic-summary-v1";

/** Skeln shutdown episode activity gate from the Phase 4 lifecycle contract. */
const SKELN_PHASE4_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD: EpisodeActivityThreshold = HOST_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD;

/**
 * Best-effort bounded Skeln episode write for a completed session.
 *
 * @param params - Session target snapshot, shared services, and optional logger.
 * @returns Promise that resolves after the episode attempt is complete or skipped.
 */
export async function writeSkelnShutdownEpisode(params: {
  target: SkelnSessionEpisodeTarget;
  services: AgenrSkelnServices;
  logger?: Pick<Console, "info" | "warn">;
}): Promise<void> {
  await writeSkelnBoundedSessionEpisode({
    target: params.target,
    services: params.services,
    logger: params.logger,
    actionLabel: "skeln shutdown episode write",
    genVersion: SKELN_EPISODE_GENERATOR_VERSION,
    activityThreshold: SKELN_PHASE4_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD,
    buildSourceRef: (sessionFile) => sessionFile,
    logContext: `session=${params.target.sessionId} key=skeln:${params.target.sessionId}`,
    skipDetails: `session=${params.target.sessionId}`,
  });
}

/**
 * Best-effort bounded Skeln episode write for the full transcript snapshot before compaction.
 *
 * @param params - Session target snapshot, message count, shared services, and optional logger.
 * @returns Promise that resolves after the episode attempt is complete or skipped.
 */
export async function writeSkelnPreCompactionEpisode(params: {
  target: SkelnSessionEpisodeTarget;
  messageCount: number;
  services: AgenrSkelnServices;
  logger?: Pick<Console, "info" | "warn">;
}): Promise<void> {
  await writeSkelnBoundedSessionEpisode({
    target: params.target,
    services: params.services,
    logger: params.logger,
    actionLabel: "skeln pre-compaction episode write",
    genVersion: SKELN_EPISODE_GENERATOR_VERSION,
    buildSourceRef: (sessionFile) => sessionFile,
    sourceSessionId: `${params.target.sessionId}:pre-compaction:${params.messageCount}`,
    logContext: `session=${params.target.sessionId}:pre-compaction:${params.messageCount}`,
    skipDetails: `session=${params.target.sessionId}`,
  });
}

/** Eligibility facts returned by Skeln shutdown activity threshold evaluation. */
export type SkelnShutdownEpisodeEligibility = ReturnType<typeof resolveSkelnShutdownEpisodeEligibility>;

/**
 * Resolves phase 4 activity thresholds for optional shutdown episode writes.
 *
 * @param transcript - Parsed Skeln transcript.
 * @returns Eligibility decision and threshold facts.
 */
export function resolveSkelnShutdownEpisodeEligibility(transcript: ParsedTranscript) {
  return resolveHostShutdownEpisodeEligibility(transcript);
}
