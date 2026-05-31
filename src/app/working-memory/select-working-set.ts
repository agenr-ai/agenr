import { findUniqueCurrentWorkingSet } from "./find-current-set.js";
import type { AgenrWorkParams } from "./mutations.js";
import type { WorkingSetRecord } from "./records.js";
import type { WorkingMemoryRepository } from "./repository.js";
import { createFailure, type WorkingMemoryFailure } from "./results.js";
import type { ResolvedWorkingScope } from "./scope.js";

/** Successful working-set selection. */
export interface WorkingSetSelection {
  /** Success discriminator. */
  ok: true;
  /** Selected working set. */
  workingSet: WorkingSetRecord;
  /** Resolved scope when selection used scope facts. */
  scope?: ResolvedWorkingScope;
}

/** Result returned when selecting a working set by id or scope. */
export type WorkingSetSelectionResult = WorkingSetSelection | WorkingMemoryFailure;

/**
 * Selects a working set by explicit id or resolved current scope.
 *
 * @param params - Selection inputs from a tool call.
 * @param repository - Working-memory persistence port.
 * @returns Selected set or a stable failure.
 */
export async function selectWorkingSet(
  params: Pick<AgenrWorkParams, "workingSetId" | "scope">,
  repository: WorkingMemoryRepository,
): Promise<WorkingSetSelectionResult> {
  const workingSetId = params.workingSetId?.trim();
  if (workingSetId) {
    const workingSet = await repository.getWorkingSet(workingSetId);
    if (!workingSet) {
      return createFailure("not_found", `Working set ${workingSetId} was not found.`, { workingSetId });
    }

    return { ok: true, workingSet };
  }

  const current = await findUniqueCurrentWorkingSet(params.scope, repository);
  if (!current.ok) {
    return current;
  }

  return {
    ok: true,
    workingSet: current.workingSet,
    scope: current.scope,
  };
}
