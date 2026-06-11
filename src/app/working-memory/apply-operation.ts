import { nextGoalGenerationAfterObjectiveChange } from "./goal-generation.js";
import type { AgenrWorkUpdateOperation } from "./mutations.js";
import type { WorkingSetRecord } from "./records.js";
import { createFailure, type WorkingMemoryFailure } from "./results.js";
import type { WorkingBudgetLimitReason, WorkingSetStatus } from "./constants.js";
import { isCloseManagedStatus } from "./constants.js";
import type { WorkingBudgetState, WorkingNextAction, WorkingSnapshot, WorkingUsageDelta } from "./snapshot.js";
import { validateWorkingBudgetState, validateWorkingUsageDelta } from "./validation.js";

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
    case "set_scratchpad":
      snapshot.scratchpad = operation.scratchpad;
      break;
    case "add_file_note":
      snapshot.files = [...(snapshot.files ?? []), operation.file];
      break;
    case "add_command_note":
      snapshot.commands = [...(snapshot.commands ?? []), operation.command];
      break;
    case "record_decision":
      snapshot.decisions = [...(snapshot.decisions ?? []), operation.decision];
      break;
    case "record_assumption":
      snapshot.assumptions = [...(snapshot.assumptions ?? []), operation.assumption];
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
      snapshot.candidates = [...(snapshot.candidates ?? []), operation.candidate];
      break;
    case "configure_budget": {
      const budget = mergeBudgetState(snapshot.budgets, operation.budget);
      if (!budget.ok) {
        return budget;
      }

      const limited = applyBudgetLimitedStatus(status, budget.value, updateReason);
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
