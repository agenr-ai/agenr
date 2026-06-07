import type { SessionWorkingSetLifecycleLogger } from "../../shared/session-working-set-lifecycle.js";
import { closeHostSessionWorkingSet, ensureHostSessionWorkingSet } from "../../shared/session-working-set-lifecycle.js";
import type { AgenrOpenClawServices } from "../types.js";
import type { AgenrOpenClawSessionEndEvent } from "../types.js";
import { resolveOpenClawSessionScope, toWorkingScopeFromOpenClawSession, type OpenClawSessionScopeContext } from "./scope.js";

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
  const services = await servicesPromise;
  const scope = resolveOpenClawSessionScope(ctx);
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
  const services = await servicesPromise;
  const scope = resolveOpenClawSessionScope(ctx);
  await closeHostSessionWorkingSet(
    services.workingMemory,
    services.capabilities.workingMemory,
    toWorkingScopeFromOpenClawSession(scope),
    event.reason ?? "unknown",
    log,
  );
}
