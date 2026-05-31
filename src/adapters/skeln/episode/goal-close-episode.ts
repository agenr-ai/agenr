import type { ExtensionContext } from "skeln";

import type { EpisodeActivityThreshold } from "../../../app/episode-ingest/activity-threshold.js";
import type { WorkingMemoryResult } from "../../../app/working-memory/results.js";
import type { AgenrSkelnServices } from "../runtime.js";
import { writeSkelnBoundedSessionEpisode } from "./bounded-session-episode.js";

const SKELN_GOAL_CLOSE_EPISODE_GENERATOR_VERSION = "skeln-goal-close-episodic-v1";

/** Activity gate for goal-clear episodic promotion (lower bar than shutdown writes). */
const SKELN_GOAL_CLOSE_EPISODE_ACTIVITY_THRESHOLD: EpisodeActivityThreshold = {
  minMaterialTurns: 2,
  minDurationMs: 0,
};

/**
 * Schedules best-effort episodic promotion for pending close candidates.
 *
 * @param params - Shared services, host context, and close result.
 */
export function scheduleSkelnGoalCloseEpisodePromotion(params: {
  context: ExtensionContext;
  services: AgenrSkelnServices;
  closeResult: Extract<WorkingMemoryResult, { ok: true; action: "close" }>;
  logger?: Pick<Console, "info" | "warn">;
}): void {
  const pendingEpisodic = params.closeResult.candidates.some((candidate) => candidate.kind === "episodic" && candidate.promotionStatus === "pending");
  if (!pendingEpisodic) {
    return;
  }

  void writeSkelnGoalCloseEpisode({
    context: params.context,
    services: params.services,
    workingSetId: params.closeResult.workingSet.id,
    logger: params.logger,
  }).catch((error: unknown) => {
    const logger = params.logger ?? console;
    logger.warn(`[agenr] skeln goal close episode promotion failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/**
 * Best-effort bounded Skeln episode write triggered by `/goal clear`.
 *
 * @param params - Host context, shared services, and closed working-set id.
 * @returns Promise that resolves after the promotion attempt is complete or skipped.
 */
export async function writeSkelnGoalCloseEpisode(params: {
  context: ExtensionContext;
  services: AgenrSkelnServices;
  workingSetId: string;
  logger?: Pick<Console, "info" | "warn">;
}): Promise<void> {
  const sessionId = String(params.context.sessionManager.getSessionId());

  await writeSkelnBoundedSessionEpisode({
    context: params.context,
    services: params.services,
    logger: params.logger,
    actionLabel: "skeln goal close episode promotion",
    genVersion: SKELN_GOAL_CLOSE_EPISODE_GENERATOR_VERSION,
    activityThreshold: SKELN_GOAL_CLOSE_EPISODE_ACTIVITY_THRESHOLD,
    buildSourceRef: (sessionFile) => `${sessionFile}#working_set:${params.workingSetId}`,
    logContext: `session=${sessionId} workingSet=${params.workingSetId}`,
    skipDetails: `session=${sessionId} workingSet=${params.workingSetId}`,
  });
}
