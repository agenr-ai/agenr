import { normalizeListLimit } from "../limits.js";
import type { WorkingMemoryHandlerContext } from "../handler-context.js";
import type { AgenrWorkParams } from "../mutations.js";
import type { WorkingSetListFilter } from "../repository.js";
import type { WorkingSetRecord } from "../records.js";
import type { WorkingMemoryResult } from "../results.js";
import { resolveListScopes } from "../list-scope-resolution.js";
import { listFilter } from "../host-working-set-policy.js";
import type { ResolvedWorkingScope } from "../scope.js";

/** Handles the list action. */
export async function handleList(params: AgenrWorkParams, ctx: WorkingMemoryHandlerContext): Promise<WorkingMemoryResult> {
  const limit = normalizeListLimit(params.listLimit);
  const policyFilter = listFilter(ctx.policy);

  if (!params.scope) {
    const workingSets = await ctx.repository.listWorkingSets({
      ...policyFilter,
      limit,
    });
    return {
      ok: true,
      action: "list",
      workingSets,
    };
  }

  const scopeResolution = resolveListScopes(params.scope, params.target, ctx.policy);
  if (!scopeResolution.ok) {
    return scopeResolution;
  }

  const workingSets = await listWorkingSetsForScopes(ctx.repository, scopeResolution.scopes, limit, policyFilter);
  return {
    ok: true,
    action: "list",
    workingSets,
  };
}

/** Lists working sets for one or more resolved scopes and applies the global limit. */
async function listWorkingSetsForScopes(
  repository: WorkingMemoryHandlerContext["repository"],
  scopes: ResolvedWorkingScope[],
  limit: number,
  policyFilter: Pick<WorkingSetListFilter, "scopeKinds">,
): Promise<WorkingSetRecord[]> {
  if (scopes.length === 1) {
    return repository.listWorkingSets({
      scope: scopes[0],
      ...policyFilter,
      limit,
    });
  }

  const batches = await Promise.all(
    scopes.map((scope) =>
      repository.listWorkingSets({
        scope,
        ...policyFilter,
        limit,
      }),
    ),
  );

  const merged = new Map<string, WorkingSetRecord>();
  for (const batch of batches) {
    for (const workingSet of batch) {
      merged.set(workingSet.id, workingSet);
    }
  }

  return [...merged.values()].sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt)).slice(0, limit);
}
