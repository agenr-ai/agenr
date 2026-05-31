import type { WorkingSetStatus } from "../../app/working-memory/constants.js";
import type { WorkingSetRecord } from "../../app/working-memory/records.js";
import type { WorkingCheckpoint } from "../../app/working-memory/snapshot.js";

/** Codex-compatible goal object returned by goal alias tools. */
export interface GoalToolGoal {
  /** Agenr working-set id backing this goal. */
  workingSetId: string;
  /** Monotonic Agenr working-set revision. */
  revision: number;
  /** Current goal objective. */
  objective: string;
  /** Current goal status. */
  status: WorkingSetStatus;
  /** Token budget assigned to the goal. */
  tokenBudget?: number;
  /** Tokens used so far according to the host. */
  tokensUsed: number;
  /** Wall-clock seconds used so far according to the host. */
  timeUsedSeconds: number;
  /** Optional latest checkpoint for runtime resume. */
  checkpoint?: WorkingCheckpoint;
  /** Host continuation policy stored on the goal. */
  continuationPolicy?: string;
  /** ISO timestamp after which the host may resume. */
  resumeAfter?: string;
  /** ISO timestamp after which the goal should be treated as stale. */
  staleAfter?: string;
  /** Budget dimension that most recently limited continuation. */
  budgetLimitReason?: string;
  /** Maximum continuation turns allowed by the host. */
  turnBudget?: number;
  /** Continuation turns used so far according to the host. */
  turnsUsed: number;
  /** Creation timestamp from the working-set row. */
  createdAt: string;
  /** Last update timestamp from the working-set row. */
  updatedAt: string;
}

/** Structured response returned by goal alias tools. */
export interface GoalToolResponse {
  /** Current goal or null when no goal exists. */
  goal: GoalToolGoal | null;
  /** Remaining token budget when one is set, otherwise null. */
  remainingTokens: number | null;
  /** Completion reporting guidance when a completed goal has usage to report. */
  completionBudgetReport: string | null;
}

const COMPLETION_BUDGET_REPORT =
  "Goal achieved. Report final usage from this tool result's structured goal fields. If `goal.tokenBudget` is present, include token usage from `goal.tokensUsed` and `goal.tokenBudget`. If `goal.timeUsedSeconds` is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language.";

/**
 * Maps one working set into a Codex-compatible goal object.
 *
 * @param workingSet - Active or terminal working set.
 * @returns Goal object for structured tool output.
 */
export function toGoalToolGoal(workingSet: WorkingSetRecord): GoalToolGoal {
  const budgets = workingSet.snapshot.budgets;
  return {
    workingSetId: workingSet.id,
    revision: workingSet.revision,
    objective: workingSet.snapshot.objective ?? workingSet.objective ?? "",
    status: workingSet.status,
    ...(budgets?.tokenBudget !== undefined ? { tokenBudget: budgets.tokenBudget } : {}),
    tokensUsed: budgets?.tokenUsed ?? 0,
    timeUsedSeconds: budgets?.wallClockUsedSeconds ?? 0,
    ...(workingSet.snapshot.checkpoint ? { checkpoint: workingSet.snapshot.checkpoint } : {}),
    ...(workingSet.snapshot.continuation?.policy ? { continuationPolicy: workingSet.snapshot.continuation.policy } : {}),
    ...(workingSet.snapshot.continuation?.resumeAfter ? { resumeAfter: workingSet.snapshot.continuation.resumeAfter } : {}),
    ...(workingSet.snapshot.continuation?.staleAfter ? { staleAfter: workingSet.snapshot.continuation.staleAfter } : {}),
    ...(budgets?.limitReason ? { budgetLimitReason: budgets.limitReason } : {}),
    ...(budgets?.turnBudget !== undefined ? { turnBudget: budgets.turnBudget } : {}),
    turnsUsed: budgets?.turnsUsed ?? 0,
    createdAt: workingSet.createdAt,
    updatedAt: workingSet.updatedAt,
  };
}

/**
 * Builds a Codex-compatible goal response from one working set.
 *
 * @param workingSet - Active working set or null when no goal exists.
 * @param includeCompletionReport - Whether to attach completion budget guidance.
 * @returns Structured goal alias response.
 */
export function toGoalToolResponse(workingSet: WorkingSetRecord | null, includeCompletionReport: boolean): GoalToolResponse {
  if (!workingSet) {
    return {
      goal: null,
      remainingTokens: null,
      completionBudgetReport: null,
    };
  }

  const budgets = workingSet.snapshot.budgets;
  const goal = toGoalToolGoal(workingSet);
  return {
    goal,
    remainingTokens: budgets?.tokenBudget !== undefined ? Math.max(budgets.tokenBudget - goal.tokensUsed, 0) : null,
    completionBudgetReport: includeCompletionReport && hasUsageToReport(goal) ? COMPLETION_BUDGET_REPORT : null,
  };
}

/** Returns true when completion has budget or elapsed-time usage to report. */
function hasUsageToReport(goal: GoalToolGoal): boolean {
  return goal.tokenBudget !== undefined || goal.timeUsedSeconds > 0;
}

export { COMPLETION_BUDGET_REPORT };
