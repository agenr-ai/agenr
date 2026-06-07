import { withEpisodeWriteGuard } from "../../app/dreaming/concurrency.js";
import { buildLightDreamTriggerDeps, type PluginLightDreamTriggerServices } from "./light-dream-trigger-deps.js";
import { runPostSessionLightDream, type PostSessionLightDreamLogger } from "./post-session-light-dream.js";

/**
 * Runs one guarded post-session episode write followed by the shared light dream trigger.
 *
 * @param params - Plugin services, episode write callback, logger, and light dream labels.
 * @returns Promise that resolves after episode capture and light dream evaluation finish.
 */
export async function runGuardedPostSessionEpisodeCapture(params: {
  services: PluginLightDreamTriggerServices;
  writeEpisode: () => Promise<void>;
  logger: PostSessionLightDreamLogger;
  scope: string;
  sessionContext?: string;
}): Promise<void> {
  await withEpisodeWriteGuard({ port: params.services.dreaming, dbPath: params.services.config.dbPath }, params.writeEpisode);
  await runPostSessionLightDream({
    deps: buildLightDreamTriggerDeps(params.services),
    logger: params.logger,
    scope: params.scope,
    sessionContext: params.sessionContext,
  });
}
