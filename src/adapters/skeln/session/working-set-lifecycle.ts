import { closeHostSessionWorkingSet, ensureHostSessionWorkingSet } from "../../shared/session-working-set-lifecycle.js";
import type { createAgenrSkelnServices } from "../runtime.js";
import { toWorkingScopeFromSkelnSession } from "./scope.js";
import type { SkelnSessionShutdownEvent } from "../hooks/session-memory.js";
import type { AgenrSkelnSessionScope } from "../types.js";

/**
 * Ensures the independent session working set exists at session start.
 *
 * @param servicesPromise - Lazily initialized Skeln services.
 * @param scope - Resolved session scope for the start event.
 */
export async function ensureSkelnSessionWorkingSet(servicesPromise: ReturnType<typeof createAgenrSkelnServices>, scope: AgenrSkelnSessionScope): Promise<void> {
  const services = await servicesPromise;
  await ensureHostSessionWorkingSet(services.workingMemory, services.capabilities.workingMemory, toWorkingScopeFromSkelnSession(scope));
}

/**
 * Closes the independent session working set at session shutdown.
 *
 * @param servicesPromise - Lazily initialized Skeln services.
 * @param scope - Resolved session scope for the shutdown event.
 * @param event - Session shutdown event from Skeln.
 */
export async function closeSkelnSessionWorkingSet(
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  scope: AgenrSkelnSessionScope,
  event: SkelnSessionShutdownEvent,
): Promise<void> {
  const services = await servicesPromise;
  await closeHostSessionWorkingSet(
    services.workingMemory,
    services.capabilities.workingMemory,
    toWorkingScopeFromSkelnSession(scope),
    event.reason ?? "unknown",
  );
}
