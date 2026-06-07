import type { RuntimeCapabilityState } from "../../app/features/capabilities.js";
import type { WorkingMemoryService } from "../../app/working-memory/service.js";
import type { WorkingScope } from "../../app/working-memory/scope.js";
import { formatErrorMessage } from "./errors.js";
import { resolveWorkingContextGate } from "./injection/policy.js";

/** Optional logger for non-fatal session working-set lifecycle failures. */
export interface SessionWorkingSetLifecycleLogger {
  warn: (message: string) => void;
}

/**
 * Ensures the independent session working set exists at host session start.
 *
 * @param workingMemory - Working-memory service for the active host runtime.
 * @param workingMemoryCapability - Resolved working-memory capability state.
 * @param scope - Host-normalized working scope for the session.
 * @param log - Optional logger; falls back to `console.warn` when omitted.
 */
export async function ensureHostSessionWorkingSet(
  workingMemory: WorkingMemoryService,
  workingMemoryCapability: RuntimeCapabilityState,
  scope: WorkingScope,
  log?: SessionWorkingSetLifecycleLogger,
): Promise<void> {
  try {
    const gate = resolveWorkingContextGate(workingMemoryCapability);
    if (!gate.ok) {
      return;
    }

    const outcome = await workingMemory.ensureSessionWorkingSet({
      scope,
      actor: "runtime",
      source: "lifecycle_hook",
    });
    if (!outcome.ok) {
      warnLifecycleFailure(`session working-set ensure failed: ${outcome.message}`, log);
    }
  } catch (error) {
    warnLifecycleFailure(`session working-set ensure failed: ${formatErrorMessage(error)}`, log);
  }
}

/**
 * Closes the independent session working set at host session shutdown.
 *
 * @param workingMemory - Working-memory service for the active host runtime.
 * @param workingMemoryCapability - Resolved working-memory capability state.
 * @param scope - Host-normalized working scope for the session.
 * @param shutdownReason - Host-provided shutdown reason label.
 * @param log - Optional logger; falls back to `console.warn` when omitted.
 */
export async function closeHostSessionWorkingSet(
  workingMemory: WorkingMemoryService,
  workingMemoryCapability: RuntimeCapabilityState,
  scope: WorkingScope,
  shutdownReason: string,
  log?: SessionWorkingSetLifecycleLogger,
): Promise<void> {
  try {
    const gate = resolveWorkingContextGate(workingMemoryCapability);
    if (!gate.ok) {
      return;
    }

    const reason = shutdownReason.trim() || "unknown";
    const result = await workingMemory.run({
      action: "close",
      target: "session",
      closeReason: `Session shutdown (${reason}).`,
      closeMode: "close",
      createEpisode: false,
      actor: "runtime",
      source: "lifecycle_hook",
      scope,
    });
    if (!result.ok && result.code !== "missing_active_set") {
      warnLifecycleFailure(`session working-set close failed: ${result.message}`, log);
    }
  } catch (error) {
    warnLifecycleFailure(`session working-set close failed: ${formatErrorMessage(error)}`, log);
  }
}

/** Emits one lifecycle warning through the supplied logger or stderr fallback. */
function warnLifecycleFailure(message: string, log?: SessionWorkingSetLifecycleLogger): void {
  const formatted = `[agenr] ${message}`;
  if (log) {
    log.warn(formatted);
    return;
  }

  console.warn(formatted);
}
