import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { formatErrorMessage } from "../../shared/errors.js";
import { isPluginEpisodeWriteEnabled } from "../../shared/episode-write-policy.js";
import { runGuardedPostSessionEpisodeCapture } from "../../shared/guarded-post-session-episode-capture.js";
import { formatSessionContext } from "../logging.js";
import { resolveOpenClawCurrentSessionTarget } from "../session/current-session-resolver.js";
import { isOpenClawSessionEndCompaction } from "../session-end-policy.js";
import type { AgenrOpenClawHookContext, AgenrOpenClawServices, AgenrOpenClawSessionEndEvent } from "../types.js";
import { type OpenClawEpisodeTarget, writeOpenClawSessionEndEpisode } from "./episode-writer.js";

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
 * Awaits bounded session-end episode capture for one OpenClaw session.
 *
 * OpenClaw awaits the returned promise before starting the next session, matching
 * Skeln's transition `deferWork` wait for episode capture.
 *
 * @param params - Session-end event, hook context, shared services, and logger.
 * @returns Promise the host should await before replacing the active session.
 */
export async function runOpenClawSessionEndEpisodeCapture(params: OpenClawSessionEndEpisodeWriteParams): Promise<void> {
  if (isOpenClawSessionEndCompaction(params.event.reason)) {
    return;
  }

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

    await runGuardedPostSessionEpisodeCapture({
      services,
      writeEpisode: () =>
        writeOpenClawSessionEndEpisode({
          ctx: params.ctx,
          target,
          services,
          logger: params.logger,
        }),
      logger: params.logger,
      scope: "session-end",
      sessionContext,
    });
  } catch (error) {
    params.logger.warn(`[agenr] session-end episode write failed for ${sessionContext}: ${formatErrorMessage(error)}`);
  }
}
