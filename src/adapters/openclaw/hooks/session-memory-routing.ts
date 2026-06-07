import type { SessionMemoryTriggerEvent } from "../../../app/session-memory/types.js";
import { createSessionMemoryTriggerRouter, routeSessionMemoryTriggerSafely } from "../../shared/session-memory-routing.js";
import type { OpenClawSessionScopeContext } from "../session/scope.js";
import { resolveOpenClawSessionScope } from "../session/scope.js";
import type { AgenrOpenClawServices } from "../types.js";

/**
 * Routes one scoped session-memory trigger and logs non-fatal failures.
 *
 * @param servicesPromise - Shared OpenClaw runtime services.
 * @param ctx - Hook context with session identity fields.
 * @param buildEvent - Trigger builder for the resolved scope.
 */
export async function routeOpenClawSessionMemoryTrigger(
  servicesPromise: Promise<AgenrOpenClawServices>,
  ctx: OpenClawSessionScopeContext,
  buildEvent: (scope: ReturnType<typeof resolveOpenClawSessionScope>) => SessionMemoryTriggerEvent,
): Promise<void> {
  await routeSessionMemoryTriggerSafely({
    resolveScope: () => resolveOpenClawSessionScope(ctx),
    routeTrigger: createSessionMemoryTriggerRouter(servicesPromise, buildEvent),
  });
}
