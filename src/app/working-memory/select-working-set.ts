import { findUniqueCurrentWorkingSetForTarget } from "./find-current-set.js";
import { layersForAutoSelect, validateSelectedWorkingSet, type HostWorkingSetPolicy } from "./host-working-set-policy.js";
import type { ExplicitWorkingSetTarget } from "./mutations.js";
import type { AgenrWorkParams } from "./mutations.js";
import type { WorkingSetRecord } from "./records.js";
import type { WorkingMemoryRepository } from "./repository.js";
import { createFailure, type WorkingMemoryFailure } from "./results.js";
import type { ResolvedWorkingScope, WorkingScope } from "./scope.js";

/** Options that tune working-set selection behavior. */
export interface SelectWorkingSetOptions {
  /** Host policy governing session and goal working-set exposure. */
  policy: HostWorkingSetPolicy;
}

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
 * @param options - Host policy governing selection behavior.
 * @returns Selected set or a stable failure.
 */
export async function selectWorkingSet(
  params: Pick<AgenrWorkParams, "workingSetId" | "scope" | "target">,
  repository: WorkingMemoryRepository,
  options: SelectWorkingSetOptions,
): Promise<WorkingSetSelectionResult> {
  const { policy } = options;
  const workingSetId = params.workingSetId?.trim();
  if (workingSetId) {
    const workingSet = await repository.getWorkingSet(workingSetId);
    if (!workingSet) {
      return createFailure("not_found", `Working set ${workingSetId} was not found.`, { workingSetId });
    }

    const policyFailure = validateSelectedWorkingSet(policy, workingSet);
    if (policyFailure) {
      return policyFailure;
    }

    return { ok: true, workingSet };
  }

  const target = params.target ?? "auto";
  if (target === "goal" || target === "session") {
    return selectByExplicitTarget(params.scope, repository, target, policy);
  }

  let lastFailure: WorkingMemoryFailure | undefined;
  for (const explicitTarget of layersForAutoSelect(policy)) {
    const result = await selectByExplicitTarget(params.scope, repository, explicitTarget, policy);
    if (result.ok) {
      return result;
    }

    lastFailure = result;
    if (result.code !== "missing_active_set" && result.code !== "missing_scope") {
      return result;
    }
  }

  return (
    lastFailure ??
    createFailure("missing_active_set", "No current working set matched the resolved scope.", {
      scopeKey: "unknown",
    })
  );
}

/** Selects the unique current working set for one explicit layer. */
async function selectByExplicitTarget(
  scope: Partial<WorkingScope> | undefined,
  repository: WorkingMemoryRepository,
  target: ExplicitWorkingSetTarget,
  policy: HostWorkingSetPolicy,
): Promise<WorkingSetSelectionResult> {
  const current = await findUniqueCurrentWorkingSetForTarget(scope, repository, target);
  if (!current.ok) {
    return current;
  }

  const policyFailure = validateSelectedWorkingSet(policy, current.workingSet);
  if (policyFailure) {
    return policyFailure;
  }

  return {
    ok: true,
    workingSet: current.workingSet,
    scope: current.scope,
  };
}
