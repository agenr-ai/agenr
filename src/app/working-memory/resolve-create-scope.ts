import { lookupCurrentWorkingSets } from "./find-current-set.js";
import type { AgenrWorkParams } from "./mutations.js";
import type { WorkingMemoryRepository } from "./repository.js";
import { createFailure, type WorkingMemoryFailure } from "./results.js";
import type { ResolvedWorkingScope } from "./scope.js";

/** Successful create-scope resolution. */
export interface CreateScopeResolution {
  /** Success discriminator. */
  ok: true;
  /** Canonical scope for the new working set. */
  scope: ResolvedWorkingScope;
}

/** Result returned when resolving scope for create. */
export type CreateScopeResult = CreateScopeResolution | WorkingMemoryFailure;

/**
 * Resolves scope for create and verifies no current working set already exists.
 *
 * @param params - Create inputs with optional working set id or scope facts.
 * @param repository - Working-memory persistence port.
 * @returns Resolved scope ready for create, or a stable failure.
 */
export async function resolveCreateScope(
  params: Pick<AgenrWorkParams, "workingSetId" | "scope">,
  repository: WorkingMemoryRepository,
): Promise<CreateScopeResult> {
  const workingSetId = params.workingSetId?.trim();
  if (workingSetId) {
    const workingSet = await repository.getWorkingSet(workingSetId);
    if (workingSet) {
      return createFailure("active_set_exists", "A working set is already active for this scope.", {
        workingSetId: workingSet.id,
        scopeKey: workingSet.scopeKey,
      });
    }

    return createFailure("not_found", `Working set ${workingSetId} was not found.`, { workingSetId });
  }

  const lookup = await lookupCurrentWorkingSets(params.scope, repository);
  if (!lookup.ok) {
    return lookup;
  }

  if (lookup.matches.length === 1) {
    const existing = lookup.matches[0];
    return createFailure("active_set_exists", "A working set already exists for this scope.", {
      workingSetId: existing.id,
      scopeKey: lookup.scope.scopeKey,
    });
  }

  return {
    ok: true,
    scope: lookup.scope,
  };
}
