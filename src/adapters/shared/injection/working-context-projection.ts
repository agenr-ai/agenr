import type { RuntimeCapabilityState } from "../../../app/features/capabilities.js";
import { shouldInjectWorkingContext, toWorkingContextAuditPointer, type WorkingContextAuditPointer } from "../../../app/working-memory/projection.js";
import type { WorkingMemoryService } from "../../../app/working-memory/service.js";
import type { WorkingScope } from "../../../app/working-memory/scope.js";
import { resolveWorkingContextGate } from "./policy.js";

/** Outcome from one host-neutral working-context projection resolution. */
export type WorkingContextProjectionOutcome =
  | {
      kind: "injected";
      content: string;
      workingContextAudit?: WorkingContextAuditPointer;
    }
  | {
      kind: "skipped";
      reason: string;
    }
  | {
      kind: "failed";
      message: string;
    };

/**
 * Resolves one working-context projection for host prompt injection.
 *
 * @param input - Working-memory service, capability gate, scope, and provenance.
 * @param log - Optional logger callbacks for non-fatal skips and failures.
 * @returns Injected content, a skip reason, or a failure message.
 */
export async function resolveWorkingContextProjection(
  input: {
    workingMemory: WorkingMemoryService;
    workingMemoryCapability: RuntimeCapabilityState;
    scope: WorkingScope;
    sourceRef: string;
    sessionLabel?: string;
  },
  log?: { warn: (message: string) => void; debug?: (message: string) => void },
): Promise<WorkingContextProjectionOutcome> {
  const gate = resolveWorkingContextGate(input.workingMemoryCapability);
  if (!gate.ok) {
    log?.debug?.(`[agenr] working-context skipped for ${input.sessionLabel ?? "unknown"} reason=${gate.reason}`);
    return { kind: "skipped", reason: gate.reason };
  }

  try {
    const projection = await input.workingMemory.renderProjectionBundle({
      sourceRef: input.sourceRef,
      scope: input.scope,
    });
    if (!shouldInjectWorkingContext(projection)) {
      const reason = projection.renderMode !== "full" ? "working projection stub" : "empty working projection";
      log?.debug?.(`[agenr] working-context skipped for ${input.sessionLabel ?? "unknown"} reason=${reason}`);
      return { kind: "skipped", reason };
    }

    return {
      kind: "injected",
      content: projection.content,
      workingContextAudit: toWorkingContextAuditPointer(projection),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.warn(`[agenr] working-context projection failed for ${input.sessionLabel ?? "unknown"}: ${message}`);
    return { kind: "failed", message };
  }
}
