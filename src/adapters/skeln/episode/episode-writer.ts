import type { ExtensionContext } from "skeln";

import { resolveEpisodeActivityEligibility, type EpisodeActivityThreshold } from "../../../app/episode-ingest/activity-threshold.js";
import { countMaterialTranscriptTurns } from "../../../core/episode/transcript-render.js";
import type { ParsedTranscript } from "../../../core/types.js";
import type { AgenrSkelnServices } from "../runtime.js";
import { writeSkelnBoundedSessionEpisode } from "./bounded-session-episode.js";

const SKELN_EPISODE_GENERATOR_VERSION = "skeln-episodic-summary-v1";

/** Skeln shutdown episode activity gate from the Phase 4 lifecycle contract. */
const SKELN_PHASE4_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD: EpisodeActivityThreshold = {
  minMaterialTurns: 8,
  minDurationMs: 20 * 60 * 1000,
};

/**
 * Best-effort bounded Skeln episode write for a completed session.
 *
 * @param params - Host context, shared services, and optional logger.
 * @returns Promise that resolves after the episode attempt is complete or skipped.
 */
export async function writeSkelnShutdownEpisode(params: {
  context: ExtensionContext;
  services: AgenrSkelnServices;
  logger?: Pick<Console, "info" | "warn">;
}): Promise<void> {
  const sessionId = String(params.context.sessionManager.getSessionId());

  await writeSkelnBoundedSessionEpisode({
    context: params.context,
    services: params.services,
    logger: params.logger,
    actionLabel: "skeln shutdown episode write",
    genVersion: SKELN_EPISODE_GENERATOR_VERSION,
    activityThreshold: SKELN_PHASE4_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD,
    buildSourceRef: (sessionFile) => sessionFile,
    logContext: `session=${sessionId} key=skeln:${sessionId}`,
    skipDetails: `session=${sessionId}`,
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
  return resolveEpisodeActivityEligibility(
    countMaterialTranscriptTurns(transcript.messages),
    transcript.metadata.startedAt,
    transcript.metadata.endedAt,
    SKELN_PHASE4_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD,
  );
}

export { resolveSessionFile } from "./bounded-session-episode.js";
