import { applyOperation, buildCommitAppliedWorkingSetChangeInput, commitAppliedWorkingSetChange, isAppliedWorkingSetCommitFailure } from "./apply-operation.js";
import { isGoalScopeKind, isMutableWorkingSetStatus, isTrustedHostMutationSource } from "./constants.js";
import type { WorkingMemoryHandlerContext } from "./handlers.js";
import type { AgenrWorkUpdateOperation, PrepareExternalGoalMutationParams } from "./mutations.js";
import type { WorkingEventRecord, WorkingSetRecord } from "./records.js";
import { isWorkingSetWriteFailure } from "./repository.js";
import { createFailure, writeFailureToResult, type WorkingMemoryResult } from "./results.js";
import { selectWorkingSet } from "./selection.js";

/** One typed accounting operation to commit before an external goal mutation. */
interface PrepareOperation {
  /** Operation applied to the active working set. */
  operation: AgenrWorkUpdateOperation;
  /** Audit reason stored with the committed revision. */
  updateReason: string;
}

/**
 * Handles progress accounting before trusted external goal mutations.
 *
 * When a request includes both usage accounting and a checkpoint, both writes
 * are committed through one repository transaction. If the checkpoint write
 * fails, the usage patch is rolled back and the final persisted working set is
 * unchanged from the caller's selected revision.
 */
export async function handlePrepareExternalGoalMutation(
  params: PrepareExternalGoalMutationParams,
  ctx: WorkingMemoryHandlerContext,
): Promise<WorkingMemoryResult> {
  if (!isTrustedHostMutationSource(params.source)) {
    return createFailure("invalid_request", "prepare_external_goal_mutation is reserved for trusted host runtime paths.");
  }

  const target = params.target ?? "goal";
  const selection = await selectWorkingSet({ ...params, target }, ctx.repository, { policy: ctx.policy });
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

  // A stale host cache may pass a workingSetId that no longer points at a goal
  // set. Goal preparation must never mutate session-layer working sets.
  if (target === "goal" && !isGoalScopeKind(selection.workingSet.scopeKind)) {
    return {
      ok: true,
      action: "prepare_external_goal_mutation",
      prepared: false,
      events: [],
    };
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
  const operations = resolvePrepareOperations(params);

  const atomicPrepare = await commitAtomicUsageAndCheckpointIfNeeded(workingSet, operations, params, ctx);
  if (atomicPrepare) {
    return atomicPrepare;
  }

  // The active set is selected once, then each accounting operation is committed in
  // order against the threaded record. Usage patches preserve revision so a later
  // semantic checkpoint commit can reuse the same expectedRevision.
  for (const { operation, updateReason } of operations) {
    const applied = applyOperation(workingSet, operation, updateReason);
    if (!applied.ok) {
      return applied;
    }

    const writeResult = await commitAppliedWorkingSetChange(ctx.repository, {
      workingSetId: workingSet.id,
      expectedRevision: workingSet.revision,
      operation,
      previousStatus: workingSet.status,
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
    if (writeResult.event) {
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

/** Commits prepare usage and checkpoint writes in one transaction when both are present. */
async function commitAtomicUsageAndCheckpointIfNeeded(
  workingSet: WorkingSetRecord,
  operations: PrepareOperation[],
  params: PrepareExternalGoalMutationParams,
  ctx: WorkingMemoryHandlerContext,
): Promise<WorkingMemoryResult | undefined> {
  const [usage, checkpoint] = operations;
  if (operations.length !== 2 || usage?.operation.type !== "account_usage" || checkpoint?.operation.type !== "merge_checkpoint") {
    return undefined;
  }

  const appliedUsage = applyOperation(workingSet, usage.operation, usage.updateReason);
  if (!appliedUsage.ok) {
    return appliedUsage;
  }

  const checkpointWorkingSet: WorkingSetRecord = {
    ...workingSet,
    status: appliedUsage.status,
    snapshot: appliedUsage.snapshot,
    ...(appliedUsage.title !== undefined ? { title: appliedUsage.title } : {}),
    ...(appliedUsage.objective !== undefined ? { objective: appliedUsage.objective } : {}),
  };
  const appliedCheckpoint = applyOperation(checkpointWorkingSet, checkpoint.operation, checkpoint.updateReason);
  if (!appliedCheckpoint.ok) {
    return appliedCheckpoint;
  }

  const usageInput = buildCommitAppliedWorkingSetChangeInput({
    workingSetId: workingSet.id,
    expectedRevision: workingSet.revision,
    operation: usage.operation,
    previousStatus: workingSet.status,
    updateReason: usage.updateReason,
    applied: appliedUsage,
    actor: params.actor,
    source: params.source,
    now: ctx.timestamp,
  });
  const checkpointInput = buildCommitAppliedWorkingSetChangeInput({
    workingSetId: workingSet.id,
    expectedRevision: workingSet.revision,
    operation: checkpoint.operation,
    previousStatus: appliedUsage.status,
    updateReason: checkpoint.updateReason,
    applied: appliedCheckpoint,
    actor: params.actor,
    source: params.source,
    now: ctx.timestamp,
  });

  if (!usageInput.usagePatch || !checkpointInput.semanticUpdate) {
    return undefined;
  }

  const writeResult = await ctx.repository.patchWorkingSetUsageAndUpdate({
    usagePatch: usageInput.usagePatch,
    update: checkpointInput.semanticUpdate,
  });
  if (isWorkingSetWriteFailure(writeResult)) {
    return writeFailureToResult(workingSet.id, writeResult);
  }

  return {
    ok: true,
    action: "prepare_external_goal_mutation",
    prepared: true,
    workingSet: writeResult.workingSet,
    events: writeResult.events,
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
