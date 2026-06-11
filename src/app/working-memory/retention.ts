import type { WorkingSetRecord } from "./records.js";
import type { WorkingMemoryRepository } from "./repository.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default retention window for terminal working sets, in days. */
const DEFAULT_WORKING_SET_RETENTION_DAYS = 30;

/** Default per-pass ceiling on terminal sets considered by one retention run. */
const DEFAULT_WORKING_SET_RETENTION_BATCH_LIMIT = 200;

export { DEFAULT_WORKING_SET_RETENTION_BATCH_LIMIT, DEFAULT_WORKING_SET_RETENTION_DAYS };

/** Ports required by the working-set retention reaper. */
export interface WorkingSetRetentionDeps {
  /** Working-memory persistence port. */
  workingMemory: WorkingMemoryRepository;
}

/** Options accepted by one working-set retention pass. */
export interface WorkingSetRetentionOptions {
  /** Clock used to compute the retention cutoff. */
  now: () => Date;
  /** Retention window in days for terminal (`closed`/`abandoned`) sets. */
  retentionDays: number;
  /** When false, the pass only reports what would be reaped. */
  apply: boolean;
  /** Maximum terminal sets considered in one pass. */
  batchLimit?: number;
}

/** Per-set decision emitted by one retention pass. */
export interface WorkingSetReapDecision {
  /** Working-set id the decision applies to. */
  workingSetId: string;
  /** Terminal status observed on the row. */
  status: WorkingSetRecord["status"];
  /** Close timestamp used for the retention comparison. */
  closedAt: string;
  /** Reap outcome for the set. */
  outcome: "reaped" | "skipped_pending_candidates";
}

/** Result of one working-set retention pass. */
export interface RunWorkingSetRetentionResult {
  /** Exclusive ISO cutoff applied to terminal close times. */
  cutoff: string;
  /** Terminal sets older than the cutoff considered this pass. */
  terminalSetsScanned: number;
  /** Sets deleted (apply) or deletable (dry run). */
  setsReaped: number;
  /** Ledger events deleted with their parent sets; zero on dry runs. */
  eventsReaped: number;
  /** Sets preserved because candidates are still pending promotion. */
  setsSkippedPendingCandidates: number;
  /** Per-set decisions in scan order. */
  decisions: WorkingSetReapDecision[];
  /** True when no rows were deleted. */
  dryRun: boolean;
}

/**
 * Reaps terminal working sets older than the retention window.
 *
 * Only `closed` and `abandoned` sets are considered. A set whose snapshot
 * still carries `pending` promotion candidates is never deleted: the pending
 * work is reported so the consolidation or episode promotion path can finish
 * it, and a later pass reaps the set once nothing is pending. `working_events`
 * rows are deleted with their parent set. The pass is idempotent: reaped sets
 * no longer match the query, and skipped sets are re-evaluated next pass.
 *
 * @param deps - Working-memory persistence port.
 * @param options - Clock, retention window, apply gate, and batch limit.
 * @returns Per-set decisions plus aggregate reap counts.
 */
export async function runWorkingSetRetention(deps: WorkingSetRetentionDeps, options: WorkingSetRetentionOptions): Promise<RunWorkingSetRetentionResult> {
  if (!Number.isFinite(options.retentionDays) || options.retentionDays < 0) {
    throw new Error(`Working-set retention requires a non-negative retentionDays, got ${options.retentionDays}.`);
  }

  const cutoff = new Date(options.now().getTime() - options.retentionDays * DAY_MS).toISOString();
  const candidates = await deps.workingMemory.listReapableWorkingSets({
    closedBefore: cutoff,
    limit: options.batchLimit ?? DEFAULT_WORKING_SET_RETENTION_BATCH_LIMIT,
  });

  const decisions: WorkingSetReapDecision[] = candidates.map((workingSet) => ({
    workingSetId: workingSet.id,
    status: workingSet.status,
    closedAt: workingSet.closedAt ?? workingSet.updatedAt,
    outcome: hasPendingCandidates(workingSet) ? "skipped_pending_candidates" : "reaped",
  }));
  const reapableIds = decisions.filter((decision) => decision.outcome === "reaped").map((decision) => decision.workingSetId);

  // Dry runs report deletable counts; apply runs report rows actually removed.
  let setsReaped = reapableIds.length;
  let eventsReaped = 0;
  if (options.apply && reapableIds.length > 0) {
    const deleted = await deps.workingMemory.deleteWorkingSets(reapableIds);
    setsReaped = deleted.workingSetsDeleted;
    eventsReaped = deleted.workingEventsDeleted;
  }

  return {
    cutoff,
    terminalSetsScanned: candidates.length,
    setsReaped,
    eventsReaped,
    setsSkippedPendingCandidates: decisions.length - reapableIds.length,
    decisions,
    dryRun: !options.apply,
  };
}

/** Returns true when any snapshot candidate is still pending promotion. */
function hasPendingCandidates(workingSet: WorkingSetRecord): boolean {
  return (workingSet.snapshot.candidates ?? []).some((candidate) => candidate.promotionStatus === "pending");
}
