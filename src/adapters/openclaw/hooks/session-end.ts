import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { maybeRunLightDream } from "../../../app/dreaming/background-triggers.js";
import { withEpisodeWriteGuard } from "../../../app/dreaming/concurrency.js";
import { writeOpenClawCurrentSessionEpisode } from "../episode/episode-writer.js";
import {
  buildOpenClawSessionShutdownTriggerEvent,
  buildOpenClawSessionTreeTriggerEvent,
  shouldRouteOpenClawSessionTreeTrigger,
  shouldSkipOpenClawSessionEndMemoryTrigger,
} from "./session-memory.js";
import { routeOpenClawSessionMemoryTrigger } from "./session-memory-routing.js";
import { isPluginEpisodeWriteEnabled } from "../../shared/episode-write-policy.js";
import { formatErrorMessage, formatSessionContext } from "../logging.js";
import { resolveOpenClawCurrentSessionTarget } from "../session/current-session-resolver.js";
import type { MidSessionTracker } from "../session/state.js";
import type { AgenrOpenClawHookContext, AgenrOpenClawServices, AgenrOpenClawSessionEndEvent } from "../types.js";

/**
 * Handles OpenClaw session end: clears mid-session state and writes the
 * just-finished session's episode in the background.
 *
 * Writing at session end lets the just-finished session become dreaming
 * evidence before the next session starts. The write
 * is best-effort and never throws into the host lifecycle.
 *
 * @param event - Session-end payload from OpenClaw.
 * @param params - Logger, shared services promise, and mid-session tracker.
 * @returns Promise that resolves after the best-effort episode attempt finishes.
 */
export async function handleAgenrSessionEnd(
  event: AgenrOpenClawSessionEndEvent,
  params: {
    logger: PluginLogger;
    servicesPromise: Promise<AgenrOpenClawServices>;
    midSessionTracker: MidSessionTracker;
  },
): Promise<void> {
  params.midSessionTracker.clear(event.sessionId, event.sessionKey);

  const sessionContext = formatSessionContext(event.sessionId, event.sessionKey);
  const scopeContext = {
    sessionId: event.sessionId,
    ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
  };

  if (!shouldSkipOpenClawSessionEndMemoryTrigger(event.reason)) {
    if (shouldRouteOpenClawSessionTreeTrigger(event.reason)) {
      await routeOpenClawSessionMemoryTrigger(params.servicesPromise, scopeContext, (scope) => buildOpenClawSessionTreeTriggerEvent(scope, event));
    } else {
      await routeOpenClawSessionMemoryTrigger(params.servicesPromise, scopeContext, (scope) => buildOpenClawSessionShutdownTriggerEvent(scope, event));
    }
  }

  try {
    const services = await params.servicesPromise;
    if (!isPluginEpisodeWriteEnabled(services.pluginConfig.memoryPolicy)) {
      params.logger.debug?.(`[agenr] session-end episode write skipped for ${sessionContext} reason=memory_policy_disabled`);
      return;
    }

    const ctx: AgenrOpenClawHookContext = {
      sessionId: event.sessionId,
      ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
    };
    const target = await resolveOpenClawCurrentSessionTarget(ctx, {
      resolveStateDir: services.openClaw.runtime.state.resolveStateDir,
      logger: params.logger,
    });
    if (!target) {
      params.logger.info(`[agenr] session-end episode write skipped for ${sessionContext} reason=no_current_session`);
      return;
    }

    await withEpisodeWriteGuard({ port: services.dreaming, dbPath: services.config.dbPath }, async () =>
      writeOpenClawCurrentSessionEpisode({ ctx, current: target, services, logger: params.logger }),
    );
    await runOpenClawPostSessionLightDream(services, params.logger, sessionContext);
  } catch (error) {
    params.logger.warn(`[agenr] session-end episode write failed for ${sessionContext}: ${formatErrorMessage(error)}`);
  }
}

/** Runs the OpenClaw post-session light dream trigger when configured. */
async function runOpenClawPostSessionLightDream(services: AgenrOpenClawServices, logger: PluginLogger, sessionContext: string): Promise<void> {
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
      logger.info(`[agenr] session-end light dream completed for ${sessionContext} run=${result.result.runId}`);
    } else if (result.reason === "run_in_progress" || result.reason === "episode_write_in_progress") {
      logger.info(`[agenr] session-end light dream skipped for ${sessionContext} reason=${result.reason}`);
    } else {
      logger.debug?.(`[agenr] session-end light dream skipped for ${sessionContext} reason=${result.reason}`);
    }
  } catch (error) {
    logger.warn(`[agenr] session-end light dream failed for ${sessionContext}: ${formatErrorMessage(error)}`);
  }
}
