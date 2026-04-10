import type { AgentTool } from "@mariozechner/pi-agent-core";
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

      const [claimKeyClusters, subjectClusters] = await Promise.all([
        deps.port.listSupersessionCandidates({
          scope: "claim_key",
          type,
        }),
        deps.port.listSupersessionCandidates({
          scope: "subject",
          type,
        }),
      ]);

      const allClusters = scope === "claim_key" ? claimKeyClusters : scope === "subject" ? subjectClusters : [...claimKeyClusters, ...subjectClusters];
      const clusters = allClusters.slice(offset, offset + limit);

      deps.completionGuards?.supersession.recordPage({
        scope,
        claimKeyTotal: claimKeyClusters.length,
        subjectTotal: subjectClusters.length,
        clusters,
      });

      if (clusters.length === 0) {
        return toolResult({
          clusters: [],
          count: 0,
          scope,
          limit,
          offset,
          claimKeyClusterCount: claimKeyClusters.length,
          subjectClusterCount: subjectClusters.length,
          message: buildEmptyResultMessage(scope),
        });
      }

      return toolResult({
        clusters,
        count: clusters.length,
        scope,
        limit,
        offset,
        claimKeyClusterCount: claimKeyClusters.length,
        subjectClusterCount: subjectClusters.length,
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
