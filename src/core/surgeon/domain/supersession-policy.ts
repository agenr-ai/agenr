/**
 * Minimal cluster member shape needed for supersession suppression policy.
 */
export interface SurgeonSupersessionPolicyEntry {
  id: string;
}

/**
 * Minimal supersession-cluster shape needed for suppression policy.
 */
export interface SurgeonSupersessionPolicyCluster<EntryShape extends SurgeonSupersessionPolicyEntry = SurgeonSupersessionPolicyEntry> {
  entries: EntryShape[];
}

/**
 * Filters out clusters whose every member was already skipped in a recent supersession run.
 *
 * @param clusters - Candidate clusters assembled for the current query.
 * @param skippedEntryIds - Entry IDs that were recently skipped by supersession.
 * @returns Clusters that still need operator or model attention.
 */
export function filterSupersessionClustersBySkippedEntryIds<
  ClusterShape extends SurgeonSupersessionPolicyCluster<EntryShape>,
  EntryShape extends SurgeonSupersessionPolicyEntry,
>(clusters: ClusterShape[], skippedEntryIds: ReadonlySet<string>): ClusterShape[] {
  if (clusters.length === 0 || skippedEntryIds.size === 0) {
    return clusters;
  }

  return clusters.filter((cluster) => cluster.entries.some((entry) => !skippedEntryIds.has(entry.id)));
}
