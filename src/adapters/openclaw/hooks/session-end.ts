import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { isOpenClawSessionEndCompaction } from "../episode/session-end-policy.js";
import { buildOpenClawSessionShutdownTriggerEvent, buildOpenClawSessionTreeTriggerEvent, shouldRouteOpenClawSessionTreeTrigger } from "./session-memory.js";
import { routeOpenClawSessionMemoryTrigger } from "./session-memory-routing.js";
import { scheduleOpenClawSessionEndEpisodeWrite } from "../episode/session-end-episode-write.js";
import type { MidSessionTracker } from "../session/state.js";
import type { AgenrOpenClawHookContext, AgenrOpenClawServices, AgenrOpenClawSessionEndEvent } from "../types.js";

/**
 * Handles OpenClaw session end: routes session-memory intake, clears mid-session
 * state, and awaits bounded session-end episode capture before the next session starts.
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

  const scopeContext = {
    sessionId: event.sessionId,
    ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
  };

  if (!isOpenClawSessionEndCompaction(event.reason)) {
    if (shouldRouteOpenClawSessionTreeTrigger(event.reason)) {
      await routeOpenClawSessionMemoryTrigger(params.servicesPromise, scopeContext, (scope) => buildOpenClawSessionTreeTriggerEvent(scope, event));
    } else {
      await routeOpenClawSessionMemoryTrigger(params.servicesPromise, scopeContext, (scope) => buildOpenClawSessionShutdownTriggerEvent(scope, event));
    }
  }

  const ctx: AgenrOpenClawHookContext = {
    sessionId: event.sessionId,
    ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
  };

  await scheduleOpenClawSessionEndEpisodeWrite({
    event,
    ctx,
    servicesPromise: params.servicesPromise,
    logger: params.logger,
  });
}
