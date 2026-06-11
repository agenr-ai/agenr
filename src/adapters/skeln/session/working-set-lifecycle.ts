import type { WorkingMemoryCloseSuccess } from "../../../app/working-memory/results.js";
import { closeHostSessionWorkingSet, ensureHostSessionWorkingSet } from "../../shared/session-working-set-lifecycle.js";
import type { SessionWorkingSetLifecycleLogger } from "../../shared/session-working-set-lifecycle.js";
import { scheduleWorkingSetConsolidation } from "../../shared/working-set-consolidation.js";
import type { createAgenrSkelnServices } from "../runtime.js";
import { toWorkingScopeFromSkelnSession } from "./scope.js";
import type { SkelnSessionShutdownEvent } from "../hooks/session-memory.js";
import type { AgenrSkelnSessionScope } from "../types.js";

/**
 * Ensures the independent session working set exists at session start.
 *
 * @param servicesPromise - Lazily initialized Skeln services.
 * @param scope - Resolved session scope for the start event.
 * @param log - Optional host logger for non-fatal lifecycle failures.
 */
export async function ensureSkelnSessionWorkingSet(
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  scope: AgenrSkelnSessionScope,
  log?: SessionWorkingSetLifecycleLogger,
): Promise<void> {
  const services = await servicesPromise;
  await ensureHostSessionWorkingSet(services.workingMemory, services.capabilities.workingMemory, toWorkingScopeFromSkelnSession(scope), log);
}

/**
 * Closes the independent session working set at session shutdown.
 *
 * Schedules best-effort candidate consolidation for the closed set.
 *
 * @param servicesPromise - Lazily initialized Skeln services.
 * @param scope - Resolved session scope for the shutdown event.
 * @param event - Session shutdown event from Skeln.
 * @param log - Optional host logger for non-fatal lifecycle failures.
 * @returns Close result when a set was closed.
 */
export async function closeSkelnSessionWorkingSet(
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  scope: AgenrSkelnSessionScope,
  event: SkelnSessionShutdownEvent,
  log?: SessionWorkingSetLifecycleLogger,
): Promise<WorkingMemoryCloseSuccess | undefined> {
  const services = await servicesPromise;
  const closeResult = await closeHostSessionWorkingSet(
    services.workingMemory,
    services.capabilities.workingMemory,
    toWorkingScopeFromSkelnSession(scope),
    event.reason ?? "unknown",
    log,
  );
  if (closeResult) {
    scheduleWorkingSetConsolidation({
      services,
      workingSetId: closeResult.workingSet.id,
      candidates: closeResult.candidates,
    });
  }

  return closeResult;
}
