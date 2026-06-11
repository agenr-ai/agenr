import type { ExtensionContext } from "../skeln-types.js";

import { formatErrorMessage } from "../../shared/errors.js";
import { isPluginEpisodeWriteEnabled } from "../../shared/episode-write-policy.js";
import { runGuardedPostSessionEpisodeCapture } from "../../shared/guarded-post-session-episode-capture.js";
import type { SkelnSessionShutdownEvent } from "../hooks/session-memory.js";
import type { createAgenrSkelnServices } from "../runtime.js";
import { resolveSkelnSessionEpisodeTarget, type SkelnSessionEpisodeTarget } from "./bounded-session-episode.js";
import { writeSkelnShutdownEpisode } from "./episode-writer.js";

/** Parameters for bounded shutdown episode capture on one Skeln session. */
export interface SkelnSessionShutdownEpisodeWriteParams {
  event: SkelnSessionShutdownEvent;
  context: ExtensionContext;
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>;
  /** Closed session working set whose episode id should be recorded on success. */
  workingSetId?: string;
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
      ? writeScopedSkelnShutdownEpisode(params.servicesPromise, target, params.workingSetId, params.logger).finally(() =>
          closeSkelnServicesAfterShutdown(params.servicesPromise),
        )
      : writeScopedSkelnShutdownEpisode(params.servicesPromise, target, params.workingSetId, params.logger);

  return shutdownWork.catch((error: unknown) => {
    logSkelnShutdownEpisodeFailure(error, params.logger);
  });
}

/**
 * Schedules bounded shutdown episode capture for one Skeln session.
 *
 * When Skeln supplies `deferWork`, the host waits for episode capture before
 * invalidating the ending session's extension context. Quit shutdown without
 * host deferral returns work for the lifecycle handler to await. Non-deferred
 * shutdown reasons start best-effort background capture and resolve immediately.
 *
 * @param params - Shutdown event, live host context, and shared services.
 * @returns Promise the lifecycle handler should await unless work was deferred to the host.
 */
export function scheduleSkelnSessionShutdownEpisodeWrite(params: SkelnSessionShutdownEpisodeWriteParams): Promise<void> {
  const work = buildSkelnSessionShutdownEpisodeWork(params);

  if (params.event.deferWork) {
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
  workingSetId?: string,
  logger?: Pick<Console, "info" | "warn">,
): Promise<void> {
  const services = await servicesPromise;
  if (!isPluginEpisodeWriteEnabled(services.skelnConfig.memoryPolicy)) {
    return;
  }

  await runGuardedPostSessionEpisodeCapture({
    services,
    writeEpisode: () => writeSkelnShutdownEpisode({ target, services, ...(workingSetId ? { workingSetId } : {}), logger }),
    logger: logger ?? console,
    scope: "skeln shutdown",
  });
}
