import { randomUUID } from "node:crypto";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import type { PaginatedQueryProgress } from "../../../app/surgeon/completion-guard.js";
import type { SurgeonCompletionSummary } from "../../../core/surgeon/types.js";
import type { SurgeonToolDeps } from "./index.js";
import { toolResult } from "./shared.js";

const COMPLETE_PASS_SCHEMA = Type.Object({
  actions_taken: Type.Integer({ minimum: 0 }),
  entries_skipped: Type.Array(
    Type.Object({
      entry_id: Type.Optional(Type.String()),
      reason: Type.String({ minLength: 1 }),
    }),
  ),
  observations: Type.Array(Type.String()),
  recommendations: Type.Array(Type.String()),
});

const MIN_BUDGET_USED_FRACTION = 0.75;
const MIN_BUDGET_USED_FRACTION_HARD = 0.20;
const SAFETY_VALVE_REJECTION_LIMIT = 5;
const RETIREMENT_COMPLETION_KEY = "retirement";

/** Validated parameter payload for the completion tool. */
type CompletePassParams = Static<typeof COMPLETE_PASS_SCHEMA>;

/**
 * Creates the structured run-completion tool with retirement-only governance.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Agent tool that finalizes the pass once completion guards are satisfied.
 */
export function createCompletePassTool(deps: SurgeonToolDeps): AgentTool<typeof COMPLETE_PASS_SCHEMA> {
  return {
    name: "complete_pass",
    label: "Complete pass",
    description: "Signal that the retirement pass is complete and provide the structured summary.",
    parameters: COMPLETE_PASS_SCHEMA,
    async execute(_toolCallId, params: CompletePassParams) {
      for (const skipped of params.entries_skipped) {
        const entryId = skipped.entry_id?.trim();
        await deps.recordRunAction({
          id: randomUUID(),
          runId: deps.runId,
          actionType: "skip",
          entryIds: entryId ? [entryId] : [],
          reasoning: skipped.reason.trim(),
          recallDelta: null,
          createdAt: deps.now().toISOString(),
        });
      }

      const summary: SurgeonCompletionSummary = {
        actions_taken: params.actions_taken,
        entries_skipped: params.entries_skipped,
        observations: params.observations,
        recommendations: params.recommendations,
      };

      const priorRejections = deps.completionGuards?.rejectionCounts.get(RETIREMENT_COMPLETION_KEY) ?? 0;
      const budgetUsage = calculateBudgetUsage(deps);
      const handledCount = Math.max(0, params.actions_taken + params.entries_skipped.length);

      if (priorRejections < SAFETY_VALVE_REJECTION_LIMIT && budgetUsage && deps.completionGuards && budgetUsage.budgetUsedPct < MIN_BUDGET_USED_FRACTION) {
        const progress = deps.completionGuards.retirement.snapshot();
        const knownCandidates = progress.totalCount ?? deps.completionGuards.initialHealth.retirementCandidates;
        const hasKnownWork = knownCandidates > 0 || progress.queryCalls > 0;

        // If barely any budget is used, reject even if the actionable scope was
        // exhausted — the surgeon should widen to scope="all" and keep working.
        const budgetBarelyUsed = budgetUsage.budgetUsedPct < MIN_BUDGET_USED_FRACTION_HARD;

        const shouldReject = budgetBarelyUsed ||
          (hasKnownWork &&
          !progress.sawExhaustedPage &&
          ((progress.queryCalls === 0 && knownCandidates > handledCount) ||
            (progress.queryCalls > 0 && (knownCandidates === 0 || progress.maxWindowEnd < knownCandidates))));

        if (shouldReject) {
          const rejectionCount = priorRejections + 1;
          deps.completionGuards.rejectionCounts.set(RETIREMENT_COMPLETION_KEY, rejectionCount);

          return toolResult({
            completed: false,
            rejected: true,
            rejectionCount,
            summary,
            budgetUsedPct: formatPercent(budgetUsage.budgetUsedPct),
            pagedCandidates: progress.maxWindowEnd,
            knownCandidates: knownCandidates || null,
            contextUsedTokens: budgetUsage.contextUsedTokens,
            contextLimit: budgetUsage.contextLimit || null,
            costUsedUsd: budgetUsage.costUsedUsd,
            costCapUsd: budgetUsage.costCapUsd || null,
            remainingCostUsd: budgetUsage.remainingCostUsd,
            message: budgetBarelyUsed
              ? `Completion rejected: only ${formatPercent(budgetUsage.budgetUsedPct)}% of the cost budget has been used ($${budgetUsage.costUsedUsd.toFixed(2)} of $${budgetUsage.costCapUsd.toFixed(2)}). If the actionable scope is exhausted, widen to scope='all' and continue paging through the broader candidate pool. Do not stop after a spot check.`
              : `Completion rejected: ${describeRetirementProgress(progress, knownCandidates)} and only ${formatPercent(budgetUsage.budgetUsedPct)}% of the cost budget has been used.`,
          });
        }
      }

      deps.completionState.setComplete(summary);
      return toolResult({
        completed: true,
        safetyValveUsed: priorRejections >= SAFETY_VALVE_REJECTION_LIMIT,
        summary,
      });
    },
  };
}

/**
 * Derives the current cost and context budget usage snapshot.
 *
 * @param deps - Shared run dependencies containing the optional budget tracker.
 * @returns Budget usage summary, or null when no tracker is configured.
 */
function calculateBudgetUsage(deps: SurgeonToolDeps): {
  budgetUsedPct: number;
  costUsedUsd: number;
  costCapUsd: number;
  remainingCostUsd: number;
  contextUsedTokens: number;
  contextLimit: number;
} | null {
  if (!deps.budgetTracker) {
    return null;
  }

  const remaining = deps.budgetTracker.remaining();
  const totals = deps.budgetTracker.totals();
  const costCapUsd = remaining.costCapUsd > 0 ? remaining.costCapUsd : normalizeNonNegativeNumber(deps.costCap);
  const budgetUsedPct = costCapUsd > 0 ? Math.max(0, Math.min(1, 1 - remaining.remainingCostUsd / costCapUsd)) : 1;

  return {
    budgetUsedPct,
    costUsedUsd: totals.costUsd,
    costCapUsd,
    remainingCostUsd: remaining.remainingCostUsd,
    contextUsedTokens: remaining.currentContextTokens,
    contextLimit: remaining.contextLimit,
  };
}

/**
 * Converts a 0-1 fraction into a whole-number percentage.
 *
 * @param value - Fractional percentage.
 * @returns Rounded whole-number percentage.
 */
function formatPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

/**
 * Produces a readable explanation of retirement pagination progress.
 *
 * @param progress - Recorded pagination state for the retirement query.
 * @param knownCandidates - Known candidate count for the guarded sweep.
 * @returns Human-readable progress summary.
 */
function describeRetirementProgress(progress: PaginatedQueryProgress, knownCandidates: number): string {
  if (progress.queryCalls === 0) {
    return knownCandidates > 0
      ? `about ${knownCandidates} retirement candidates were available before the pass started, but query_candidates has not been called yet`
      : "query_candidates has not been called yet";
  }

  if (knownCandidates > 0) {
    return `only ${progress.maxWindowEnd} of about ${knownCandidates} retirement candidates have been paged so far`;
  }

  return `only ${progress.maxWindowEnd} retirement candidates have been paged so far and query_candidates has not been exhausted`;
}

/**
 * Normalizes optional numeric input into a non-negative number.
 *
 * @param value - Raw numeric input.
 * @returns Safe non-negative numeric value.
 */
function normalizeNonNegativeNumber(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, value as number);
}
