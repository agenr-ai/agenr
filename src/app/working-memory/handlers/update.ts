import { applyOperation } from "../apply-operation.js";
import { commitAppliedWorkingSetMutation } from "./commit-applied-mutation.js";
import { createToolSuccessProjection } from "../projection.js";
import type { AgenrWorkParams } from "../mutations.js";
import { isWorkingSetWriteFailure, type WorkingMemoryRepository, type WorkingSetWriteResult } from "../repository.js";
import { createFailure, writeFailureToResult, type WorkingMemoryResult } from "../results.js";
import { selectWorkingSet } from "../select-working-set.js";
import { isMutableWorkingSetStatus, isTrustedHostMutationSource, isTrustedHostOnlyWorkingOperation } from "../constants.js";
import { normalizeRequiredString, resolveExpectedRevision } from "../validation.js";

/** Handles typed update operations against an existing working set. */
export async function handleUpdate(params: AgenrWorkParams, repository: WorkingMemoryRepository, timestamp: string): Promise<WorkingMemoryResult> {
  const operation = params.operation;
  if (!operation) {
    return createFailure("invalid_request", "agenr_work update requires a typed operation.");
  }

  if (isTrustedHostOnlyWorkingOperation(operation.type) && !isTrustedHostMutationSource(params.source)) {
    return createFailure("invalid_request", `${operation.type} is reserved for trusted host runtime paths.`);
  }

  const updateReason = normalizeRequiredString(params.updateReason, "agenr_work update requires updateReason.");
  if (!updateReason.ok) {
    return updateReason;
  }

  const selection = await selectWorkingSet(params, repository);
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

  const writeResult = await commitAppliedWorkingSetMutation(repository, {
    workingSetId: selection.workingSet.id,
    expectedRevision: expectedRevision.value,
    eventType: operation.type,
    payload: {
      operation,
      updateReason: updateReason.value,
    },
    applied,
    actor: params.actor,
    source: params.source,
    now: timestamp,
  });
  return toUpdateResult(selection.workingSet.id, writeResult, timestamp);
}

/** Maps repository update responses to service results. */
function toUpdateResult(workingSetId: string, writeResult: WorkingSetWriteResult, timestamp: string): WorkingMemoryResult {
  if (isWorkingSetWriteFailure(writeResult)) {
    return writeFailureToResult(workingSetId, writeResult);
  }

  return {
    ok: true,
    action: "update",
    workingSet: writeResult.workingSet,
    event: writeResult.event,
    projection: createToolSuccessProjection(writeResult.workingSet, "update", timestamp),
  };
}
