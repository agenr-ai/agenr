import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { maybeRunLightDream } from "../../../app/dreaming/background-triggers.js";
import { withEpisodeWriteGuard } from "../../../app/dreaming/concurrency.js";
import { formatErrorMessage } from "../../shared/errors.js";
import { isPluginEpisodeWriteEnabled } from "../../shared/episode-write-policy.js";
import { formatSessionContext } from "../logging.js";
import { resolveOpenClawCurrentSessionTarget } from "../session/current-session-resolver.js";
import type { AgenrOpenClawHookContext, AgenrOpenClawServices, AgenrOpenClawSessionEndEvent } from "../types.js";
import { type OpenClawEpisodeTarget, writeOpenClawSessionEndEpisode } from "./episode-writer.js";
import { shouldSkipOpenClawSessionEndEpisodeWrite } from "../hooks/session-memory.js";

/** Parameters for bounded session-end episode capture on one OpenClaw session. */
export interface OpenClawSessionEndEpisodeWriteParams {
  event: AgenrOpenClawSessionEndEvent;
  ctx: AgenrOpenClawHookContext;
  servicesPromise: Promise<AgenrOpenClawServices>;
  logger: PluginLogger;
}

/**
 * Captures one OpenClaw session transcript target from synchronous session-end facts.
 *
 * @param event - OpenClaw session-end payload.
 * @returns Session id and transcript path when the host supplied them.
 */
export function resolveOpenClawSessionEndEpisodeTarget(event: AgenrOpenClawSessionEndEvent): OpenClawEpisodeTarget | undefined {
  const sessionId = event.sessionId.trim();
  const sessionFile = event.sessionFile?.trim();
  if (!sessionId || !sessionFile) {
    return undefined;
  }

  return { sessionId, sessionFile };
}

/**
 * Builds bounded session-end episode work from host session-end facts.
 *
 * @param params - Session-end event, hook context, shared services, and logger.
 * @returns Promise for episode capture and post-session light dream.
 */
export async function buildOpenClawSessionEndEpisodeWork(params: OpenClawSessionEndEpisodeWriteParams): Promise<void> {
  const sessionContext = formatSessionContext(params.event.sessionId, params.event.sessionKey);
  const syncTarget = resolveOpenClawSessionEndEpisodeTarget(params.event);

  try {
    const services = await params.servicesPromise;
    if (!isPluginEpisodeWriteEnabled(services.pluginConfig.memoryPolicy)) {
      params.logger.debug?.(`[agenr] session-end episode write skipped for ${sessionContext} reason=memory_policy_disabled`);
      return;
    }

    const target =
      syncTarget ??
      (await resolveOpenClawCurrentSessionTarget(params.ctx, {
        resolveStateDir: services.openClaw.runtime.state.resolveStateDir,
        logger: params.logger,
      }));
    if (!target) {
      params.logger.info(`[agenr] session-end episode write skipped for ${sessionContext} reason=no_current_session`);
      return;
    }

    await withEpisodeWriteGuard({ port: services.dreaming, dbPath: services.config.dbPath }, async () =>
      writeOpenClawSessionEndEpisode({
        ctx: params.ctx,
        target,
        services,
        logger: params.logger,
      }),
    );
    await runOpenClawPostSessionLightDream(services, params.logger, sessionContext);
  } catch (error) {
    params.logger.warn(`[agenr] session-end episode write failed for ${sessionContext}: ${formatErrorMessage(error)}`);
  }
}

/**
 * Schedules bounded session-end episode capture for one OpenClaw session.
 *
 * OpenClaw awaits the returned promise before starting the next session, matching
 * Skeln's transition `deferWork` wait for episode capture.
 *
 * @param params - Session-end event, hook context, shared services, and logger.
 * @returns Promise the host should await before replacing the active session.
 */
export function scheduleOpenClawSessionEndEpisodeWrite(params: OpenClawSessionEndEpisodeWriteParams): Promise<void> {
  if (shouldSkipOpenClawSessionEndEpisodeWrite(params.event.reason)) {
    return Promise.resolve();
  }

  return buildOpenClawSessionEndEpisodeWork(params);
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
