import type { ExtensionContext } from "../skeln-types.js";

import { maybeRunLightDream } from "../../../app/dreaming/background-triggers.js";
import { withEpisodeWriteGuard } from "../../../app/dreaming/concurrency.js";
import { formatErrorMessage } from "../../shared/errors.js";
import { isPluginEpisodeWriteEnabled } from "../../shared/episode-write-policy.js";
import type { SkelnSessionShutdownEvent } from "../hooks/session-memory.js";
import type { createAgenrSkelnServices } from "../runtime.js";
import { resolveSkelnSessionEpisodeTarget, type SkelnSessionEpisodeTarget } from "./bounded-session-episode.js";
import { writeSkelnShutdownEpisode } from "./episode-writer.js";

/** Parameters for bounded shutdown episode capture on one Skeln session. */
export interface SkelnSessionShutdownEpisodeWriteParams {
  event: SkelnSessionShutdownEvent;
  context: ExtensionContext;
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>;
  logger?: Pick<Console, "info" | "warn">;
}

/**
 * Builds bounded shutdown episode work from a synchronous transcript snapshot.
 *
 * Host facts are captured before Skeln invalidates the extension context.
 *
 * @param params - Shutdown event, live host context, and shared services.
 * @returns Promise for episode capture and, on quit, subsequent service close.
 */
export function buildSkelnSessionShutdownEpisodeWork(params: SkelnSessionShutdownEpisodeWriteParams): Promise<void> {
  const target = resolveSkelnSessionEpisodeTarget(params.context);
  const shutdownWork =
    params.event.reason === "quit"
      ? writeScopedSkelnShutdownEpisode(params.servicesPromise, target, params.logger).finally(() => closeSkelnServicesAfterShutdown(params.servicesPromise))
      : writeScopedSkelnShutdownEpisode(params.servicesPromise, target, params.logger);

  return shutdownWork.catch((error: unknown) => {
    logSkelnShutdownEpisodeFailure(error, params.logger);
  });
}

/**
 * Schedules bounded shutdown episode capture for one Skeln session.
 *
 * Quit shutdown without host deferral returns work for the lifecycle handler to await.
 * Quit shutdown with `deferWork` registers work with the host and resolves immediately.
 * Non-quit shutdown reasons start best-effort background capture and resolve immediately.
 *
 * @param params - Shutdown event, live host context, and shared services.
 * @returns Promise the lifecycle handler should await unless work was deferred to the host.
 */
export function scheduleSkelnSessionShutdownEpisodeWrite(params: SkelnSessionShutdownEpisodeWriteParams): Promise<void> {
  const work = buildSkelnSessionShutdownEpisodeWork(params);

  if (params.event.reason === "quit" && params.event.deferWork) {
    params.event.deferWork(work);
    return Promise.resolve();
  }

  if (params.event.reason === "quit") {
    return work;
  }

  void work;
  return Promise.resolve();
}

/** Logs one non-fatal shutdown episode failure. */
function logSkelnShutdownEpisodeFailure(error: unknown, logger?: Pick<Console, "info" | "warn">): void {
  const log = logger ?? console;
  log.warn(`[agenr] skeln shutdown episode failed: ${formatErrorMessage(error)}`);
}

/** Closes shared Skeln services during quit shutdown. */
async function closeSkelnServicesAfterShutdown(servicesPromise: ReturnType<typeof createAgenrSkelnServices>): Promise<void> {
  try {
    const services = await servicesPromise;
    await services.close();
  } catch {
    // Ignore startup failures during shutdown.
  }
}

/** Runs one bounded shutdown episode write when the feature is enabled. */
async function writeScopedSkelnShutdownEpisode(
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  target: SkelnSessionEpisodeTarget,
  logger?: Pick<Console, "info" | "warn">,
): Promise<void> {
  const services = await servicesPromise;
  if (!isPluginEpisodeWriteEnabled(services.skelnConfig.memoryPolicy)) {
    return;
  }

  await withEpisodeWriteGuard({ port: services.dreaming, dbPath: services.config.dbPath }, async () => writeSkelnShutdownEpisode({ target, services, logger }));
  await runSkelnPostSessionLightDream(services, logger);
}

/** Runs the Skeln post-session light dream trigger when configured. */
async function runSkelnPostSessionLightDream(
  services: Awaited<ReturnType<typeof createAgenrSkelnServices>>,
  logger?: Pick<Console, "info" | "warn">,
): Promise<void> {
  const log = logger ?? console;
  try {
    const result = await maybeRunLightDream(
      { trigger: "post_session" },
      {
        port: services.dreaming,
        dbPath: services.config.dbPath,
        config: services.agenrConfig,
        embedding: services.embedding,
        ...(services.claimExtraction ? { createClaimExtractionLlm: () => services.claimExtraction!.llm } : {}),
      },
    );
    if (result.status === "ran") {
      log.info(`[agenr] skeln shutdown light dream completed run=${result.result.runId}`);
    } else if (result.reason === "run_in_progress" || result.reason === "episode_write_in_progress") {
      log.info(`[agenr] skeln shutdown light dream skipped reason=${result.reason}`);
    }
  } catch (error) {
    log.warn(`[agenr] skeln shutdown light dream failed: ${formatErrorMessage(error)}`);
  }
}
