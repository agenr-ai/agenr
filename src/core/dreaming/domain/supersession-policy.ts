/**
 * Minimal cluster member shape needed for supersession suppression policy.
 */
export interface DreamSupersessionPolicyDurable {
  id: string;
}

/**
 * Minimal supersession-cluster shape needed for suppression policy.
 */
export interface DreamSupersessionPolicyCluster<DurableShape extends DreamSupersessionPolicyDurable = DreamSupersessionPolicyDurable> {
  entries: DurableShape[];
}

/**
 * Filters out clusters whose every member was already skipped in a recent supersession run.
 *
 * @param clusters - Candidate clusters assembled for the current query.
 * @param skippedDurableIds - Durable IDs that were recently skipped by supersession.
 * @returns Clusters that still need operator or model attention.
 */
export function filterSupersessionClustersBySkippedDurableIds<
  ClusterShape extends DreamSupersessionPolicyCluster<DurableShape>,
  DurableShape extends DreamSupersessionPolicyDurable,
>(clusters: ClusterShape[], skippedDurableIds: ReadonlySet<string>): ClusterShape[] {
  if (clusters.length === 0 || skippedDurableIds.size === 0) {
    return clusters;
  }

  return clusters.filter((cluster) => cluster.entries.some((entry) => !skippedDurableIds.has(entry.id)));
}
