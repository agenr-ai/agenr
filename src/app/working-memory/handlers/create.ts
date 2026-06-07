import { INITIAL_GOAL_GENERATION } from "../goal-generation.js";
import { createToolSuccessProjection } from "../projection.js";
import type { WorkingMemoryHandlerContext } from "../handler-context.js";
import type { AgenrWorkParams } from "../mutations.js";
import { isWorkingSetCreateFailure } from "../repository.js";
import { resolveCreateScope } from "../resolve-create-scope.js";
import { validateExplicitCreateTarget } from "../validate-explicit-create-target.js";
import { createFailure, type WorkingMemoryResult } from "../results.js";
import { cloneForkableSnapshotFields } from "../session-fork-snapshot.js";
import { normalizeRequiredString, validateWorkingBudgetState } from "../validation.js";

/** Handles creation of a new scoped working set. */
export async function handleCreate(params: AgenrWorkParams, ctx: WorkingMemoryHandlerContext): Promise<WorkingMemoryResult> {
  const operation = params.operation;
  if (!operation || operation.type !== "set_objective") {
    return createFailure("invalid_request", "agenr_work create requires a set_objective operation.");
  }

  const updateReason = normalizeRequiredString(params.updateReason, "agenr_work create requires updateReason.");
  if (!updateReason.ok) {
    return updateReason;
  }

  const createTarget = validateExplicitCreateTarget(params.target);
  if (!createTarget.ok) {
    return createTarget;
  }

  const scopeResolution = await resolveCreateScope({ ...params, target: createTarget.target }, ctx.repository);
  if (!scopeResolution.ok) {
    return scopeResolution;
  }

  const { scope } = scopeResolution;
  const initialBudget = params.initialBudget ? validateWorkingBudgetState(params.initialBudget) : { ok: true as const };
  if (!initialBudget.ok) {
    return initialBudget;
  }

  const created = await ctx.repository.createWorkingSet({
    scope,
    title: operation.title,
    objective: operation.objective,
    status: "active",
    snapshot: {
      ...cloneForkableSnapshotFields(params.initialSnapshot),
      goalGeneration: INITIAL_GOAL_GENERATION,
      objective: operation.objective,
      continuation: { policy: params.continuationPolicy ?? "manual" },
      ...(params.initialBudget ? { budgets: params.initialBudget } : {}),
      lastMaterialChange: updateReason.value,
    },
    actor: params.actor,
    source: params.source,
    sourceLabel: ctx.sourceLabel,
    sessionId: scope.sessionId,
    now: ctx.timestamp,
  });

  if (isWorkingSetCreateFailure(created)) {
    return createFailure("active_set_exists", "A working set already exists for this scope.", {
      scopeKey: created.scopeKey,
    });
  }

  return {
    ok: true,
    action: "create",
    workingSet: created.workingSet,
    event: created.event,
    projection: createToolSuccessProjection(created.workingSet, "create", ctx.timestamp),
  };
}
