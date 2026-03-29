/**
 * Snapshot of pagination progress for one repeated candidate query.
 */
export interface PaginatedQueryProgress {
  queryCalls: number;
  maxWindowEnd: number;
  totalCount: number | null;
  sawExhaustedPage: boolean;
}

/**
 * Tracks pagination progress for one surgeon query family.
 */
export interface PaginatedQueryTracker {
  /**
   * Clears the tracker back to its initial state.
   */
  reset(): void;

  /**
   * Records one observed page of results.
   *
   * @param input - Pagination metadata for the page.
   */
  recordPage(input: { offset: number; returnedCount: number; totalCount?: number; exhausted: boolean }): void;

  /**
   * Returns an immutable snapshot of current progress.
   *
   * @returns Current pagination progress.
   */
  snapshot(): PaginatedQueryProgress;
}

/**
 * Shared completion-guard state for a retirement-only surgeon run.
 */
export interface SurgeonCompletionGuardState {
  rejectionCounts: Map<string, number>;
  initialHealth: {
    totalEntries: number;
    retirementCandidates: number;
  };
  retirement: PaginatedQueryTracker;
}

/**
 * Creates a new paginated query tracker.
 *
 * @returns Tracker that accumulates query progress over time.
 */
export function createPaginatedQueryTracker(): PaginatedQueryTracker {
  let progress = createEmptyProgress();

  return {
    reset(): void {
      progress = createEmptyProgress();
    },

    recordPage(input): void {
      const offset = normalizeCount(input.offset);
      const returnedCount = normalizeCount(input.returnedCount);
      const totalCount = input.totalCount === undefined ? null : normalizeCount(input.totalCount);

      progress = {
        queryCalls: progress.queryCalls + 1,
        maxWindowEnd: Math.max(progress.maxWindowEnd, offset + returnedCount),
        totalCount: totalCount ?? progress.totalCount,
        sawExhaustedPage: progress.sawExhaustedPage || input.exhausted,
      };
    },

    snapshot(): PaginatedQueryProgress {
      return { ...progress };
    },
  };
}

/**
 * Creates the mutable completion-guard state for one retirement run.
 *
 * @param input - Initial corpus and candidate counts observed at run start.
 * @returns Retirement-only completion-guard state.
 */
export function createSurgeonCompletionGuardState(input: { totalEntries: number; retirementCandidates: number }): SurgeonCompletionGuardState {
  return {
    rejectionCounts: new Map<string, number>(),
    initialHealth: {
      totalEntries: normalizeCount(input.totalEntries),
      retirementCandidates: normalizeCount(input.retirementCandidates),
    },
    retirement: createPaginatedQueryTracker(),
  };
}

/**
 * Builds the zeroed pagination snapshot used for tracker initialization.
 *
 * @returns Empty pagination progress snapshot.
 */
function createEmptyProgress(): PaginatedQueryProgress {
  return {
    queryCalls: 0,
    maxWindowEnd: 0,
    totalCount: null,
    sawExhaustedPage: false,
  };
}

/**
 * Normalizes numeric counters into non-negative integers.
 *
 * @param value - Raw counter value.
 * @returns Safe non-negative integer.
 */
function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}
