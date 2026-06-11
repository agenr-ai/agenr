import { applyOperation } from "../apply-operation.js";
import { commitAppliedWorkingSetChange, isAppliedWorkingSetCommitFailure } from "./commit-applied-change.js";
import { createToolSuccessProjection } from "../projection.js";
import type { WorkingMemoryHandlerContext } from "../handler-context.js";
import type { AgenrWorkParams } from "../mutations.js";
import { isHostOnlyOperationType } from "../operations/manifest.js";
import { createFailure, writeFailureToResult, type WorkingMemoryResult } from "../results.js";
import { selectWorkingSet } from "../select-working-set.js";
import { isMutableWorkingSetStatus, isTrustedHostMutationSource } from "../constants.js";
import { normalizeRequiredString, resolveExpectedRevision } from "../validation.js";

/** Handles typed update operations against an existing working set. */
export async function handleUpdate(params: AgenrWorkParams, ctx: WorkingMemoryHandlerContext): Promise<WorkingMemoryResult> {
  const operation = params.operation;
  if (!operation) {
    return createFailure("invalid_request", "agenr_work update requires a typed operation.");
  }

  if (isHostOnlyOperationType(operation.type) && !isTrustedHostMutationSource(params.source)) {
    return createFailure("invalid_request", `${operation.type} is reserved for trusted host runtime paths.`);
  }

  const updateReason = normalizeRequiredString(params.updateReason, "agenr_work update requires updateReason.");
  if (!updateReason.ok) {
    return updateReason;
  }

  const selection = await selectWorkingSet(params, ctx.repository, { policy: ctx.policy });
  if (!selection.ok) {
    return selection;
  }

  const expectedRevision = resolveExpectedRevision(selection.workingSet.revision, params.expectedRevision, params.source);
  if (!expectedRevision.ok) {
    return expectedRevision;
  }

  if (!isMutableWorkingSetStatus(selection.workingSet.status)) {
    return createFailure("terminal_status", `Working set ${selection.workingSet.id} is already ${selection.workingSet.status}.`, {
      workingSetId: selection.workingSet.id,
      status: selection.workingSet.status,
    });
  }

  const applied = applyOperation(selection.workingSet, operation, updateReason.value);
  if (!applied.ok) {
    return applied;
  }

  const writeResult = await commitAppliedWorkingSetChange(ctx.repository, {
    workingSetId: selection.workingSet.id,
    expectedRevision: expectedRevision.value,
    operation,
    previousStatus: selection.workingSet.status,
    updateReason: updateReason.value,
    applied,
    actor: params.actor,
    source: params.source,
    now: ctx.timestamp,
  });
  if (isAppliedWorkingSetCommitFailure(writeResult)) {
    return writeFailureToResult(selection.workingSet.id, writeResult);
  }

  return {
    ok: true,
    action: "update",
    workingSet: writeResult.workingSet,
    ...(writeResult.event ? { event: writeResult.event } : {}),
    projection: createToolSuccessProjection(writeResult.workingSet, "update", ctx.timestamp),
  };
}
