import { randomUUID } from "node:crypto";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import type { SurgeonCompletionSummary } from "../../../core/surgeon/types.js";
import type { PaginatedQueryProgress, SurgeonSupersessionReviewProgress } from "../completion-guard.js";
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
const SAFETY_VALVE_REJECTION_LIMIT = 50;
const RETIREMENT_COMPLETION_KEY = "retirement";
const SUPERSESSION_COMPLETION_KEY = "supersession";

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
    description: "Signal that the current surgeon pass is complete and provide the structured summary.",
    parameters: COMPLETE_PASS_SCHEMA,
    async execute(_toolCallId, params: CompletePassParams) {
      const normalizedSkippedEntries = normalizeSkippedEntries(params.entries_skipped);
      const validationError = validateSkippedEntries(deps, normalizedSkippedEntries);
      if (validationError) {
        return toolResult({
          completed: false,
          rejected: true,
          message: validationError,
        });
      }

      const summary: SurgeonCompletionSummary = {
        actions_taken: params.actions_taken,
        entries_skipped: normalizedSkippedEntries,
        observations: params.observations,
        recommendations: params.recommendations,
      };

      const rejection =
        deps.passType === "supersession" ? buildSupersessionCompletionRejection(deps, summary) : buildRetirementCompletionRejection(deps, summary);
      if (rejection) {
        return toolResult(rejection);
      }

      for (const skipped of normalizedSkippedEntries) {
        const entryId = skipped.entry_id?.trim();
        if (deps.passType === "supersession" && entryId) {
          deps.completionGuards?.supersession.markAdjudicated([entryId]);
        }

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

      deps.completionState.setComplete(summary);
      return toolResult({
        completed: true,
        safetyValveUsed: rejectionSafetyValveUsed(deps),
        summary,
      });
    },
  };
}

/**
 * Normalizes skipped-entry rows before completion validation and persistence.
 *
 * @param skippedEntries - Raw skip rows from the model.
 * @returns Trimmed rows safe for validation and persistence.
 */
function normalizeSkippedEntries(
  skippedEntries: Array<{
    entry_id?: string;
    reason: string;
  }>,
): Array<{
  entry_id?: string;
  reason: string;
}> {
  return skippedEntries.map((skipped) => {
    const entryId = skipped.entry_id?.trim();
    return {
      ...(entryId ? { entry_id: entryId } : {}),
      reason: skipped.reason.trim(),
    };
  });
}

/**
 * Validates skipped-entry references against the current pass context.
 *
 * @param deps - Shared run dependencies containing pass progress.
 * @param skippedEntries - Normalized skipped-entry rows.
 * @returns Human-readable rejection text, or null when valid.
 */
function validateSkippedEntries(
  deps: SurgeonToolDeps,
  skippedEntries: Array<{
    entry_id?: string;
    reason: string;
  }>,
): string | null {
  const seenEntryIds = new Set<string>();

  for (const skipped of skippedEntries) {
    const entryId = skipped.entry_id?.trim();
    if (!entryId) {
      continue;
    }
    if (seenEntryIds.has(entryId)) {
      return `Completion rejected: duplicate skipped entry '${entryId}' was provided. Re-query the current page and list each skipped entry only once.`;
    }
    seenEntryIds.add(entryId);

    if (!deps.completionGuards) {
      continue;
    }

    const wasSeen =
      deps.passType === "supersession" ? deps.completionGuards.supersession.hasSeenEntry(entryId) : deps.completionGuards.retirement.hasSeenEntry(entryId);
    if (!wasSeen) {
      return `Completion rejected: skipped entry '${entryId}' was not paged in this run. Re-query the current page before calling complete_pass.`;
    }
  }

  return null;
}

/**
 * Evaluates whether the retirement pass is allowed to complete yet.
 *
 * @param deps - Shared run dependencies containing completion guards and budget state.
 * @param summary - Structured completion summary from the tool call.
 * @returns Rejection payload when completion should be blocked, otherwise null.
 */
function buildRetirementCompletionRejection(deps: SurgeonToolDeps, summary: SurgeonCompletionSummary): Record<string, unknown> | null {
  const priorRejections = deps.completionGuards?.rejectionCounts.get(RETIREMENT_COMPLETION_KEY) ?? 0;
  const budgetUsage = calculateBudgetUsage(deps);
  const handledCount = Math.max(0, summary.actions_taken + summary.entries_skipped.length);

  if (priorRejections >= SAFETY_VALVE_REJECTION_LIMIT || !budgetUsage || !deps.completionGuards || budgetUsage.budgetUsedPct >= MIN_BUDGET_USED_FRACTION) {
    return null;
  }

  const progress = deps.completionGuards.retirement.snapshot();
  const fallbackAvailableCount = deps.completionGuards.initialHealth.retirementCandidates;
  const actionableAvailableCount =
    (progress.actionable.totalCount ?? deps.completionGuards.initialHealth.retirementAvailableActionableCandidates) || fallbackAvailableCount;
  const allAvailableCount = (progress.all.totalCount ?? deps.completionGuards.initialHealth.retirementAvailableAllCandidates) || fallbackAvailableCount;
  const allScopeExhausted = progress.all.sawExhaustedPage || (allAvailableCount > 0 && progress.all.maxWindowEnd >= allAvailableCount);
  const actionableScopeExhausted =
    progress.actionable.sawExhaustedPage || (actionableAvailableCount > 0 && progress.actionable.maxWindowEnd >= actionableAvailableCount);

  if (allAvailableCount === 0 && (progress.queryCalls > 0 || deps.completionGuards.initialHealth.retirementAvailableAllCandidates === 0)) {
    return null;
  }

  if (allScopeExhausted) {
    return null;
  }

  const shouldReject =
    (progress.queryCalls === 0 && allAvailableCount > handledCount) ||
    (actionableScopeExhausted && progress.all.maxWindowEnd === 0 && allAvailableCount > 0) ||
    progress.all.maxWindowEnd < allAvailableCount;

  if (!shouldReject) {
    return null;
  }

  const rejectionCount = priorRejections + 1;
  deps.completionGuards.rejectionCounts.set(RETIREMENT_COMPLETION_KEY, rejectionCount);

  return {
    completed: false,
    rejected: true,
    rejectionCount,
    summary,
    budgetUsedPct: formatPercent(budgetUsage.budgetUsedPct),
    pagedCandidates: progress.all.maxWindowEnd > 0 ? progress.all.maxWindowEnd : progress.actionable.maxWindowEnd,
    knownCandidates: allAvailableCount || null,
    contextUsedTokens: budgetUsage.contextUsedTokens,
    contextLimit: budgetUsage.contextLimit || null,
    costUsedUsd: budgetUsage.costUsedUsd,
    costCapUsd: budgetUsage.costCapUsd || null,
    remainingCostUsd: budgetUsage.remainingCostUsd,
    message: `Completion rejected: ${describeRetirementProgress(progress, actionableAvailableCount, allAvailableCount)} and only ${formatPercent(budgetUsage.budgetUsedPct)}% of the cost budget has been used.`,
  };
}

/**
 * Evaluates whether the supersession pass is allowed to complete yet.
 *
 * @param deps - Shared run dependencies containing completion guards and budget state.
 * @param summary - Structured completion summary from the tool call.
 * @returns Rejection payload when completion should be blocked, otherwise null.
 */
function buildSupersessionCompletionRejection(deps: SurgeonToolDeps, summary: SurgeonCompletionSummary): Record<string, unknown> | null {
  const priorRejections = deps.completionGuards?.rejectionCounts.get(SUPERSESSION_COMPLETION_KEY) ?? 0;
  if (priorRejections >= SAFETY_VALVE_REJECTION_LIMIT || !deps.completionGuards) {
    return null;
  }

  const progress = previewSupersessionCompletionProgress(deps, summary);
  const budgetUsage = calculateBudgetUsage(deps);
  const claimKeyTotal = progress.claimKeyClustersTotal || deps.completionGuards.initialHealth.supersessionClaimKeyClusters;
  const subjectTotal = progress.subjectClustersTotal || deps.completionGuards.initialHealth.supersessionSubjectClusters;
  const noKnownWork = claimKeyTotal === 0 && subjectTotal === 0;
  const viewedThreshold = Math.ceil(claimKeyTotal / 2);
  const viewedEnoughClaimKey = claimKeyTotal === 0 || progress.claimKeyClustersViewed >= viewedThreshold;
  const adjudicatedAny = progress.adjudicatedClusters > 0 || noKnownWork;
  const claimKeySweepComplete = claimKeyTotal === 0 || progress.claimKeyScopeExhausted;
  const subjectSweepComplete = subjectTotal === 0 || progress.subjectScopeExhausted;
  const budgetForcedStop = budgetUsage ? budgetUsage.budgetUsedPct >= MIN_BUDGET_USED_FRACTION : false;

  if (claimKeySweepComplete && subjectSweepComplete) {
    return null;
  }

  const shouldReject = !viewedEnoughClaimKey || !adjudicatedAny || (!budgetForcedStop && progress.widenedBeforeClaimKeyExhausted) || !budgetForcedStop;

  if (!shouldReject) {
    return null;
  }

  const rejectionCount = priorRejections + 1;
  deps.completionGuards.rejectionCounts.set(SUPERSESSION_COMPLETION_KEY, rejectionCount);

  return {
    completed: false,
    rejected: true,
    rejectionCount,
    summary,
    budgetUsedPct: budgetUsage ? formatPercent(budgetUsage.budgetUsedPct) : null,
    claimKeyClustersViewed: progress.claimKeyClustersViewed,
    claimKeyClustersTotal: claimKeyTotal,
    claimKeyClustersRemaining: progress.claimKeyClustersRemaining,
    claimKeyClustersAdjudicated: progress.claimKeyClustersAdjudicated,
    subjectClustersViewed: progress.subjectClustersViewed,
    subjectClustersTotal: subjectTotal,
    subjectClustersRemaining: progress.subjectClustersRemaining,
    subjectClustersAdjudicated: progress.subjectClustersAdjudicated,
    adjudicatedClusters: progress.adjudicatedClusters,
    widenedBeforeClaimKeyExhausted: progress.widenedBeforeClaimKeyExhausted,
    contextUsedTokens: budgetUsage?.contextUsedTokens ?? null,
    contextLimit: budgetUsage?.contextLimit ?? null,
    costUsedUsd: budgetUsage?.costUsedUsd ?? null,
    costCapUsd: budgetUsage?.costCapUsd ?? null,
    remainingCostUsd: budgetUsage?.remainingCostUsd ?? null,
    message: describeSupersessionRejection(progress, {
      claimKeyTotal,
      subjectTotal,
      budgetUsedPct: budgetUsage ? formatPercent(budgetUsage.budgetUsedPct) : null,
      budgetForcedStop,
      noKnownWork,
    }),
  };
}

/**
 * Builds the effective supersession progress snapshot for this completion call.
 *
 * @param deps - Shared run dependencies containing the supersession tracker.
 * @param summary - Structured completion summary from `complete_pass`.
 * @returns Current progress, including skipped entries as pending adjudications.
 */
function previewSupersessionCompletionProgress(deps: SurgeonToolDeps, summary: SurgeonCompletionSummary): SurgeonSupersessionReviewProgress {
  const skippedEntryIds = summary.entries_skipped.flatMap((skipped) => (skipped.entry_id ? [skipped.entry_id] : []));
  return skippedEntryIds.length > 0 ? deps.completionGuards!.supersession.previewAdjudication(skippedEntryIds) : deps.completionGuards!.supersession.snapshot();
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
 * Returns whether the completion safety valve was used for the active pass.
 *
 * @param deps - Shared run dependencies containing the completion guards.
 * @returns True when the active pass reached the rejection safety valve.
 */
function rejectionSafetyValveUsed(deps: SurgeonToolDeps): boolean {
  if (!deps.completionGuards) {
    return false;
  }

  const key = deps.passType === "supersession" ? SUPERSESSION_COMPLETION_KEY : RETIREMENT_COMPLETION_KEY;
  return (deps.completionGuards.rejectionCounts.get(key) ?? 0) >= SAFETY_VALVE_REJECTION_LIMIT;
}

/**
 * Produces a readable explanation of retirement pagination progress.
 *
 * @param progress - Recorded pagination state for the retirement query.
 * @param knownCandidates - Known candidate count for the guarded sweep.
 * @returns Human-readable progress summary.
 */
function describeRetirementProgress(progress: PaginatedQueryProgress, actionableAvailableCount: number, allAvailableCount: number): string {
  if (progress.queryCalls === 0) {
    return allAvailableCount > 0
      ? `about ${allAvailableCount} retirement candidates were available before the pass started, but query_candidates has not been called yet`
      : "query_candidates has not been called yet";
  }

  if (progress.actionable.sawExhaustedPage && progress.all.maxWindowEnd === 0 && allAvailableCount > 0) {
    return `the actionable scope is exhausted (${actionableAvailableCount} available), but the broader all scope has not been paged yet`;
  }

  if (allAvailableCount > 0) {
    return `only ${progress.all.maxWindowEnd} of about ${allAvailableCount} retirement candidates in scope='all' have been paged so far`;
  }

  return `the broader retirement scope is not exhausted yet`;
}

/**
 * Produces a readable explanation of supersession review progress.
 *
 * @param progress - Recorded supersession review state.
 * @param input - Known cluster totals and budget context.
 * @returns Human-readable progress summary.
 */
function describeSupersessionRejection(
  progress: SurgeonSupersessionReviewProgress,
  input: {
    claimKeyTotal: number;
    subjectTotal: number;
    budgetUsedPct: number | null;
    budgetForcedStop: boolean;
    noKnownWork: boolean;
  },
): string {
  if (input.noKnownWork) {
    return "Completion rejected: the supersession sweep has not queried any clusters yet.";
  }

  if (progress.adjudicatedClusters === 0) {
    return "Completion rejected: no supersession clusters have been adjudicated yet.";
  }

  if (progress.claimKeyClustersViewed < Math.ceil(input.claimKeyTotal / 2)) {
    return `Completion rejected: only ${progress.claimKeyClustersViewed} of ${input.claimKeyTotal} claim_key clusters have been viewed so far.`;
  }

  if (progress.widenedBeforeClaimKeyExhausted && !input.budgetForcedStop) {
    return "Completion rejected: the review widened beyond claim_key clusters before the claim_key sweep was exhausted.";
  }

  if (!progress.claimKeyScopeExhausted) {
    return input.budgetUsedPct === null
      ? `Completion rejected: ${progress.claimKeyClustersRemaining} claim_key clusters still remain in the current sweep. For reviewed-but-intentionally-unlinked clusters, include one paged entry_id per cluster in entries_skipped.`
      : `Completion rejected: ${progress.claimKeyClustersRemaining} claim_key clusters still remain in the current sweep and only ${input.budgetUsedPct}% of the cost budget has been used. For reviewed-but-intentionally-unlinked clusters, include one paged entry_id per cluster in entries_skipped.`;
  }

  if (input.subjectTotal > 0 && !progress.subjectScopeExhausted) {
    return input.budgetUsedPct === null
      ? `Completion rejected: the claim_key sweep is exhausted, but ${progress.subjectClustersRemaining} subject clusters still remain. For reviewed-but-intentionally-unlinked clusters, include one paged entry_id per cluster in entries_skipped.`
      : `Completion rejected: the claim_key sweep is exhausted, but ${progress.subjectClustersRemaining} subject clusters still remain and only ${input.budgetUsedPct}% of the cost budget has been used. For reviewed-but-intentionally-unlinked clusters, include one paged entry_id per cluster in entries_skipped.`;
  }

  if (!input.budgetForcedStop) {
    return input.budgetUsedPct === null
      ? "Completion rejected: the supersession sweep still has unfinished work."
      : `Completion rejected: the supersession sweep still has unfinished work and only ${input.budgetUsedPct}% of the cost budget has been used.`;
  }

  return "Completion rejected: the supersession pass needs either a finished claim_key sweep or a clearer budget-constrained stopping point.";
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
