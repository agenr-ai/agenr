import { isWithinValidityWindow } from "../temporal-validity.js";

import type { RecallExecutionTraceSummary } from "./trace.js";
import type { RecallMergeOutcome, RecallRankingProfile } from "./types.js";

/**
 * Inputs that decide how the bi-temporal valid-time half of recall is applied.
 */
export interface RecallValidAsOfParams {
  /** Optional recall ranking profile. */
  rankingProfile?: RecallRankingProfile;
  /** Caller-supplied as-of anchor when present. */
  asOfDate: Date | null;
  /** Current clock in epoch milliseconds. */
  nowMs: number;
}

/**
 * Resolves the single bi-temporal valid-time instant shared by the adapter SQL
 * pushdown and the core post-merge filter, or null when no valid-time filtering
 * applies.
 *
 * Returning one instant (or null) is the guard that stops the SQL clause and
 * the core filter from disagreeing about which profiles enforce valid time or
 * which instant they enforce it against. The `historical_state` profile is the
 * deliberate null case: it keeps superseded and expired lineage so historical
 * questions can answer with the belief that was held at the time.
 *
 * @param params - Ranking profile, optional explicit as-of, and the current clock.
 * @returns Instant to filter against, or null when filtering should not run.
 */
export function resolveRecallValidAsOf(params: RecallValidAsOfParams): Date | null {
  if (params.rankingProfile === "historical_state") {
    return null;
  }

  return new Date(params.asOfDate ? params.asOfDate.getTime() : params.nowMs);
}

/**
 * Drop merged candidates whose valid-time window does not contain the effective
 * as-of instant, then prune the per-channel rank lists so reciprocal rank
 * fusion never scores a candidate that has already been filtered out.
 *
 * The effective instant is the caller's explicit `asOf` when one was supplied,
 * otherwise the current clock (`nowMs`). This is the shared valid-time half of
 * the bi-temporal as-of contract: live injection and default recall ask "what
 * is valid right now", while an explicit `asOf` asks "what was valid at that
 * instant". The `historical_state` profile is the deliberate exception; it
 * keeps superseded and expired lineage so historical questions can answer with
 * the belief that was held at the time.
 *
 * @param mergeOutcome - Merged candidate map and per-channel rank lists, mutated in place.
 * @param summary - Mutable recall trace summary that records the filter facts.
 * @param params - Ranking profile, optional explicit as-of, and the current clock.
 */
export function applyAsOfValidityFilter(mergeOutcome: RecallMergeOutcome, summary: RecallExecutionTraceSummary, params: RecallValidAsOfParams): void {
  const asOf = resolveRecallValidAsOf(params);
  if (asOf === null) {
    return;
  }

  const asOfMs = asOf.getTime();
  const removed = new Set<string>();
  for (const [id, candidate] of mergeOutcome.merged) {
    if (!isWithinValidityWindow(candidate.durable.valid_from, candidate.durable.valid_to, asOfMs)) {
      mergeOutcome.merged.delete(id);
      removed.add(id);
    }
  }

  if (removed.size > 0) {
    mergeOutcome.vectorRanks = mergeOutcome.vectorRanks.filter((id) => !removed.has(id));
    mergeOutcome.ftsRanks = mergeOutcome.ftsRanks.filter((id) => !removed.has(id));
  }

  summary.filtering.asOfValidity = {
    applied: true,
    anchor: new Date(asOfMs).toISOString(),
    source: params.asOfDate ? "explicit_as_of" : "now",
    excludedCount: removed.size,
  };
}
