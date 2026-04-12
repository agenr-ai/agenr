import type { SurgeonSupersessionCluster } from "./ports.js";

/**
 * Snapshot of pagination progress for one repeated candidate query.
 */
export interface PaginatedQueryProgress {
  queryCalls: number;
  actionable: {
    maxWindowEnd: number;
    totalCount: number | null;
    sawExhaustedPage: boolean;
  };
  all: {
    maxWindowEnd: number;
    totalCount: number | null;
    sawExhaustedPage: boolean;
  };
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
  recordPage(input: { scope: "actionable" | "all"; offset: number; returnedCount: number; totalCount?: number; exhausted: boolean }): void;

  /**
   * Returns an immutable snapshot of current progress.
   *
   * @returns Current pagination progress.
   */
  snapshot(): PaginatedQueryProgress;
}

/**
 * Snapshot of supersession-cluster review progress for one run.
 */
export interface SurgeonSupersessionReviewProgress {
  claimKeyClustersViewed: number;
  claimKeyClustersTotal: number;
  claimKeyClustersAdjudicated: number;
  claimKeyScopeExhausted: boolean;
  subjectClustersViewed: number;
  subjectClustersTotal: number;
  subjectClustersAdjudicated: number;
  subjectScopeExhausted: boolean;
  adjudicatedClusters: number;
  widenedBeforeClaimKeyExhausted: boolean;
}

/**
 * Tracks supersession-cluster review progress across query and mutation tools.
 */
export interface SurgeonSupersessionReviewTracker {
  /**
   * Clears the tracker back to its initial state.
   */
  reset(): void;

  /**
   * Records one observed supersession-candidate page.
   *
   * @param input - Scope, totals, and returned clusters for the page.
   */
  recordPage(input: { scope: "claim_key" | "subject" | "all"; claimKeyTotal: number; subjectTotal: number; clusters: SurgeonSupersessionCluster[] }): void;

  /**
   * Drops clusters already adjudicated earlier in the same run.
   *
   * @param clusters - Candidate clusters about to be shown to the model.
   * @returns Only clusters that still need review in the current run.
   */
  filterPendingClusters(clusters: SurgeonSupersessionCluster[]): SurgeonSupersessionCluster[];

  /**
   * Marks one or more viewed clusters as adjudicated.
   *
   * @param entryIds - Entry IDs touched by a decisive supersession action.
   */
  markAdjudicated(entryIds: string[]): void;

  /**
   * Returns an immutable snapshot of current supersession progress.
   *
   * @returns Current review progress.
   */
  snapshot(): SurgeonSupersessionReviewProgress;
}

/**
 * Shared completion-guard state for one surgeon run.
 */
export interface SurgeonCompletionGuardState {
  rejectionCounts: Map<string, number>;
  initialHealth: {
    totalEntries: number;
    retirementCandidates: number;
    retirementAvailableActionableCandidates: number;
    retirementAvailableAllCandidates: number;
    supersessionClaimKeyClusters: number;
    supersessionSubjectClusters: number;
  };
  retirement: PaginatedQueryTracker;
  supersession: SurgeonSupersessionReviewTracker;
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
      const scope = input.scope === "all" ? "all" : "actionable";
      const offset = normalizeCount(input.offset);
      const returnedCount = normalizeCount(input.returnedCount);
      const totalCount = input.totalCount === undefined ? null : normalizeCount(input.totalCount);
      const scopedProgress = progress[scope];

      progress = {
        queryCalls: progress.queryCalls + 1,
        actionable:
          scope === "actionable"
            ? {
                maxWindowEnd: Math.max(scopedProgress.maxWindowEnd, offset + returnedCount),
                totalCount: totalCount ?? scopedProgress.totalCount,
                sawExhaustedPage: scopedProgress.sawExhaustedPage || input.exhausted,
              }
            : progress.actionable,
        all:
          scope === "all"
            ? {
                maxWindowEnd: Math.max(scopedProgress.maxWindowEnd, offset + returnedCount),
                totalCount: totalCount ?? scopedProgress.totalCount,
                sawExhaustedPage: scopedProgress.sawExhaustedPage || input.exhausted,
              }
            : progress.all,
      };
    },

    snapshot(): PaginatedQueryProgress {
      return { ...progress };
    },
  };
}

/**
 * Creates the mutable completion-guard state for one surgeon run.
 *
 * @param input - Initial corpus and candidate counts observed at run start.
 * @returns Completion-guard state for supported surgeon passes.
 */
export function createSurgeonCompletionGuardState(input: {
  totalEntries: number;
  retirementCandidates?: number;
  retirementAvailableActionableCandidates?: number;
  retirementAvailableAllCandidates?: number;
  supersessionClaimKeyClusters?: number;
  supersessionSubjectClusters?: number;
}): SurgeonCompletionGuardState {
  const supersessionClaimKeyClusters = normalizeOptionalCount(input.supersessionClaimKeyClusters);
  const supersessionSubjectClusters = normalizeOptionalCount(input.supersessionSubjectClusters);

  return {
    rejectionCounts: new Map<string, number>(),
    initialHealth: {
      totalEntries: normalizeCount(input.totalEntries),
      retirementCandidates: normalizeOptionalCount(input.retirementCandidates),
      retirementAvailableActionableCandidates: normalizeOptionalCount(input.retirementAvailableActionableCandidates),
      retirementAvailableAllCandidates: normalizeOptionalCount(input.retirementAvailableAllCandidates),
      supersessionClaimKeyClusters,
      supersessionSubjectClusters,
    },
    retirement: createPaginatedQueryTracker(),
    supersession: createSupersessionReviewTracker({
      claimKeyTotal: supersessionClaimKeyClusters,
      subjectTotal: supersessionSubjectClusters,
    }),
  };
}

/**
 * Creates the tracker used by the supersession pass completion guard.
 *
 * @param input - Initial cluster totals discovered before the run started.
 * @returns Tracker that accumulates cluster review progress.
 */
export function createSupersessionReviewTracker(input: { claimKeyTotal: number; subjectTotal: number }): SurgeonSupersessionReviewTracker {
  let progress = createEmptySupersessionProgress(input);
  let entryToClusterKeys = new Map<string, Set<string>>();

  return {
    reset(): void {
      progress = createEmptySupersessionProgress(input);
      entryToClusterKeys = new Map<string, Set<string>>();
    },

    recordPage({ scope, claimKeyTotal, subjectTotal, clusters }): void {
      const normalizedClaimKeyTotal = normalizeCount(claimKeyTotal);
      const normalizedSubjectTotal = normalizeCount(subjectTotal);
      const nextClaimKeyViewed = new Set(progress.claimKeyViewedKeys);
      const nextSubjectViewed = new Set(progress.subjectViewedKeys);
      const nextEntryMap = cloneEntryClusterMap(entryToClusterKeys);
      const wideningIntoSubject =
        (scope === "subject" || scope === "all") &&
        normalizedClaimKeyTotal > 0 &&
        !progress.claimKeyScopeExhausted &&
        nextClaimKeyViewed.size < normalizedClaimKeyTotal;

      for (const cluster of clusters) {
        const clusterKey = buildScopedClusterKey(cluster);
        if (cluster.groupedBy === "claim_key") {
          nextClaimKeyViewed.add(clusterKey);
        } else {
          nextSubjectViewed.add(clusterKey);
        }

        for (const entry of cluster.entries) {
          const entryClusters = nextEntryMap.get(entry.id) ?? new Set<string>();
          entryClusters.add(clusterKey);
          nextEntryMap.set(entry.id, entryClusters);
        }
      }

      progress = {
        claimKeyTotal: normalizedClaimKeyTotal,
        subjectTotal: normalizedSubjectTotal,
        claimKeyViewedKeys: nextClaimKeyViewed,
        subjectViewedKeys: nextSubjectViewed,
        adjudicatedClusterKeys: new Set(progress.adjudicatedClusterKeys),
        claimKeyScopeExhausted: normalizedClaimKeyTotal === 0 || nextClaimKeyViewed.size >= normalizedClaimKeyTotal,
        subjectScopeExhausted: normalizedSubjectTotal === 0 || nextSubjectViewed.size >= normalizedSubjectTotal,
        widenedBeforeClaimKeyExhausted: progress.widenedBeforeClaimKeyExhausted || wideningIntoSubject,
      };
      entryToClusterKeys = nextEntryMap;
    },

    filterPendingClusters(clusters): SurgeonSupersessionCluster[] {
      return clusters.filter((cluster) => !progress.adjudicatedClusterKeys.has(buildScopedClusterKey(cluster)));
    },

    markAdjudicated(entryIds): void {
      const nextAdjudicated = new Set(progress.adjudicatedClusterKeys);

      for (const entryId of entryIds) {
        const clusterKeys = entryToClusterKeys.get(entryId.trim());
        if (!clusterKeys) {
          continue;
        }

        for (const clusterKey of clusterKeys) {
          nextAdjudicated.add(clusterKey);
        }
      }

      progress = {
        ...progress,
        adjudicatedClusterKeys: nextAdjudicated,
      };
    },

    snapshot(): SurgeonSupersessionReviewProgress {
      const claimKeyClustersAdjudicated = countScopedClusters(progress.adjudicatedClusterKeys, "claim_key");
      const subjectClustersAdjudicated = countScopedClusters(progress.adjudicatedClusterKeys, "subject");

      return {
        claimKeyClustersViewed: progress.claimKeyViewedKeys.size,
        claimKeyClustersTotal: progress.claimKeyTotal,
        claimKeyClustersAdjudicated,
        claimKeyScopeExhausted: progress.claimKeyScopeExhausted,
        subjectClustersViewed: progress.subjectViewedKeys.size,
        subjectClustersTotal: progress.subjectTotal,
        subjectClustersAdjudicated,
        subjectScopeExhausted: progress.subjectScopeExhausted,
        adjudicatedClusters: progress.adjudicatedClusterKeys.size,
        widenedBeforeClaimKeyExhausted: progress.widenedBeforeClaimKeyExhausted,
      };
    },
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
    actionable: {
      maxWindowEnd: 0,
      totalCount: null,
      sawExhaustedPage: false,
    },
    all: {
      maxWindowEnd: 0,
      totalCount: null,
      sawExhaustedPage: false,
    },
  };
}

/**
 * Internal mutable supersession-progress state.
 */
interface MutableSupersessionProgress {
  claimKeyTotal: number;
  subjectTotal: number;
  claimKeyViewedKeys: Set<string>;
  subjectViewedKeys: Set<string>;
  adjudicatedClusterKeys: Set<string>;
  claimKeyScopeExhausted: boolean;
  subjectScopeExhausted: boolean;
  widenedBeforeClaimKeyExhausted: boolean;
}

/**
 * Builds the zeroed supersession-progress snapshot used for tracker initialization.
 *
 * @param input - Initial cluster totals discovered before the run started.
 * @returns Empty supersession progress snapshot.
 */
function createEmptySupersessionProgress(input: { claimKeyTotal: number; subjectTotal: number }): MutableSupersessionProgress {
  const claimKeyTotal = normalizeCount(input.claimKeyTotal);
  const subjectTotal = normalizeCount(input.subjectTotal);

  return {
    claimKeyTotal,
    subjectTotal,
    claimKeyViewedKeys: new Set<string>(),
    subjectViewedKeys: new Set<string>(),
    adjudicatedClusterKeys: new Set<string>(),
    claimKeyScopeExhausted: claimKeyTotal === 0,
    subjectScopeExhausted: subjectTotal === 0,
    widenedBeforeClaimKeyExhausted: false,
  };
}

/**
 * Clones the entry-to-cluster mapping used by the supersession tracker.
 *
 * @param input - Existing mapping from entry IDs to cluster keys.
 * @returns Deep-cloned mapping safe for mutation.
 */
function cloneEntryClusterMap(input: Map<string, Set<string>>): Map<string, Set<string>> {
  return new Map([...input.entries()].map(([entryId, clusterKeys]) => [entryId, new Set(clusterKeys)]));
}

/**
 * Builds the stable scoped key used to dedupe supersession clusters.
 *
 * @param cluster - Cluster to identify.
 * @returns Stable key with grouping-family prefix.
 */
function buildScopedClusterKey(cluster: SurgeonSupersessionCluster): string {
  return `${cluster.groupedBy}:${cluster.groupKey}`;
}

/**
 * Counts adjudicated cluster keys for one grouping family.
 *
 * @param clusterKeys - Recorded adjudicated cluster keys.
 * @param scope - Grouping family to count.
 * @returns Number of adjudicated clusters for the requested family.
 */
function countScopedClusters(clusterKeys: Set<string>, scope: "claim_key" | "subject"): number {
  const prefix = `${scope}:`;
  let count = 0;

  for (const clusterKey of clusterKeys) {
    if (clusterKey.startsWith(prefix)) {
      count += 1;
    }
  }

  return count;
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

/**
 * Normalizes an optional count into a safe non-negative integer.
 *
 * @param value - Optional count input.
 * @returns Zero when absent, otherwise the normalized count.
 */
function normalizeOptionalCount(value: number | undefined): number {
  return value === undefined ? 0 : normalizeCount(value);
}
