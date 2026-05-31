import { normalizeListLimit } from "../limits.js";
import type { AgenrWorkParams } from "../mutations.js";
import type { WorkingMemoryRepository } from "../repository.js";
import { createFailure, type WorkingMemoryResult } from "../results.js";
import { resolveWorkingScope } from "../scope-resolver.js";

/** Handles the list action. */
export async function handleList(params: AgenrWorkParams, repository: WorkingMemoryRepository): Promise<WorkingMemoryResult> {
  const scopeResolution = params.scope ? resolveWorkingScope(params.scope) : undefined;
  if (scopeResolution && !scopeResolution.ok) {
    return createFailure("missing_scope", scopeResolution.message);
  }

  const workingSets = await repository.listWorkingSets({
    ...(scopeResolution?.ok ? { scope: scopeResolution.scope } : {}),
    limit: normalizeListLimit(params.listLimit),
  });
  return {
    ok: true,
    action: "list",
    workingSets,
  };
}
