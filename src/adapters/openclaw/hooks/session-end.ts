import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { runOpenClawSessionEndEpisodeCapture } from "../episode/session-end-episode-write.js";
import { resolveOpenClawSessionEndPolicy } from "../session-end-policy.js";
import { buildOpenClawSessionShutdownTriggerEvent, buildOpenClawSessionTreeTriggerEvent, shouldRouteOpenClawSessionTreeTrigger } from "./session-memory.js";
import { routeOpenClawSessionMemoryTrigger } from "./session-memory-routing.js";
import type { AgenrOpenClawHookContext, AgenrOpenClawServices, AgenrOpenClawSessionEndEvent } from "../types.js";

/**
 * Handles OpenClaw session end: routes session-memory intake and awaits bounded
 * session-end episode capture before the next session starts.
 *
 * @param event - Session-end payload from OpenClaw.
 * @param params - Logger and shared services promise.
 * @returns Promise that resolves after bounded session-end episode capture finishes.
 */
export async function handleAgenrSessionEnd(
  event: AgenrOpenClawSessionEndEvent,
  params: {
    logger: PluginLogger;
    servicesPromise: Promise<AgenrOpenClawServices>;
  },
): Promise<void> {
  const scopeContext = {
    sessionId: event.sessionId,
    ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
  };

  const policy = resolveOpenClawSessionEndPolicy(event.reason);

  if (policy.routeMemoryIntake) {
    if (shouldRouteOpenClawSessionTreeTrigger(event.reason)) {
      await routeOpenClawSessionMemoryTrigger(params.servicesPromise, scopeContext, (scope) => buildOpenClawSessionTreeTriggerEvent(scope, event));
    } else {
      await routeOpenClawSessionMemoryTrigger(params.servicesPromise, scopeContext, (scope) => buildOpenClawSessionShutdownTriggerEvent(scope, event));
    }
  }

  if (!policy.captureEpisode) {
    return;
  }

  const ctx: AgenrOpenClawHookContext = {
    sessionId: event.sessionId,
    ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
  };

  await runOpenClawSessionEndEpisodeCapture({
    event,
    ctx,
    servicesPromise: params.servicesPromise,
    logger: params.logger,
  });
}
