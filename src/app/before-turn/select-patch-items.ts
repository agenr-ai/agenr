import type { BeforeTurnPatchDiagnostics, BeforeTurnPatchItem, BeforeTurnPolicy } from "./types.js";

/**
 * Applies the before-turn durable cap, optionally expanding for uniformly high-confidence items.
 *
 * @param items - Ranked durable items returned from recall.
 * @param policy - Effective before-turn policy.
 * @param diagnostics - Mutable diagnostics sink updated in place.
 * @returns Final bounded durable set for prompt rendering.
 */
export function selectDurablePatchItems(
  items: BeforeTurnPatchItem[],
  policy: Required<BeforeTurnPolicy>,
  diagnostics: BeforeTurnPatchDiagnostics,
): BeforeTurnPatchItem[] {
  if (policy.maxDurableEntries <= 0 || items.length === 0) {
    return [];
  }

  const boundedItems = items.slice(0, policy.maxDurableEntries);
  const expandedLimit = Math.max(policy.maxDurableEntries, policy.maxHighConfidenceDurableEntries);
  if (expandedLimit <= policy.maxDurableEntries || items.length <= policy.maxDurableEntries) {
    return boundedItems;
  }

  const expansionCandidates = items.slice(0, expandedLimit);
  const canExpand =
    expansionCandidates.length > policy.maxDurableEntries && expansionCandidates.every((item) => item.score >= policy.highConfidenceRecallThreshold);
  if (canExpand) {
    diagnostics.notices.push(`Before-turn durable recall expanded to ${expansionCandidates.length} high-confidence items.`);
    return expansionCandidates;
  }

  diagnostics.notices.push(
    `Before-turn durable recall kept the top ${boundedItems.length} item${
      boundedItems.length === 1 ? "" : "s"
    } because additional candidates were not high confidence.`,
  );
  return boundedItems;
}
