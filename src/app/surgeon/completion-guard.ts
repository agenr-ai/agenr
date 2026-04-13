import type { SurgeonSupersessionCluster } from "./ports.js";

/**
 * Snapshot of pagination progress for one repeated candidate query.
 */
export interface PaginatedQueryProgress {
  queryCalls: number;
  reviewedEntryCount: number;
  actionable: {
    maxWindowEnd: number;
    totalCount: number | null;
    sawExhaustedPage: boolean;
    nextOffset: number | null;
  };
  all: {
    maxWindowEnd: number;
    totalCount: number | null;
    sawExhaustedPage: boolean;
    nextOffset: number | null;
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
  recordPage(input: {
    scope: "actionable" | "all";
    offset: number;
    returnedCount: number;
    totalCount?: number;
    exhausted: boolean;
    nextOffset?: number | null;
    entryIds?: string[];
  }): void;

  /**
   * Checks whether an entry ID appeared in a previously paged result.
   *
   * @param entryId - Entry ID to validate.
   * @returns True when the entry was observed in this run.
   */
  hasSeenEntry(entryId: string): boolean;

  /**
   * Marks one or more paged entries as explicitly reviewed in the current run.
   *
   * @param entryIds - Entry IDs that were inspected or otherwise reviewed.
   */
  recordReviewedEntries(entryIds: string[]): void;

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
  claimKeyClustersRemaining: number;
  claimKeyClustersAdjudicated: number;
  claimKeyScopeExhausted: boolean;
  subjectClustersViewed: number;
  subjectClustersTotal: number;
  subjectClustersRemaining: number;
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
   * @param input - Scope, remaining unpaged counts after this page, and returned clusters for the page.
   */
  recordPage(input: {
    scope: "claim_key" | "subject" | "all";
    claimKeyRemaining: number;
    subjectRemaining: number;
    clusters: SurgeonSupersessionCluster[];
  }): void;

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
   * Builds a progress snapshot as if the provided entries were adjudicated.
   *
   * @param entryIds - Entry IDs that would count as adjudicated.
   * @returns Review progress without mutating tracker state.
   */
  previewAdjudication(entryIds: string[]): SurgeonSupersessionReviewProgress;

  /**
   * Checks whether an entry ID appeared in a previously paged cluster.
   *
   * @param entryId - Entry ID to validate.
   * @returns True when the entry was observed in this run.
   */
  hasSeenEntry(entryId: string): boolean;

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
  let seenEntryIds = new Set<string>();
  let reviewedEntryIds = new Set<string>();

  return {
    reset(): void {
      progress = createEmptyProgress();
      seenEntryIds = new Set<string>();
      reviewedEntryIds = new Set<string>();
    },

    recordPage(input): void {
      const scope = input.scope === "all" ? "all" : "actionable";
      const offset = normalizeCount(input.offset);
      const returnedCount = normalizeCount(input.returnedCount);
      const totalCount = input.totalCount === undefined ? null : normalizeCount(input.totalCount);
      const scopedProgress = progress[scope];
      const nextOffset = input.exhausted || input.nextOffset === null || input.nextOffset === undefined ? null : normalizeCount(input.nextOffset);

      progress = {
        queryCalls: progress.queryCalls + 1,
        reviewedEntryCount: reviewedEntryIds.size,
        actionable:
          scope === "actionable"
            ? {
                maxWindowEnd: Math.max(scopedProgress.maxWindowEnd, offset + returnedCount),
                totalCount: totalCount ?? scopedProgress.totalCount,
                sawExhaustedPage: scopedProgress.sawExhaustedPage || input.exhausted,
                nextOffset,
              }
            : progress.actionable,
        all:
          scope === "all"
            ? {
                maxWindowEnd: Math.max(scopedProgress.maxWindowEnd, offset + returnedCount),
                totalCount: totalCount ?? scopedProgress.totalCount,
                sawExhaustedPage: scopedProgress.sawExhaustedPage || input.exhausted,
                nextOffset,
              }
            : progress.all,
      };
      for (const entryId of input.entryIds ?? []) {
        const normalizedEntryId = entryId.trim();
        if (normalizedEntryId) {
          seenEntryIds.add(normalizedEntryId);
        }
      }
    },

    hasSeenEntry(entryId: string): boolean {
      return seenEntryIds.has(entryId.trim());
    },

    recordReviewedEntries(entryIds: string[]): void {
      for (const entryId of entryIds) {
        const normalizedEntryId = entryId.trim();
        if (!normalizedEntryId || !seenEntryIds.has(normalizedEntryId)) {
          continue;
        }
        reviewedEntryIds.add(normalizedEntryId);
      }
      progress = {
        ...progress,
        reviewedEntryCount: reviewedEntryIds.size,
      };
    },

    snapshot(): PaginatedQueryProgress {
      return {
        queryCalls: progress.queryCalls,
        reviewedEntryCount: progress.reviewedEntryCount,
        actionable: { ...progress.actionable },
        all: { ...progress.all },
      };
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

    recordPage({ scope, claimKeyRemaining, subjectRemaining, clusters }): void {
      const normalizedClaimKeyRemaining = normalizeCount(claimKeyRemaining);
      const normalizedSubjectRemaining = normalizeCount(subjectRemaining);
      const nextClaimKeyViewed = new Set(progress.claimKeyViewedKeys);
      const nextSubjectViewed = new Set(progress.subjectViewedKeys);
      const nextEntryMap = cloneEntryClusterMap(entryToClusterKeys);
      const wideningIntoSubject = (scope === "subject" || scope === "all") && !progress.claimKeyScopeExhausted && progress.claimKeyRemainingTotal > 0;

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

      const claimKeyClustersAdjudicated = countScopedClusters(progress.adjudicatedClusterKeys, "claim_key");
      const subjectClustersAdjudicated = countScopedClusters(progress.adjudicatedClusterKeys, "subject");
      progress = {
        claimKeyTotal: Math.max(progress.claimKeyTotal, normalizedClaimKeyRemaining + claimKeyClustersAdjudicated),
        subjectTotal: Math.max(progress.subjectTotal, normalizedSubjectRemaining + subjectClustersAdjudicated),
        claimKeyRemainingTotal: normalizedClaimKeyRemaining,
        subjectRemainingTotal: normalizedSubjectRemaining,
        claimKeyViewedKeys: nextClaimKeyViewed,
        subjectViewedKeys: nextSubjectViewed,
        adjudicatedClusterKeys: new Set(progress.adjudicatedClusterKeys),
        claimKeyScopeExhausted: normalizedClaimKeyRemaining === 0,
        subjectScopeExhausted: normalizedSubjectRemaining === 0,
        widenedBeforeClaimKeyExhausted: progress.widenedBeforeClaimKeyExhausted || wideningIntoSubject,
      };
      entryToClusterKeys = nextEntryMap;
    },

    filterPendingClusters(clusters): SurgeonSupersessionCluster[] {
      return clusters.filter((cluster) => !progress.adjudicatedClusterKeys.has(buildScopedClusterKey(cluster)));
    },

    markAdjudicated(entryIds): void {
      progress = applyAdjudicatedEntries(progress, entryIds, entryToClusterKeys);
    },

    hasSeenEntry(entryId: string): boolean {
      return entryToClusterKeys.has(entryId.trim());
    },

    previewAdjudication(entryIds): SurgeonSupersessionReviewProgress {
      return buildSupersessionProgressSnapshot(applyAdjudicatedEntries(progress, entryIds, entryToClusterKeys));
    },

    snapshot(): SurgeonSupersessionReviewProgress {
      return buildSupersessionProgressSnapshot(progress);
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
    reviewedEntryCount: 0,
    actionable: {
      maxWindowEnd: 0,
      totalCount: null,
      sawExhaustedPage: false,
      nextOffset: null,
    },
    all: {
      maxWindowEnd: 0,
      totalCount: null,
      sawExhaustedPage: false,
      nextOffset: null,
    },
  };
}

/**
 * Internal mutable supersession-progress state.
 */
interface MutableSupersessionProgress {
  claimKeyTotal: number;
  subjectTotal: number;
  claimKeyRemainingTotal: number;
  subjectRemainingTotal: number;
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
    claimKeyRemainingTotal: claimKeyTotal,
    subjectRemainingTotal: subjectTotal,
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
 * Applies additional adjudicated entry IDs without mutating existing tracker state.
 *
 * @param progress - Existing mutable review progress.
 * @param entryIds - Entry IDs that should count as adjudicated.
 * @param entryToClusterKeys - Mapping from seen entries to their cluster keys.
 * @returns Updated progress snapshot.
 */
function applyAdjudicatedEntries(
  progress: MutableSupersessionProgress,
  entryIds: string[],
  entryToClusterKeys: Map<string, Set<string>>,
): MutableSupersessionProgress {
  const clusterKeys = collectClusterKeysForEntries(entryIds, entryToClusterKeys);
  if (clusterKeys.size === 0) {
    return progress;
  }

  const nextAdjudicated = new Set(progress.adjudicatedClusterKeys);
  let newlyAdjudicatedClaimKey = 0;
  let newlyAdjudicatedSubject = 0;

  for (const clusterKey of clusterKeys) {
    if (nextAdjudicated.has(clusterKey)) {
      continue;
    }

    nextAdjudicated.add(clusterKey);
    if (clusterKey.startsWith("claim_key:")) {
      newlyAdjudicatedClaimKey += 1;
      continue;
    }
    if (clusterKey.startsWith("subject:")) {
      newlyAdjudicatedSubject += 1;
    }
  }

  if (newlyAdjudicatedClaimKey === 0 && newlyAdjudicatedSubject === 0) {
    return progress;
  }

  const claimKeyRemainingTotal = Math.max(0, progress.claimKeyRemainingTotal - newlyAdjudicatedClaimKey);
  const subjectRemainingTotal = Math.max(0, progress.subjectRemainingTotal - newlyAdjudicatedSubject);
  return {
    ...progress,
    adjudicatedClusterKeys: nextAdjudicated,
    claimKeyRemainingTotal,
    subjectRemainingTotal,
    claimKeyScopeExhausted: claimKeyRemainingTotal === 0,
    subjectScopeExhausted: subjectRemainingTotal === 0,
  };
}

/**
 * Collects scoped cluster keys for the provided entry IDs.
 *
 * @param entryIds - Entry IDs to resolve.
 * @param entryToClusterKeys - Mapping from seen entries to their cluster keys.
 * @returns Unique scoped cluster keys tied to the entries.
 */
function collectClusterKeysForEntries(entryIds: string[], entryToClusterKeys: Map<string, Set<string>>): Set<string> {
  const clusterKeys = new Set<string>();

  for (const entryId of entryIds) {
    const normalizedEntryId = entryId.trim();
    if (!normalizedEntryId) {
      continue;
    }

    const resolvedClusterKeys = entryToClusterKeys.get(normalizedEntryId);
    if (!resolvedClusterKeys) {
      continue;
    }

    for (const clusterKey of resolvedClusterKeys) {
      clusterKeys.add(clusterKey);
    }
  }

  return clusterKeys;
}

/**
 * Converts mutable tracker state into the public review-progress snapshot.
 *
 * @param progress - Mutable supersession review progress.
 * @returns Immutable snapshot for reporting and completion guards.
 */
function buildSupersessionProgressSnapshot(progress: MutableSupersessionProgress): SurgeonSupersessionReviewProgress {
  const claimKeyClustersAdjudicated = countScopedClusters(progress.adjudicatedClusterKeys, "claim_key");
  const subjectClustersAdjudicated = countScopedClusters(progress.adjudicatedClusterKeys, "subject");

  return {
    claimKeyClustersViewed: progress.claimKeyViewedKeys.size,
    claimKeyClustersTotal: Math.max(progress.claimKeyTotal, progress.claimKeyViewedKeys.size),
    claimKeyClustersRemaining: progress.claimKeyRemainingTotal,
    claimKeyClustersAdjudicated,
    claimKeyScopeExhausted: progress.claimKeyScopeExhausted,
    subjectClustersViewed: progress.subjectViewedKeys.size,
    subjectClustersTotal: Math.max(progress.subjectTotal, progress.subjectViewedKeys.size),
    subjectClustersRemaining: progress.subjectRemainingTotal,
    subjectClustersAdjudicated,
    subjectScopeExhausted: progress.subjectScopeExhausted,
    adjudicatedClusters: progress.adjudicatedClusterKeys.size,
    widenedBeforeClaimKeyExhausted: progress.widenedBeforeClaimKeyExhausted,
  };
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
