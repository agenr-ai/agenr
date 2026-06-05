import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { writeOpenClawCurrentSessionEpisode } from "../episode/episode-writer.js";
import { formatErrorMessage, formatSessionContext } from "../logging.js";
import { resolveOpenClawCurrentSessionTarget } from "../session/continuity/current-session-resolver.js";
import type { MidSessionTracker } from "../session/state.js";
import type { AgenrOpenClawHookContext, AgenrOpenClawServices, AgenrOpenClawSessionEndEvent } from "../types.js";

/**
 * Handles OpenClaw session end: clears mid-session state and writes the
 * just-finished session's episode in the background.
 *
 * Writing at session end removes the predecessor-only consolidation lag so a
 * session becomes dreaming evidence before the next session starts. The write
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
  try {
    const services = await params.servicesPromise;
    if (services.pluginConfig.memoryPolicy?.sessionStart?.enabled === false) {
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

    await writeOpenClawCurrentSessionEpisode({ ctx, current: target, services, logger: params.logger });
  } catch (error) {
    params.logger.warn(`[agenr] session-end episode write failed for ${sessionContext}: ${formatErrorMessage(error)}`);
  }
}
