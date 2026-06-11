import { appendBoundedUnique, WORKING_SNAPSHOT_ARRAY_LIMITS } from "./limits.js";
import type { AgenrWorkUpdateOperation } from "./mutations.js";
import type { WorkingEventRecord, WorkingSetRecord } from "./records.js";
import {
  isWorkingSetWriteFailure,
  type PatchWorkingSetUsageInput,
  type UpdateWorkingSetInput,
  type WorkingMemoryRepository,
  type WorkingSetWriteFailure,
} from "./repository.js";
import { createFailure, type WorkingMemoryFailure } from "./results.js";
import type { AgenrWorkMutationActor, AgenrWorkMutationSource, WorkingBudgetLimitReason, WorkingSetStatus } from "./constants.js";
import { isCloseManagedStatus } from "./constants.js";
import {
  nextGoalGenerationAfterObjectiveChange,
  type WorkingBudgetState,
  type WorkingNextAction,
  type WorkingSnapshot,
  type WorkingUsageDelta,
} from "./snapshot.js";
import { validateWorkingBudgetState, validateWorkingScratchpad, validateWorkingUsageDelta } from "./validation.js";

/** Result of applying one typed operation to a working-set snapshot. */
export interface AppliedWorkingOperation {
  /** Success discriminator. */
  ok: true;
  /** Next snapshot payload. */
  snapshot: WorkingSnapshot;
  /** Next status for the working set. */
  status: WorkingSetStatus;
  /** Optional display title update. */
  title?: string;
  /** Optional objective mirror update. */
  objective?: string;
}

/**
 * Applies one typed operation to a working-set snapshot.
 *
 * @param record - Current working set.
 * @param operation - Typed mutation operation.
 * @param updateReason - Audit reason stored on the snapshot.
 * @returns Updated snapshot fields or a stable failure.
 */
export function applyOperation(
  record: WorkingSetRecord,
  operation: AgenrWorkUpdateOperation,
  updateReason: string,
): AppliedWorkingOperation | WorkingMemoryFailure {
  const snapshot = { ...record.snapshot, lastMaterialChange: updateReason };
  let status = record.status;
  let title = record.title;
  let objective = record.snapshot.objective;

  switch (operation.type) {
    case "set_objective":
      snapshot.goalGeneration = nextGoalGenerationAfterObjectiveChange(snapshot, operation.objective);
      snapshot.objective = operation.objective;
      objective = operation.objective;
      title = operation.title ?? title;
      break;
    case "replace_plan":
      snapshot.currentPlan = operation.currentPlan;
      snapshot.nextActions = operation.nextActions;
      break;
    case "merge_checkpoint":
      snapshot.checkpoint = operation.checkpoint;
      if (operation.checkpoint.nextActions) {
        snapshot.nextActions = operation.checkpoint.nextActions.map((text): WorkingNextAction => ({ text, status: "pending" }));
      }
      if (operation.checkpoint.blockers) {
        snapshot.blockers = operation.checkpoint.blockers;
      }
      break;
    case "set_scratchpad": {
      const validation = validateWorkingScratchpad(operation.scratchpad);
      if (!validation.ok) {
        return validation;
      }

      snapshot.scratchpad = operation.scratchpad;
      break;
    }
    case "add_file_note":
      snapshot.files = appendBoundedUnique(snapshot.files, operation.file, WORKING_SNAPSHOT_ARRAY_LIMITS.files);
      break;
    case "add_command_note":
      snapshot.commands = appendBoundedUnique(snapshot.commands, operation.command, WORKING_SNAPSHOT_ARRAY_LIMITS.commands);
      break;
    case "record_decision":
      snapshot.decisions = appendBoundedUnique(snapshot.decisions, operation.decision, WORKING_SNAPSHOT_ARRAY_LIMITS.decisions);
      break;
    case "record_assumption":
      snapshot.assumptions = appendBoundedUnique(snapshot.assumptions, operation.assumption, WORKING_SNAPSHOT_ARRAY_LIMITS.assumptions);
      break;
    case "set_next_actions":
      snapshot.nextActions = operation.nextActions;
      break;
    case "set_status":
      if (isCloseManagedStatus(operation.status)) {
        return createFailure("invalid_request", "Use agenr_work close for closed or abandoned terminal states.");
      }
      status = operation.status;
      break;
    case "add_candidate":
      snapshot.candidates = appendBoundedUnique(snapshot.candidates, operation.candidate, WORKING_SNAPSHOT_ARRAY_LIMITS.candidates);
      break;
    case "configure_budget": {
      const budget = mergeBudgetState(snapshot.budgets, operation.budget);
      if (!budget.ok) {
        return budget;
      }

      const limited = applyConfiguredBudgetStatus(status, budget.value, updateReason);
      snapshot.budgets = limited.budgets;
      status = limited.status;
      break;
    }
    case "account_usage": {
      const budget = applyUsageDelta(snapshot.budgets, operation.usage, updateReason);
      if (!budget.ok) {
        return budget;
      }

      const limited = applyBudgetLimitedStatus(status, budget.value, operation.usage.recordedAt ?? updateReason);
      snapshot.budgets = limited.budgets;
      status = limited.status;
      break;
    }
    case "set_continuation_policy":
      snapshot.continuation = pruneContinuation({
        ...snapshot.continuation,
        policy: operation.policy,
        ...(operation.resumeAfter !== undefined ? { resumeAfter: operation.resumeAfter } : {}),
        ...(operation.staleAfter !== undefined ? { staleAfter: operation.staleAfter } : {}),
        ...(operation.stopReason !== undefined ? { stopReason: operation.stopReason } : {}),
      });
      break;
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }

  return {
    ok: true,
    snapshot,
    status,
    title,
    objective,
  };
}

/** Returns updated budget state and status after a trusted host budget configuration. */
function applyConfiguredBudgetStatus(
  currentStatus: WorkingSetStatus,
  budget: WorkingBudgetState | undefined,
  limitedAt: string,
): { status: WorkingSetStatus; budgets: WorkingBudgetState | undefined } {
  const limitReason = resolveBudgetLimitReason(budget);
  if (limitReason && budget) {
    return {
      status: "budget_limited",
      budgets: pruneBudget({
        ...budget,
        limitReason,
        limitedAt: budget.limitedAt ?? limitedAt,
      }),
    };
  }

  if (!budget) {
    return { status: currentStatus === "budget_limited" ? "active" : currentStatus, budgets: undefined };
  }

  return {
    status: currentStatus === "budget_limited" ? "active" : currentStatus,
    budgets: pruneBudget({
      ...budget,
      limitReason: undefined,
      limitedAt: undefined,
    }),
  };
}

/** Merges a trusted host budget configuration into current budget state. */
function mergeBudgetState(current: WorkingBudgetState | undefined, update: WorkingBudgetState): { ok: true; value: WorkingBudgetState } | WorkingMemoryFailure {
  const validation = validateWorkingBudgetState(update);
  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    value: pruneBudget({
      ...(current ?? {}),
      ...update,
    }),
  };
}

/** Applies an additive host usage delta to current budget counters. */
function applyUsageDelta(
  current: WorkingBudgetState | undefined,
  usage: WorkingUsageDelta,
  limitedAt: string,
): { ok: true; value: WorkingBudgetState } | WorkingMemoryFailure {
  const validation = validateWorkingUsageDelta(usage);
  if (!validation.ok) {
    return validation;
  }

  const next = {
    ...(current ?? {}),
    tokenUsed: addDelta(current?.tokenUsed, usage.tokenDelta),
    wallClockUsedSeconds: addDelta(current?.wallClockUsedSeconds, usage.wallClockSecondsDelta),
    turnsUsed: addDelta(current?.turnsUsed, usage.turnDelta),
  };
  const limitReason = resolveBudgetLimitReason(next);

  return {
    ok: true,
    value: pruneBudget({
      ...next,
      ...(limitReason ? { limitReason, limitedAt: usage.recordedAt ?? limitedAt } : {}),
    }),
  };
}

/** Returns updated budget state and status when any configured limit is exhausted. */
function applyBudgetLimitedStatus(
  currentStatus: WorkingSetStatus,
  budget: WorkingBudgetState | undefined,
  limitedAt: string,
): { status: WorkingSetStatus; budgets: WorkingBudgetState | undefined } {
  const limitReason = resolveBudgetLimitReason(budget);
  if (!limitReason || !budget) {
    return { status: currentStatus, budgets: budget };
  }

  return {
    status: "budget_limited",
    budgets: pruneBudget({
      ...budget,
      limitReason: budget.limitReason ?? limitReason,
      limitedAt: budget.limitedAt ?? limitedAt,
    }),
  };
}

/** Finds the first exhausted configured budget dimension. */
function resolveBudgetLimitReason(budget: WorkingBudgetState | undefined): WorkingBudgetLimitReason | undefined {
  if (!budget) {
    return undefined;
  }

  if (budget.tokenBudget !== undefined && (budget.tokenUsed ?? 0) >= budget.tokenBudget) {
    return "token";
  }

  if (budget.wallClockBudgetSeconds !== undefined && (budget.wallClockUsedSeconds ?? 0) >= budget.wallClockBudgetSeconds) {
    return "wall_clock";
  }

  if (budget.turnBudget !== undefined && (budget.turnsUsed ?? 0) >= budget.turnBudget) {
    return "turn";
  }

  return undefined;
}

/** Adds an optional positive delta to an optional counter. */
function addDelta(current: number | undefined, delta: number | undefined): number | undefined {
  if (delta === undefined) {
    return current;
  }

  return (current ?? 0) + delta;
}

/** Removes undefined budget fields before JSON storage. */
function pruneBudget(budget: WorkingBudgetState): WorkingBudgetState {
  return Object.fromEntries(Object.entries(budget).filter(([, value]) => value !== undefined)) as WorkingBudgetState;
}

/** Removes undefined continuation fields before JSON storage. */
function pruneContinuation(continuation: WorkingSnapshot["continuation"]): WorkingSnapshot["continuation"] {
  if (!continuation) {
    return undefined;
  }

  const pruned = Object.fromEntries(Object.entries(continuation).filter(([, value]) => value !== undefined)) as NonNullable<WorkingSnapshot["continuation"]>;
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}

/** Input used to persist one applied working-set change. */
export interface CommitAppliedWorkingSetChangeInput {
  /** Working-set id to mutate. */
  workingSetId: string;
  /** Revision observed by the caller. */
  expectedRevision: number;
  /** Typed operation that produced the applied snapshot. */
  operation: AgenrWorkUpdateOperation;
  /** Status observed before applying the operation. */
  previousStatus: WorkingSetStatus;
  /** Audit reason stored with semantic mutations. */
  updateReason: string;
  /** Applied snapshot and row mirrors. */
  applied: AppliedWorkingOperation;
  /** Actor that initiated the mutation. */
  actor?: AgenrWorkMutationActor;
  /** Source surface that emitted the mutation. */
  source?: AgenrWorkMutationSource;
  /** Timestamp to use for row and event updates. */
  now: string;
}

/** Successful usage patch commit. */
export interface AppliedWorkingSetUsagePatchCommit {
  /** Commit discriminator. */
  type: "usage_patch";
  /** Updated working set after the patch is committed. */
  workingSet: WorkingSetRecord;
  /** Audit event written when the usage patch caused a status transition. */
  event?: WorkingEventRecord;
}

/** Successful semantic mutation commit. */
export interface AppliedWorkingSetSemanticCommit {
  /** Commit discriminator. */
  type: "semantic";
  /** Updated working set after the event is committed. */
  workingSet: WorkingSetRecord;
  /** Event written for the mutation. */
  event: WorkingEventRecord;
}

/** Successful commit response for one applied working-set change. */
export type AppliedWorkingSetCommitResult = AppliedWorkingSetUsagePatchCommit | AppliedWorkingSetSemanticCommit;

/** Repository commit response for one applied working-set change. */
export type CommitAppliedWorkingSetChangeResult = AppliedWorkingSetCommitResult | WorkingSetWriteFailure;

/** Repository inputs derived from one applied working-set change. */
export interface AppliedWorkingSetRepositoryInputs {
  /** Usage-patch input when the operation is trusted usage accounting. */
  usagePatch?: PatchWorkingSetUsageInput;
  /** Semantic-update input when the operation advances revision and writes an event. */
  semanticUpdate?: UpdateWorkingSetInput;
}

/** Returns true when a commit result is a repository write failure. */
export function isAppliedWorkingSetCommitFailure(result: CommitAppliedWorkingSetChangeResult): result is WorkingSetWriteFailure {
  return "kind" in result;
}

/**
 * Persists one applied working-set change, routing usage patches without revision bumps.
 *
 * @param repository - Working-memory persistence port.
 * @param input - Applied operation facts and audit metadata.
 * @returns Updated row, optional event, or a stable write failure.
 */
export async function commitAppliedWorkingSetChange(
  repository: WorkingMemoryRepository,
  input: CommitAppliedWorkingSetChangeInput,
): Promise<CommitAppliedWorkingSetChangeResult> {
  const repositoryInputs = buildCommitAppliedWorkingSetChangeInput(input);
  if (repositoryInputs.usagePatch) {
    const writeResult = await repository.patchWorkingSetUsage(repositoryInputs.usagePatch);
    if (isWorkingSetWriteFailure(writeResult)) {
      return writeResult;
    }

    return {
      type: "usage_patch",
      workingSet: writeResult.workingSet,
      ...(writeResult.event ? { event: writeResult.event } : {}),
    };
  }

  if (!repositoryInputs.semanticUpdate) {
    throw new Error(`Unsupported working-set commit operation: ${input.operation.type}`);
  }

  const writeResult = await repository.updateWorkingSet(repositoryInputs.semanticUpdate);
  if (isWorkingSetWriteFailure(writeResult)) {
    return writeResult;
  }

  return {
    type: "semantic",
    workingSet: writeResult.workingSet,
    event: writeResult.event,
  };
}

/**
 * Builds repository-specific inputs for one applied working-set change.
 *
 * @param input - Applied operation facts and audit metadata.
 * @returns Exactly one repository input for the operation kind.
 */
export function buildCommitAppliedWorkingSetChangeInput(input: CommitAppliedWorkingSetChangeInput): AppliedWorkingSetRepositoryInputs {
  if (input.operation.type === "account_usage") {
    return {
      usagePatch: {
        workingSetId: input.workingSetId,
        expectedRevision: input.expectedRevision,
        status: input.applied.status,
        snapshot: input.applied.snapshot,
        title: input.applied.title,
        objective: input.applied.objective,
        auditEvent:
          input.previousStatus !== "budget_limited" && input.applied.status === "budget_limited"
            ? {
                eventType: "account_usage",
                payload: {
                  operation: input.operation,
                  updateReason: input.updateReason,
                  statusTransition: {
                    from: input.previousStatus,
                    to: "budget_limited",
                  },
                },
                actor: input.actor,
                source: input.source,
              }
            : undefined,
        now: input.now,
      },
    };
  }

  return {
    semanticUpdate: {
      workingSetId: input.workingSetId,
      expectedRevision: input.expectedRevision,
      eventType: input.operation.type,
      payload: {
        operation: input.operation,
        updateReason: input.updateReason,
      },
      status: input.applied.status,
      snapshot: input.applied.snapshot,
      title: input.applied.title,
      objective: input.applied.objective,
      actor: input.actor,
      source: input.source,
      now: input.now,
    },
  };
}
