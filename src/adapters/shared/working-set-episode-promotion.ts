import { recordWorkingSetEpisodicPromotion } from "../../app/working-memory/promotion.js";
import type { WorkingMemoryRepository } from "../../app/working-memory/repository.js";
import { formatErrorMessage } from "./errors.js";

/**
 * Records one emitted episode on a closed working set after a successful
 * episode write. Flips pending episodic candidates to `promoted` and stores
 * the episode id on the row. Failures are logged, never thrown.
 *
 * @param params - Repository, closed working-set id, emitted episode id,
 *   action label for log lines, and optional logger.
 */
export async function recordWorkingSetEpisodePromotionOutcome(params: {
  repository: WorkingMemoryRepository | undefined;
  workingSetId: string;
  episodeId: string;
  actionLabel: string;
  logger?: Pick<Console, "info" | "warn">;
}): Promise<void> {
  const logger = params.logger ?? console;
  const logContext = `workingSet=${params.workingSetId} episode=${params.episodeId}`;
  if (!params.repository) {
    logger.info(`[agenr] ${params.actionLabel} promotion status not recorded for ${logContext} reason=no_working_memory_repository`);
    return;
  }

  try {
    const result = await recordWorkingSetEpisodicPromotion(params.repository, {
      workingSetId: params.workingSetId,
      episodeId: params.episodeId,
      now: new Date().toISOString(),
    });
    if (!result.ok) {
      logger.warn(`[agenr] ${params.actionLabel} promotion status not recorded for ${logContext} reason=${result.reason}`);
      return;
    }

    logger.info(`[agenr] ${params.actionLabel} promotion recorded for ${logContext} changed=${result.changed}`);
  } catch (error) {
    logger.warn(`[agenr] ${params.actionLabel} promotion status not recorded for ${logContext} reason=${formatErrorMessage(error)}`);
  }
}
