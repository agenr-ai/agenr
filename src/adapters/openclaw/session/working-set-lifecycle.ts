import type { SessionWorkingSetLifecycleLogger } from "../../shared/session-working-set-lifecycle.js";
import { closeHostSessionWorkingSet, ensureHostSessionWorkingSet } from "../../shared/session-working-set-lifecycle.js";
import type { AgenrOpenClawServices } from "../types.js";
import type { AgenrOpenClawSessionEndEvent } from "../types.js";
import {
  formatUnknownOpenClawSessionScopeMessage,
  isUnknownOpenClawSessionScope,
  resolveOpenClawSessionScope,
  toWorkingScopeFromOpenClawSession,
  type OpenClawSessionScopeContext,
} from "./scope.js";

/**
 * Ensures the independent session working set exists at OpenClaw session start.
 *
 * @param servicesPromise - Lazily initialized OpenClaw services.
 * @param ctx - Hook context with session identity fields.
 * @param log - Optional host logger for non-fatal lifecycle failures.
 */
export async function ensureOpenClawSessionWorkingSet(
  servicesPromise: Promise<AgenrOpenClawServices>,
  ctx: OpenClawSessionScopeContext,
  log?: SessionWorkingSetLifecycleLogger,
): Promise<void> {
  const scope = resolveOpenClawSessionScope(ctx);
  if (isUnknownOpenClawSessionScope(scope)) {
    warnUnknownOpenClawScope("ensure a session working set", log);
    return;
  }

  const services = await servicesPromise;
  await ensureHostSessionWorkingSet(services.workingMemory, services.capabilities.workingMemory, toWorkingScopeFromOpenClawSession(scope), log);
}

/**
 * Closes the independent session working set at OpenClaw session end.
 *
 * @param servicesPromise - Lazily initialized OpenClaw services.
 * @param ctx - Hook context with session identity fields.
 * @param event - Session-end payload from OpenClaw.
 * @param log - Optional host logger for non-fatal lifecycle failures.
 */
export async function closeOpenClawSessionWorkingSet(
  servicesPromise: Promise<AgenrOpenClawServices>,
  ctx: OpenClawSessionScopeContext,
  event: Pick<AgenrOpenClawSessionEndEvent, "reason">,
  log?: SessionWorkingSetLifecycleLogger,
): Promise<void> {
  const scope = resolveOpenClawSessionScope(ctx);
  if (isUnknownOpenClawSessionScope(scope)) {
    warnUnknownOpenClawScope("close a session working set", log);
    return;
  }

  const services = await servicesPromise;
  await closeHostSessionWorkingSet(
    services.workingMemory,
    services.capabilities.workingMemory,
    toWorkingScopeFromOpenClawSession(scope),
    event.reason ?? "unknown",
    log,
  );
}

/** Emits the shared unknown-scope diagnostic for OpenClaw lifecycle hooks. */
function warnUnknownOpenClawScope(action: string, log?: SessionWorkingSetLifecycleLogger): void {
  const message = `[agenr] ${formatUnknownOpenClawSessionScopeMessage(action)}`;
  if (log) {
    log.warn(message);
    return;
  }

  console.warn(message);
}
