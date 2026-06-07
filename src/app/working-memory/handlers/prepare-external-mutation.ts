import { applyOperation } from "../apply-operation.js";
import { commitAppliedWorkingSetChange, isAppliedWorkingSetCommitFailure } from "./commit-applied-change.js";
import { isMutableWorkingSetStatus, isTrustedHostMutationSource } from "../constants.js";
import type { WorkingMemoryHandlerContext } from "../handler-context.js";
import type { AgenrWorkUpdateOperation, PrepareExternalGoalMutationParams } from "../mutations.js";
import type { WorkingEventRecord, WorkingSetRecord } from "../records.js";
import { createFailure, writeFailureToResult, type WorkingMemoryResult } from "../results.js";
import { selectWorkingSet } from "../select-working-set.js";

/** One typed accounting operation to commit before an external goal mutation. */
interface PrepareOperation {
  /** Operation applied to the active working set. */
  operation: AgenrWorkUpdateOperation;
  /** Audit reason stored with the committed revision. */
  updateReason: string;
}

/** Handles progress accounting before trusted external goal mutations. */
export async function handlePrepareExternalGoalMutation(
  params: PrepareExternalGoalMutationParams,
  ctx: WorkingMemoryHandlerContext,
): Promise<WorkingMemoryResult> {
  if (!isTrustedHostMutationSource(params.source)) {
    return createFailure("invalid_request", "prepare_external_goal_mutation is reserved for trusted host runtime paths.");
  }

  const selection = await selectWorkingSet({ ...params, target: params.target ?? "goal" }, ctx.repository, { policy: ctx.policy });
  if (!selection.ok) {
    if (selection.code === "missing_active_set") {
      return {
        ok: true,
        action: "prepare_external_goal_mutation",
        prepared: false,
        events: [],
      };
    }

    return selection;
  }

  if (params.requireCheckpoint && !params.checkpoint && !selection.workingSet.snapshot.checkpoint) {
    return createFailure("invalid_request", `Active goal requires a checkpoint before ${params.mutationKind}.`, {
      workingSetId: selection.workingSet.id,
      revision: selection.workingSet.revision,
      mutationKind: params.mutationKind,
    });
  }

  if (!isMutableWorkingSetStatus(selection.workingSet.status)) {
    return {
      ok: true,
      action: "prepare_external_goal_mutation",
      prepared: true,
      workingSet: selection.workingSet,
      events: [],
    };
  }

  const events: WorkingEventRecord[] = [];
  let workingSet: WorkingSetRecord = selection.workingSet;

  // The active set is selected once, then each accounting operation is committed in
  // order against the threaded record. Usage patches preserve revision so a later
  // semantic checkpoint commit can reuse the same expectedRevision.
  for (const { operation, updateReason } of resolvePrepareOperations(params)) {
    const applied = applyOperation(workingSet, operation, updateReason);
    if (!applied.ok) {
      return applied;
    }

    const writeResult = await commitAppliedWorkingSetChange(ctx.repository, {
      workingSetId: workingSet.id,
      expectedRevision: workingSet.revision,
      operation,
      updateReason,
      applied,
      actor: params.actor,
      source: params.source,
      now: ctx.timestamp,
    });
    if (isAppliedWorkingSetCommitFailure(writeResult)) {
      return writeFailureToResult(workingSet.id, writeResult);
    }

    workingSet = writeResult.workingSet;
    if (writeResult.type === "semantic") {
      events.push(writeResult.event);
    }
  }

  return {
    ok: true,
    action: "prepare_external_goal_mutation",
    prepared: true,
    workingSet,
    events,
  };
}

/** Builds the ordered accounting operations requested for one external mutation. */
function resolvePrepareOperations(params: PrepareExternalGoalMutationParams): PrepareOperation[] {
  const operations: PrepareOperation[] = [];

  if (params.usage) {
    operations.push({
      operation: { type: "account_usage", usage: params.usage },
      updateReason: params.updateReason ?? `Accounted progress before external goal mutation (${params.mutationKind}).`,
    });
  }

  if (params.checkpoint) {
    operations.push({
      operation: { type: "merge_checkpoint", checkpoint: params.checkpoint },
      updateReason: params.updateReason ?? `Recorded checkpoint before external goal mutation (${params.mutationKind}).`,
    });
  }

  return operations;
}
