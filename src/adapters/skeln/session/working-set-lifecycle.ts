import type { ExtensionContext } from "../skeln-types.js";

import { resolveWorkingContextGate } from "../../shared/injection/policy.js";
import { formatErrorMessage } from "../../shared/errors.js";
import type { createAgenrSkelnServices } from "../runtime.js";
import { toWorkingScopeFromSkelnSession } from "./scope.js";
import { executeAgenrSkelnWorkCommand } from "../work-command.js";
import type { SkelnSessionShutdownEvent } from "../hooks/session-memory.js";
import type { AgenrSkelnSessionScope } from "../types.js";

/**
 * Ensures the independent session working set exists at session start.
 *
 * @param servicesPromise - Lazily initialized Skeln services.
 * @param scope - Resolved session scope for the start event.
 */
export async function ensureSkelnSessionWorkingSet(servicesPromise: ReturnType<typeof createAgenrSkelnServices>, scope: AgenrSkelnSessionScope): Promise<void> {
  try {
    const services = await servicesPromise;
    const gate = resolveWorkingContextGate(services.capabilities.workingMemory);
    if (!gate.ok) {
      return;
    }

    const outcome = await services.workingMemory.ensureSessionWorkingSet({
      scope: toWorkingScopeFromSkelnSession(scope),
      actor: "runtime",
      source: "lifecycle_hook",
    });
    if (!outcome.ok) {
      console.warn(`[agenr] session working-set ensure failed: ${outcome.message}`);
    }
  } catch (error) {
    console.warn(`[agenr] session working-set ensure failed: ${formatErrorMessage(error)}`);
  }
}

/**
 * Closes the independent session working set at session shutdown.
 *
 * @param servicesPromise - Lazily initialized Skeln services.
 * @param context - Active Skeln extension context.
 * @param scope - Resolved session scope for the shutdown event.
 * @param event - Session shutdown event from Skeln.
 */
export async function closeSkelnSessionWorkingSet(
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  context: ExtensionContext,
  scope: AgenrSkelnSessionScope,
  event: SkelnSessionShutdownEvent,
): Promise<void> {
  try {
    const reason = event.reason?.trim() || "unknown";
    const outcome = await executeAgenrSkelnWorkCommand(servicesPromise, async () => scope, context, {
      action: "close",
      target: "session",
      closeReason: `Session shutdown (${reason}).`,
      closeMode: "close",
      createEpisode: false,
      actor: "runtime",
      source: "lifecycle_hook",
    });
    if (outcome.failed && outcome.details.code !== "missing_active_set") {
      console.warn(`[agenr] session working-set close failed: ${formatErrorMessage(outcome.text)}`);
    }
  } catch (error) {
    console.warn(`[agenr] session working-set close failed: ${formatErrorMessage(error)}`);
  }
}
