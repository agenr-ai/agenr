import { HOST_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD } from "../../shared/shutdown-episode-threshold.js";
import type { AgenrSkelnServices } from "../runtime.js";
import { type SkelnSessionEpisodeTarget, writeSkelnBoundedSessionEpisode } from "./bounded-session-episode.js";

const SKELN_EPISODE_GENERATOR_VERSION = "skeln-episodic-summary-v1";

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
    activityThreshold: HOST_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD,
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
