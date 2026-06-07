import { resolveWorkingContextProjection } from "../../shared/injection/working-context-projection.js";
import type { WorkingContextAuditPointer } from "../../../app/working-memory/projection.js";
import { resolveOpenClawSessionScope, toWorkingScopeFromOpenClawSession, type OpenClawSessionScopeContext } from "../session/scope.js";
import type { AgenrOpenClawServices } from "../types.js";

/** Resolved working-context injection for one OpenClaw prompt build. */
export interface OpenClawWorkingContextInjection {
  /** Rendered projection text merged into prependContext when present. */
  prependContext?: string;
  /** Compact audit pointer for host diagnostics when provenance is complete. */
  workingContextAudit?: WorkingContextAuditPointer;
}

/**
 * Resolves a per-turn working-context projection for OpenClaw prompt injection.
 *
 * OpenClaw does not expose Skeln-style transient messages, so working context is
 * merged into `prependContext` alongside durable recall on each eligible turn.
 *
 * @param services - Shared OpenClaw runtime services.
 * @param ctx - Hook context with session identity fields.
 * @param sourceRef - Stable provenance pointer for audits and debugging.
 * @param log - Optional logger callback for non-fatal failures.
 * @returns Working-context injection payload when projection rendering succeeds.
 */
export async function resolveOpenClawWorkingContextInjection(
  services: AgenrOpenClawServices,
  ctx: OpenClawSessionScopeContext,
  sourceRef: string,
  log?: { warn: (message: string) => void; debug?: (message: string) => void },
): Promise<OpenClawWorkingContextInjection> {
  const scope = resolveOpenClawSessionScope(ctx);
  const outcome = await resolveWorkingContextProjection(
    {
      workingMemory: services.workingMemory,
      workingMemoryCapability: services.capabilities.workingMemory,
      scope: toWorkingScopeFromOpenClawSession(scope),
      sourceRef,
      sessionLabel: `key=${scope.sessionKey}`,
    },
    log,
  );

  if (outcome.kind !== "injected") {
    return {};
  }

  return {
    prependContext: outcome.content,
    ...(outcome.workingContextAudit ? { workingContextAudit: outcome.workingContextAudit } : {}),
  };
}
