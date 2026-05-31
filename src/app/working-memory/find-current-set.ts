import type { WorkingSetRecord } from "./records.js";
import type { WorkingMemoryRepository } from "./repository.js";
import { createFailure, type WorkingMemoryFailure } from "./results.js";
import { resolveWorkingScope } from "./scope-resolver.js";
import type { ResolvedWorkingScope, WorkingScope } from "./scope.js";

/** Successful scope lookup with current working-set matches. */
export interface CurrentWorkingSetLookup {
  /** Success discriminator. */
  ok: true;
  /** Resolved scope used for the lookup. */
  scope: ResolvedWorkingScope;
  /** Current working sets for the scope, possibly empty. */
  matches: WorkingSetRecord[];
}

/** Result returned when looking up current working sets by scope. */
export type CurrentWorkingSetLookupResult = CurrentWorkingSetLookup | WorkingMemoryFailure;

/**
 * Resolves scope and loads current working sets for that scope.
 *
 * @param scope - Raw scope facts supplied by the host.
 * @param repository - Working-memory persistence port.
 * @returns Resolved scope and matching sets, or a stable failure.
 */
export async function lookupCurrentWorkingSets(
  scope: Partial<WorkingScope> | undefined,
  repository: WorkingMemoryRepository,
): Promise<CurrentWorkingSetLookupResult> {
  const scopeResolution = resolveWorkingScope(scope);
  if (!scopeResolution.ok) {
    return createFailure("missing_scope", scopeResolution.message);
  }

  const matches = await repository.findCurrentWorkingSets(scopeResolution.scope);
  if (matches.length > 1) {
    return createFailure("ambiguous_scope", "Multiple current working sets matched the resolved scope.", {
      scopeKey: scopeResolution.scope.scopeKey,
      workingSetIds: matches.map((match) => match.id),
    });
  }

  return {
    ok: true,
    scope: scopeResolution.scope,
    matches,
  };
}

/** Successful lookup of a unique current working set for one scope. */
export interface UniqueCurrentWorkingSet {
  /** Success discriminator. */
  ok: true;
  /** Matched working set. */
  workingSet: WorkingSetRecord;
  /** Resolved scope used for the lookup. */
  scope: ResolvedWorkingScope;
}

/** Result returned when resolving a unique current working set by scope. */
export type UniqueCurrentWorkingSetResult = UniqueCurrentWorkingSet | WorkingMemoryFailure;

/**
 * Finds the unique current working set for one scope.
 *
 * @param scope - Raw scope facts supplied by the host.
 * @param repository - Working-memory persistence port.
 * @returns Selected set or a stable failure.
 */
export async function findUniqueCurrentWorkingSet(
  scope: Partial<WorkingScope> | undefined,
  repository: WorkingMemoryRepository,
): Promise<UniqueCurrentWorkingSetResult> {
  const lookup = await lookupCurrentWorkingSets(scope, repository);
  if (!lookup.ok) {
    return lookup;
  }

  if (lookup.matches.length === 0) {
    return createFailure("missing_active_set", "No current working set matched the resolved scope.", {
      scopeKey: lookup.scope.scopeKey,
    });
  }

  return {
    ok: true,
    workingSet: lookup.matches[0],
    scope: lookup.scope,
  };
}
