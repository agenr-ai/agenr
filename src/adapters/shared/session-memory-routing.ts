import type { SessionMemoryTriggerResult } from "../../app/session-memory/results.js";
import type { SessionMemoryTriggerEvent } from "../../app/session-memory/types.js";

import { formatErrorMessage } from "./errors.js";

/**
 * Logs structured session-memory trigger outcomes for host lifecycle hooks.
 *
 * @param result - Router result for one lifecycle trigger.
 */
export function logSessionMemoryTriggerResult(result: SessionMemoryTriggerResult): void {
  if (result.accepted || result.reason === "feature_disabled") {
    return;
  }

  console.warn(`[agenr] session-memory trigger rejected: ${result.reason} (${result.message})`);
}

/**
 * Routes one scoped session-memory trigger and logs non-fatal failures.
 *
 * @param params - Scope resolver, trigger router, and event builder.
 */
export async function routeSessionMemoryTriggerSafely<TScope>(params: {
  resolveScope: () => TScope | Promise<TScope>;
  routeTrigger: (scope: TScope) => Promise<SessionMemoryTriggerResult>;
}): Promise<void> {
  try {
    const scope = await params.resolveScope();
    logSessionMemoryTriggerResult(await params.routeTrigger(scope));
  } catch (error) {
    console.warn(`[agenr] session-memory trigger failed: ${formatErrorMessage(error)}`);
  }
}

/**
 * Builds a session-memory trigger router bound to one shared services promise.
 *
 * @param servicesPromise - Shared runtime services for the host plugin process.
 * @param buildEvent - Trigger builder for the resolved scope.
 * @returns Router callback for one resolved scope.
 */
export function createSessionMemoryTriggerRouter<TScope>(
  servicesPromise: Promise<{ routeSessionMemoryTrigger(event: SessionMemoryTriggerEvent): Promise<SessionMemoryTriggerResult> }>,
  buildEvent: (scope: TScope) => SessionMemoryTriggerEvent,
): (scope: TScope) => Promise<SessionMemoryTriggerResult> {
  return async (scope) => {
    const services = await servicesPromise;
    return services.routeSessionMemoryTrigger(buildEvent(scope));
  };
}
