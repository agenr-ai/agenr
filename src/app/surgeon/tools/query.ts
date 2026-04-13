import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import type { SurgeonToolDeps } from "./index.js";
import { toolResult } from "./shared.js";

const QUERY_CANDIDATES_SCHEMA = Type.Object({
  scope: Type.Optional(
    Type.String({
      description: "Candidate scope. 'actionable' (default) filters to high-yield retirement candidates. 'all' returns the full pool.",
    }),
  ),
  type: Type.Optional(Type.String()),
  importance_max: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  min_age_days: Type.Optional(Type.Integer({ minimum: 0 })),
  project: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

/** Validated parameter payload for the candidate-query tool. */
type QueryCandidatesParams = Static<typeof QUERY_CANDIDATES_SCHEMA>;

/** Supported candidate-query scopes. */
type QueryCandidateScope = "actionable" | "all";

/**
 * Creates the retirement-candidate paging tool.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Agent tool that pages retirement candidates with hard protections.
 */
export function createQueryCandidatesTool(deps: SurgeonToolDeps): AgentTool<typeof QUERY_CANDIDATES_SCHEMA> {
  return {
    name: "query_candidates",
    label: "Query retirement candidates",
    description: "List active retirement candidates. Default scope is the actionable high-yield subset.",
    parameters: QUERY_CANDIDATES_SCHEMA,
    async execute(_toolCallId, params: QueryCandidatesParams) {
      const scope = normalizeScope(params.scope);
      const limit = normalizeLimit(params.limit);
      const offset = normalizeOffset(params.offset);
      const page = await deps.port.listRetirementCandidates({
        scope,
        type: normalizeOptionalString(params.type),
        importanceMax: params.importance_max,
        minAgeDays: params.min_age_days,
        project: normalizeOptionalString(params.project) ?? deps.project,
        limit,
        offset,
        protectRecalledDays: deps.protection.protectRecalledDays,
        protectMinImportance: deps.protection.protectMinImportance,
        skipRecentlyEvaluatedDays: deps.skipRecentlyEvaluatedDays,
        runId: deps.runId,
        now: deps.now(),
      });

      deps.completionGuards?.retirement.recordPage({
        scope: page.scope,
        offset,
        returnedCount: page.candidates.length,
        totalCount: page.availableCount,
        exhausted: page.scopeExhausted,
        nextOffset: page.nextOffset,
        entryIds: page.candidates.map((candidate) => candidate.id),
      });

      if (page.candidates.length === 0) {
        return toolResult({
          candidates: [],
          count: 0,
          scope: page.scope,
          limit: page.limit,
          offset: page.offset,
          totalMatching: page.totalMatching,
          availableCount: page.availableCount,
          recentlyEvaluatedFilteredCount: page.recentlyEvaluatedFilteredCount,
          scopeExhausted: page.scopeExhausted,
          nextOffset: page.nextOffset,
          message:
            page.scope === "actionable"
              ? "No more candidates match the actionable scope. Consider widening to scope = 'all' before completing the pass."
              : "No more candidates match the current filters. The candidate pool appears exhausted.",
        });
      }

      return toolResult({
        candidates: page.candidates,
        count: page.candidates.length,
        scope: page.scope,
        limit: page.limit,
        offset: page.offset,
        totalMatching: page.totalMatching,
        availableCount: page.availableCount,
        recentlyEvaluatedFilteredCount: page.recentlyEvaluatedFilteredCount,
        scopeExhausted: page.scopeExhausted,
        nextOffset: page.nextOffset,
      });
    },
  };
}

/**
 * Normalizes the requested page size.
 *
 * @param value - Raw limit input.
 * @returns Safe candidate page size.
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
 * Normalizes the requested candidate scope to the supported values.
 *
 * @param value - Raw scope input.
 * @returns Supported candidate scope.
 */
function normalizeScope(value: string | undefined): QueryCandidateScope {
  return value === "all" ? "all" : "actionable";
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
