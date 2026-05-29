import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import type { SurgeonToolDeps } from "./index.js";
import { toolResult } from "./shared.js";

const QUERY_SUPERSESSION_CANDIDATES_SCHEMA = Type.Object({
  scope: Type.Optional(
    Type.String({
      description: "Grouping strategy. 'claim_key' (default) groups by shared claim key. 'subject' groups by shared subject and type. 'all' returns both.",
    }),
  ),
  type: Type.Optional(Type.String({ description: "Filter to a specific entry type." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum clusters to return." })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

/** Validated parameter payload for the supersession-query tool. */
type QuerySupersessionCandidatesParams = Static<typeof QUERY_SUPERSESSION_CANDIDATES_SCHEMA>;

/** Supported supersession grouping scopes. */
type SupersessionCandidateScope = "claim_key" | "subject" | "all";

/**
 * Creates the supersession-candidate paging tool.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Agent tool that pages supersession candidate clusters.
 */
export function createQuerySupersessionCandidatesTool(deps: SurgeonToolDeps): AgentTool<typeof QUERY_SUPERSESSION_CANDIDATES_SCHEMA> {
  return {
    name: "query_supersession_candidates",
    label: "Query supersession candidates",
    description: "List active candidate clusters for supersession review. Default scope is claim_key.",
    parameters: QUERY_SUPERSESSION_CANDIDATES_SCHEMA,
    async execute(_toolCallId, params: QuerySupersessionCandidatesParams) {
      const scope = normalizeScope(params.scope);
      const limit = normalizeLimit(params.limit);
      const offset = normalizeOffset(params.offset);
      const type = normalizeOptionalString(params.type);
      const progress = deps.completionGuards?.supersession.snapshot();

      if ((scope === "subject" || scope === "all") && shouldBlockLowerConfidenceScope(progress)) {
        return toolResult({
          clusters: [],
          count: 0,
          scope,
          limit,
          offset,
          claimKeyClusterCount: progress?.claimKeyClustersRemaining ?? 0,
          subjectClusterCount: progress?.subjectClustersRemaining ?? 0,
          blocked: true,
          message: buildClaimKeyFirstMessage(progress!.claimKeyClustersRemaining),
        });
      }

      const counts = await deps.port.countSupersessionCandidates({
        type,
        skipRecentlyEvaluatedDays: deps.skipRecentlyEvaluatedDays,
        now: deps.now(),
      });

      const claimKeyClusters =
        scope === "subject"
          ? []
          : await deps.port.listSupersessionCandidates({
              scope: "claim_key",
              type,
              skipRecentlyEvaluatedDays: deps.skipRecentlyEvaluatedDays,
              now: deps.now(),
            });
      const subjectClusters =
        scope === "claim_key"
          ? []
          : await deps.port.listSupersessionCandidates({
              scope: "subject",
              type,
              skipRecentlyEvaluatedDays: deps.skipRecentlyEvaluatedDays,
              now: deps.now(),
            });

      const pendingClaimKeyClusters = deps.completionGuards?.supersession.filterPendingClusters(claimKeyClusters) ?? claimKeyClusters;
      const pendingSubjectClusters = deps.completionGuards?.supersession.filterPendingClusters(subjectClusters) ?? subjectClusters;
      const claimKeyClusterCount = scope === "subject" ? (progress?.claimKeyClustersRemaining ?? counts.claimKeyCount) : pendingClaimKeyClusters.length;
      const subjectClusterCount = scope === "claim_key" ? (progress?.subjectClustersRemaining ?? counts.subjectCount) : pendingSubjectClusters.length;
      const allClusters =
        scope === "claim_key"
          ? pendingClaimKeyClusters
          : scope === "subject"
            ? pendingSubjectClusters
            : [...pendingClaimKeyClusters, ...pendingSubjectClusters];
      const clusters = allClusters.slice(offset, offset + limit);
      const remainingClusters = allClusters.slice(Math.min(allClusters.length, offset + clusters.length));
      const claimKeyRemaining = scope === "subject" ? claimKeyClusterCount : countClustersByGrouping(remainingClusters, "claim_key");
      const subjectRemaining = scope === "claim_key" ? subjectClusterCount : countClustersByGrouping(remainingClusters, "subject");

      deps.completionGuards?.supersession.recordPage({
        scope,
        claimKeyRemaining,
        subjectRemaining,
        clusters,
      });

      if (clusters.length === 0) {
        return toolResult({
          clusters: [],
          count: 0,
          scope,
          limit,
          offset,
          claimKeyClusterCount,
          subjectClusterCount,
          message: buildEmptyResultMessage(scope),
        });
      }

      return toolResult({
        clusters,
        count: clusters.length,
        scope,
        limit,
        offset,
        claimKeyClusterCount,
        subjectClusterCount,
        exhausted: offset + clusters.length >= allClusters.length,
      });
    },
  };
}

/**
 * Builds the tool guidance returned for an empty supersession page.
 *
 * @param scope - Queried grouping scope.
 * @returns Human-readable next-step guidance.
 */
function buildEmptyResultMessage(scope: SupersessionCandidateScope): string {
  if (scope === "claim_key") {
    return "No more claim_key clusters remain. If budget allows, widen to scope = 'subject'.";
  }

  if (scope === "subject") {
    return "No more subject clusters remain. The subject sweep appears exhausted.";
  }

  return "No more supersession clusters match the current filters. The review pool appears exhausted.";
}

/**
 * Returns whether lower-confidence supersession scopes should remain blocked.
 *
 * @param progress - Current same-run supersession review progress, if any.
 * @returns True when the claim_key sweep still has work remaining.
 */
function shouldBlockLowerConfidenceScope(progress: { claimKeyScopeExhausted: boolean; claimKeyClustersRemaining: number } | undefined): boolean {
  if (!progress) {
    return false;
  }

  return !progress.claimKeyScopeExhausted && progress.claimKeyClustersRemaining > 0;
}

/**
 * Builds the guidance returned when the model tries to widen too early.
 *
 * @param remainingClaimKeyClusters - Claim-key clusters that still need adjudication.
 * @returns Human-readable claim-key-first reminder.
 */
function buildClaimKeyFirstMessage(remainingClaimKeyClusters: number): string {
  return remainingClaimKeyClusters === 1
    ? "The subject sweep is blocked until the claim_key sweep is exhausted. One claim_key cluster still remains - continue with scope = 'claim_key'."
    : `The subject sweep is blocked until the claim_key sweep is exhausted. ${remainingClaimKeyClusters} claim_key clusters still remain - continue with scope = 'claim_key'.`;
}

/**
 * Normalizes the requested page size.
 *
 * @param value - Raw limit input.
 * @returns Safe supersession page size.
 */
function normalizeLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 20;
  }

  return Math.floor(value);
}

/**
 * Normalizes the requested candidate offset.
 *
 * @param value - Raw offset input.
 * @returns Safe non-negative page offset.
 */
function normalizeOffset(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.floor(value);
}

/**
 * Normalizes the requested supersession scope to a supported value.
 *
 * @param value - Raw scope input.
 * @returns Supported candidate scope.
 */
function normalizeScope(value: string | undefined): SupersessionCandidateScope {
  if (value === "subject" || value === "all") {
    return value;
  }

  return "claim_key";
}

/**
 * Trims optional string input and drops empty values.
 *
 * @param value - Raw string input.
 * @returns Trimmed value, or undefined when empty.
 */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/**
 * Counts clusters grouped by the requested supersession family.
 *
 * @param clusters - Cluster page or remainder window to count.
 * @param groupedBy - Grouping family to count.
 * @returns Number of clusters in the requested grouping family.
 */
function countClustersByGrouping(clusters: Array<{ groupedBy: "claim_key" | "subject" }>, groupedBy: "claim_key" | "subject"): number {
  let count = 0;
  for (const cluster of clusters) {
    if (cluster.groupedBy === groupedBy) {
      count += 1;
    }
  }

  return count;
}
