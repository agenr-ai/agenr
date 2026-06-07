import type { ExtensionContext } from "../skeln-types.js";

import type { SessionMemoryTriggerEvent } from "../../../app/session-memory/types.js";
import { createSessionMemoryTriggerRouter, routeSessionMemoryTriggerSafely } from "../../shared/session-memory-routing.js";
import type { createAgenrSkelnServices } from "../runtime.js";
import type { AgenrSkelnSessionScope } from "../types.js";

/**
 * Routes one scoped session-memory trigger and logs non-fatal failures.
 *
 * @param servicesPromise - Shared Skeln runtime services.
 * @param resolveScope - Resolves the active Skeln session scope.
 * @param context - Active extension context.
 * @param buildEvent - Trigger builder for the resolved scope.
 */
export async function routeSkelnSessionMemoryTrigger(
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
  context: ExtensionContext,
  buildEvent: (scope: AgenrSkelnSessionScope) => SessionMemoryTriggerEvent,
): Promise<void> {
  await routeSessionMemoryTriggerSafely({
    resolveScope: () => resolveScope(context),
    routeTrigger: createSessionMemoryTriggerRouter(servicesPromise, buildEvent),
  });
}
