import type { Row } from "@libsql/client";

import type { Entry } from "../../core/types.js";
import {
  compareRetirementCandidates,
  isActionableRetirementCandidate,
  SURGEON_RETIREMENT_RECENT_EVALUATION_ACTION_TYPES,
  SURGEON_RETIREMENT_SAME_RUN_SUPPRESSION_ACTION_TYPES,
} from "../../core/surgeon/domain/retirement-policy.js";
import { filterSupersessionClustersBySkippedEntryIds } from "../../core/surgeon/domain/supersession-policy.js";
import {
  buildActiveEntryClause,
  deserializeTags,
  ENTRY_SELECT_COLUMNS,
  mapEntryRow,
  readBoolean,
  readNumber,
  readOptionalString,
  readRequiredString,
} from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Aggregate corpus health summary used by surgeon startup and status tools.
 */
export interface SurgeonHealthStats {
  total: number;
  byType: Record<string, number>;
  claimKeyLifecycle: {
    trusted: number;
    tentative: number;
    unresolved: number;
    /** Legacy rows with a canonical claim key but no lifecycle status yet. */
    legacy: number;
    noKey: number;
  };
  /** Count of durable unresolved surgeon proposals awaiting review. */
  proposalBacklogCount: number;
  /** Open proposals that are already safe to apply. */
  eligibleProposalBacklogCount: number;
  /** Oldest still-open proposal creation timestamp, when one exists. */
  oldestOpenProposalCreatedAt: string | null;
  recency: {
    last7: number;
    last30: number;
    d30To90: number;
    d90Plus: number;
  };
  recall: {
    never: number;
    oneToFive: number;
    fivePlus: number;
  };
  quality: {
    high: number;
    medium: number;
    low: number;
    average: number;
  };
  retirementCandidateCount: number;
  retirementAvailableActionableCount: number;
  retirementAvailableAllCount: number;
  /** Candidates that were recently evaluated and will be skipped on the next run. */
  recentlyEvaluatedCount: number;
}

/**
 * Shared retirement candidate count snapshots used for startup, health, and scheduling.
 */
export interface SurgeonRetirementCandidateCounts {
  rawActionableCount: number;
  availableActionableCount: number;
  availableAllCount: number;
  recentlyEvaluatedFilteredCount: number;
}

/**
 * Query options for listing retirement candidates.
 */
export interface SurgeonCandidateQuery {
  scope?: "actionable" | "all";
  type?: string;
  importanceMax?: number;
  minAgeDays?: number;
  limit?: number;
  offset?: number;
  protectRecalledDays: number;
  protectMinImportance: number;
  skipRecentlyEvaluatedDays?: number;
  runId?: string;
  project?: string;
  now?: Date;
}

/**
 * Lightweight candidate summary returned to the surgeon candidate tool.
 */
export interface SurgeonCandidateSummary {
  id: string;
  subject: string;
  type: string;
  importance: number;
  qualityScore: number;
  expiry: string;
  createdAt: string;
  updatedAt: string;
  recallCount: number;
  lastRecalledAt: string | null;
  tags: string[];
}

/**
 * One paged retirement-candidate response enriched with count metadata.
 */
export interface SurgeonCandidatePage {
  candidates: SurgeonCandidateSummary[];
  totalMatching: number;
  availableCount: number;
  recentlyEvaluatedFilteredCount: number;
  scope: "actionable" | "all";
  limit: number;
  offset: number;
  scopeExhausted: boolean;
  nextOffset: number | null;
}

/**
 * Current supersession-cluster counts across claim-key and subject scopes.
 */
export interface SurgeonSupersessionCandidateCounts {
  claimKeyCount: number;
  subjectCount: number;
}

/**
 * Query options for listing supersession candidate clusters.
 */
export interface SurgeonSupersessionCandidateQuery {
  scope: "claim_key" | "subject" | "all";
  type?: string;
  limit?: number;
  offset?: number;
  skipRecentlyEvaluatedDays?: number;
  now?: Date;
}

/**
 * One entry returned inside a supersession candidate cluster.
 */
export interface SurgeonSupersessionClusterEntry {
  id: string;
  subject: string;
  type: string;
  importance: number;
  expiry: string;
  createdAt: string;
  content: string;
  claimKey: string | null;
  tags: string[];
}

/**
 * Group of active entries that may represent the same knowledge slot.
 */
export interface SurgeonSupersessionCluster {
  groupKey: string;
  groupedBy: "claim_key" | "subject";
  entries: SurgeonSupersessionClusterEntry[];
}

/**
 * Minimal entry summary used in surgeon inspection responses.
 */
export interface SurgeonEntrySummary {
  id: string;
  subject: string;
  type: string;
  importance: number;
  expiry: string;
  createdAt: string;
  retired: boolean;
}

/**
 * Detailed surgeon inspection payload for one entry.
 */
export interface SurgeonEntryInspection {
  entry: Entry;
  tags: string[];
  related: {
    sameSubject: SurgeonEntrySummary[];
    sameCluster: SurgeonEntrySummary[];
    supersedesCount: number;
    supersedesSample: SurgeonEntrySummary[];
  };
}

/**
 * Collects aggregate active-entry health stats for the surgeon.
 *
 * @param executor - SQL executor used for the lookups.
 * @param options - Retirement protection configuration and optional clock.
 * @returns Aggregate health summary for the active corpus.
 */
export async function getSurgeonHealthStats(
  executor: SqlExecutor,
  options: {
    protectRecalledDays: number;
    protectMinImportance: number;
    skipRecentlyEvaluatedDays?: number;
    now?: Date;
  },
): Promise<SurgeonHealthStats> {
  const now = options.now ?? new Date();
  const last7Cutoff = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const last30Cutoff = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const last90Cutoff = new Date(now.getTime() - 90 * DAY_MS).toISOString();

  const [totalResult, byTypeResult, lifecycleResult, proposalBacklogResult, recencyResult, recallResult, qualityResult, retirementCandidateCount] =
    await Promise.all([
      executor.execute({
        sql: `
        SELECT COUNT(*) AS total
        FROM entries AS e
        WHERE ${buildActiveEntryClause("e")}
      `,
      }),
      executor.execute({
        sql: `
        SELECT e.type, COUNT(*) AS entry_count
        FROM entries AS e
        WHERE ${buildActiveEntryClause("e")}
        GROUP BY e.type
      `,
      }),
      executor.execute({
        sql: `
        SELECT
          COALESCE(SUM(CASE WHEN e.claim_key_status = 'trusted' THEN 1 ELSE 0 END), 0) AS trusted_count,
          COALESCE(SUM(CASE WHEN e.claim_key_status = 'tentative' THEN 1 ELSE 0 END), 0) AS tentative_count,
          COALESCE(SUM(CASE WHEN e.claim_key_status = 'unresolved' THEN 1 ELSE 0 END), 0) AS unresolved_count,
          COALESCE(SUM(CASE WHEN e.claim_key_status IS NULL AND e.claim_key IS NOT NULL AND TRIM(e.claim_key) <> '' THEN 1 ELSE 0 END), 0) AS legacy_count,
          COALESCE(SUM(CASE WHEN e.claim_key_status IS NULL AND (e.claim_key IS NULL OR TRIM(e.claim_key) = '') THEN 1 ELSE 0 END), 0) AS no_key_count
        FROM entries AS e
        WHERE ${buildActiveEntryClause("e")}
      `,
      }),
      executor.execute({
        sql: `
        SELECT
          COALESCE(COUNT(*), 0) AS proposal_backlog_count,
          COALESCE(SUM(CASE WHEN eligible_for_apply = 1 THEN 1 ELSE 0 END), 0) AS eligible_proposal_backlog_count,
          MIN(created_at) AS oldest_open_proposal_created_at
        FROM (
          SELECT
            group_id,
            issue_kind,
            MIN(created_at) AS created_at,
            MAX(eligible_for_apply) AS eligible_for_apply
          FROM surgeon_run_proposals
          WHERE review_status = 'open'
          GROUP BY group_id, issue_kind
        ) AS open_issue_backlog
      `,
      }),
      executor.execute({
        sql: `
        SELECT
          COALESCE(SUM(CASE WHEN e.created_at >= ? THEN 1 ELSE 0 END), 0) AS last7,
          COALESCE(SUM(CASE WHEN e.created_at < ? AND e.created_at >= ? THEN 1 ELSE 0 END), 0) AS last30,
          COALESCE(SUM(CASE WHEN e.created_at < ? AND e.created_at >= ? THEN 1 ELSE 0 END), 0) AS d30_to_90,
          COALESCE(SUM(CASE WHEN e.created_at < ? THEN 1 ELSE 0 END), 0) AS d90_plus
        FROM entries AS e
        WHERE ${buildActiveEntryClause("e")}
      `,
        args: [last7Cutoff, last7Cutoff, last30Cutoff, last30Cutoff, last90Cutoff, last90Cutoff],
      }),
      executor.execute({
        sql: `
        SELECT
          COALESCE(SUM(CASE WHEN COALESCE(e.recall_count, 0) = 0 THEN 1 ELSE 0 END), 0) AS never_count,
          COALESCE(SUM(CASE WHEN COALESCE(e.recall_count, 0) BETWEEN 1 AND 5 THEN 1 ELSE 0 END), 0) AS one_to_five_count,
          COALESCE(SUM(CASE WHEN COALESCE(e.recall_count, 0) > 5 THEN 1 ELSE 0 END), 0) AS five_plus_count
        FROM entries AS e
        WHERE ${buildActiveEntryClause("e")}
      `,
      }),
      executor.execute({
        sql: `
        SELECT
          COALESCE(SUM(CASE WHEN COALESCE(e.quality_score, 0.5) >= 0.7 THEN 1 ELSE 0 END), 0) AS high_count,
          COALESCE(SUM(CASE WHEN COALESCE(e.quality_score, 0.5) >= 0.4 AND COALESCE(e.quality_score, 0.5) < 0.7 THEN 1 ELSE 0 END), 0) AS medium_count,
          COALESCE(SUM(CASE WHEN COALESCE(e.quality_score, 0.5) < 0.4 THEN 1 ELSE 0 END), 0) AS low_count,
          COALESCE(AVG(COALESCE(e.quality_score, 0.5)), 0) AS average_score
        FROM entries AS e
        WHERE ${buildActiveEntryClause("e")}
      `,
      }),
      countRetirementCandidates(executor, {
        protectRecalledDays: options.protectRecalledDays,
        protectMinImportance: options.protectMinImportance,
        skipRecentlyEvaluatedDays: options.skipRecentlyEvaluatedDays,
        now,
      }),
    ]);

  const totalRow = totalResult.rows[0];
  const lifecycleRow = lifecycleResult.rows[0];
  const proposalBacklogRow = proposalBacklogResult.rows[0];
  const recencyRow = recencyResult.rows[0];
  const recallRow = recallResult.rows[0];
  const qualityRow = qualityResult.rows[0];
  const byType: Record<string, number> = {};

  for (const row of byTypeResult.rows) {
    byType[readRequiredString(row, "type")] = readNumber(row, "entry_count", 0);
  }

  return {
    total: totalRow ? readNumber(totalRow, "total", 0) : 0,
    byType,
    claimKeyLifecycle: {
      trusted: lifecycleRow ? readNumber(lifecycleRow, "trusted_count", 0) : 0,
      tentative: lifecycleRow ? readNumber(lifecycleRow, "tentative_count", 0) : 0,
      unresolved: lifecycleRow ? readNumber(lifecycleRow, "unresolved_count", 0) : 0,
      legacy: lifecycleRow ? readNumber(lifecycleRow, "legacy_count", 0) : 0,
      noKey: lifecycleRow ? readNumber(lifecycleRow, "no_key_count", 0) : 0,
    },
    proposalBacklogCount: proposalBacklogRow ? readNumber(proposalBacklogRow, "proposal_backlog_count", 0) : 0,
    eligibleProposalBacklogCount: proposalBacklogRow ? readNumber(proposalBacklogRow, "eligible_proposal_backlog_count", 0) : 0,
    oldestOpenProposalCreatedAt: proposalBacklogRow ? (readOptionalString(proposalBacklogRow, "oldest_open_proposal_created_at") ?? null) : null,
    recency: {
      last7: recencyRow ? readNumber(recencyRow, "last7", 0) : 0,
      last30: recencyRow ? readNumber(recencyRow, "last30", 0) : 0,
      d30To90: recencyRow ? readNumber(recencyRow, "d30_to_90", 0) : 0,
      d90Plus: recencyRow ? readNumber(recencyRow, "d90_plus", 0) : 0,
    },
    recall: {
      never: recallRow ? readNumber(recallRow, "never_count", 0) : 0,
      oneToFive: recallRow ? readNumber(recallRow, "one_to_five_count", 0) : 0,
      fivePlus: recallRow ? readNumber(recallRow, "five_plus_count", 0) : 0,
    },
    quality: {
      high: qualityRow ? readNumber(qualityRow, "high_count", 0) : 0,
      medium: qualityRow ? readNumber(qualityRow, "medium_count", 0) : 0,
      low: qualityRow ? readNumber(qualityRow, "low_count", 0) : 0,
      average: qualityRow ? readNumber(qualityRow, "average_score", 0) : 0,
    },
    retirementCandidateCount: retirementCandidateCount.rawActionableCount,
    retirementAvailableActionableCount: retirementCandidateCount.availableActionableCount,
    retirementAvailableAllCount: retirementCandidateCount.availableAllCount,
    recentlyEvaluatedCount: retirementCandidateCount.recentlyEvaluatedFilteredCount,
  };
}

/**
 * Lists retirement candidates that are currently eligible under the supplied filters.
 *
 * Ordering is applied in application code so the prioritization logic stays
 * readable and consistent with surgeon tool behavior.
 *
 * @param executor - SQL executor used for the lookup.
 * @param query - Candidate filtering and pagination options.
 * @returns Prioritized candidate summaries.
 */
export async function listRetirementCandidates(executor: SqlExecutor, query: SurgeonCandidateQuery): Promise<SurgeonCandidatePage> {
  const availableFilter = buildCandidateFilter(query);
  const rawFilter = buildCandidateFilter({
    ...query,
    skipRecentlyEvaluatedDays: undefined,
  });
  const [availableResult, rawResult] = await Promise.all([
    executor.execute({
      sql: `
        SELECT
          e.id,
          e.subject,
          e.type,
          e.importance,
          e.quality_score,
          e.expiry,
          e.created_at,
          e.updated_at,
          e.recall_count,
          e.last_recalled_at,
          e.tags
        FROM entries AS e
        WHERE ${availableFilter.whereClauses.join("\n          AND ")}
        ORDER BY e.updated_at ASC
      `,
      args: availableFilter.args,
    }),
    executor.execute({
      sql: `
        SELECT
          e.id,
          e.subject,
          e.type,
          e.importance,
          e.quality_score,
          e.expiry,
          e.created_at,
          e.updated_at,
          e.recall_count,
          e.last_recalled_at,
          e.tags
        FROM entries AS e
        WHERE ${rawFilter.whereClauses.join("\n          AND ")}
        ORDER BY e.updated_at ASC
      `,
      args: rawFilter.args,
    }),
  ]);

  const allAvailableCandidates = availableResult.rows.map((row) => mapCandidateRow(row));
  const availableCandidates =
    normalizeScope(query.scope) === "actionable"
      ? allAvailableCandidates.filter((candidate) => isActionableRetirementCandidate(candidate))
      : allAvailableCandidates;
  availableCandidates.sort(compareRetirementCandidates);

  const allRawCandidates = rawResult.rows.map((row) => mapCandidateRow(row));
  const totalMatching =
    normalizeScope(query.scope) === "actionable"
      ? allRawCandidates.filter((candidate) => isActionableRetirementCandidate(candidate)).length
      : allRawCandidates.length;

  const offset = normalizeOffset(query.offset);
  const limit = normalizeLimit(query.limit);
  const pagedCandidates = availableCandidates.slice(offset, offset + limit);
  const availableCount = availableCandidates.length;
  const scopeExhausted = offset + pagedCandidates.length >= availableCount;

  return {
    candidates: pagedCandidates,
    totalMatching,
    availableCount,
    recentlyEvaluatedFilteredCount: Math.max(0, totalMatching - availableCount),
    scope: normalizeScope(query.scope),
    limit,
    offset,
    scopeExhausted,
    nextOffset: scopeExhausted ? null : offset + pagedCandidates.length,
  };
}

/**
 * Lists supersession candidate clusters across claim-key and subject scopes.
 *
 * @param executor - SQL executor used for the lookup.
 * @param query - Cluster grouping, filtering, and pagination options.
 * @returns Candidate clusters ordered by grouping key.
 */
export async function listSupersessionCandidates(executor: SqlExecutor, query: SurgeonSupersessionCandidateQuery): Promise<SurgeonSupersessionCluster[]> {
  const scope = normalizeSupersessionScope(query.scope);
  const type = normalizeOptionalString(query.type);
  const scopes = scope === "all" ? (["claim_key", "subject"] as const) : ([scope] as const);
  const clusters = (
    await Promise.all(
      scopes.map(async (currentScope) => {
        const rows = currentScope === "claim_key" ? await loadClaimKeySupersessionRows(executor, type) : await loadSubjectSupersessionRows(executor, type);
        return currentScope === "claim_key" ? groupClaimKeySupersessionRows(rows) : groupSubjectSupersessionRows(rows);
      }),
    )
  ).flat();
  const filteredClusters = await suppressRecentlySkippedSupersessionClusters(executor, clusters, query);

  const offset = normalizeOffset(query.offset);
  const limit = normalizeOptionalLimit(query.limit);
  return limit === null ? filteredClusters.slice(offset) : filteredClusters.slice(offset, offset + limit);
}

/**
 * Counts visible supersession clusters across claim-key and subject scopes.
 *
 * @param executor - SQL executor used for the lookup.
 * @param query - Optional type filter and recent-evaluation window.
 * @returns Current cluster counts for both grouping scopes.
 */
export async function countSupersessionCandidates(
  executor: SqlExecutor,
  query: {
    type?: string;
    skipRecentlyEvaluatedDays?: number;
    now?: Date;
  },
): Promise<SurgeonSupersessionCandidateCounts> {
  const type = normalizeOptionalString(query.type);
  const skippedEntryIds =
    typeof query.skipRecentlyEvaluatedDays === "number" && Number.isFinite(query.skipRecentlyEvaluatedDays) && query.skipRecentlyEvaluatedDays > 0
      ? await loadRecentlySkippedSupersessionEntryIds(executor, {
          now: query.now ?? new Date(),
          skipRecentlyEvaluatedDays: query.skipRecentlyEvaluatedDays,
        })
      : new Set<string>();

  const [claimKeyRows, subjectRows] = await Promise.all([loadClaimKeySupersessionRows(executor, type), loadSubjectSupersessionRows(executor, type)]);
  const visibleClaimKeyClusters = filterSupersessionClustersBySkippedEntryIds(groupClaimKeySupersessionRows(claimKeyRows), skippedEntryIds);
  const visibleSubjectClusters = filterSupersessionClustersBySkippedEntryIds(groupSubjectSupersessionRows(subjectRows), skippedEntryIds);

  return {
    claimKeyCount: visibleClaimKeyClusters.length,
    subjectCount: visibleSubjectClusters.length,
  };
}

/**
 * Suppresses supersession clusters when every member was skipped in a recent
 * supersession run. This avoids repeatedly re-reviewing known non-actionable
 * cross-type clusters while still surfacing clusters that gained a new member.
 *
 * @param executor - SQL executor used for recent action lookups.
 * @param clusters - Candidate clusters assembled for the current query.
 * @param query - Current supersession query options.
 * @returns Clusters that still need operator or model attention.
 */
async function suppressRecentlySkippedSupersessionClusters(
  executor: SqlExecutor,
  clusters: SurgeonSupersessionCluster[],
  query: SurgeonSupersessionCandidateQuery,
): Promise<SurgeonSupersessionCluster[]> {
  if (
    typeof query.skipRecentlyEvaluatedDays !== "number" ||
    !Number.isFinite(query.skipRecentlyEvaluatedDays) ||
    query.skipRecentlyEvaluatedDays <= 0 ||
    clusters.length === 0
  ) {
    return clusters;
  }

  const now = query.now ?? new Date();
  const skippedEntryIds = await loadRecentlySkippedSupersessionEntryIds(executor, {
    now,
    skipRecentlyEvaluatedDays: query.skipRecentlyEvaluatedDays,
  });
  if (skippedEntryIds.size === 0) {
    return clusters;
  }

  return filterSupersessionClustersBySkippedEntryIds(clusters, skippedEntryIds);
}

/**
 * Loads entry IDs that were recently skipped by supersession runs.
 *
 * @param executor - SQL executor used for the lookup.
 * @param input - Recent-evaluation window parameters.
 * @returns Entry IDs that were skipped recently enough to suppress repeat review.
 */
async function loadRecentlySkippedSupersessionEntryIds(
  executor: SqlExecutor,
  input: {
    now: Date;
    skipRecentlyEvaluatedDays: number;
  },
): Promise<Set<string>> {
  const skipCutoffIso = new Date(input.now.getTime() - normalizeNonNegativeInteger(input.skipRecentlyEvaluatedDays) * DAY_MS).toISOString();
  const result = await executor.execute({
    sql: `
      SELECT DISTINCT skipped.entry_id
      FROM (
        SELECT sra.entry_id AS entry_id
        FROM surgeon_run_actions AS sra
        INNER JOIN surgeon_runs AS sr ON sr.id = sra.run_id
        WHERE sra.action_type = 'skip'
          AND sr.pass_type = 'supersession'
          AND sr.started_at > ?
          AND sra.entry_id IS NOT NULL

        UNION

        SELECT je.value AS entry_id
        FROM surgeon_run_actions AS sra
        INNER JOIN surgeon_runs AS sr ON sr.id = sra.run_id
        INNER JOIN json_each(sra.entry_ids) AS je
        WHERE sra.action_type = 'skip'
          AND sr.pass_type = 'supersession'
          AND sr.started_at > ?
          AND json_valid(sra.entry_ids)
      ) AS skipped
      WHERE skipped.entry_id IS NOT NULL
    `,
    args: [skipCutoffIso, skipCutoffIso],
  });

  return new Set(result.rows.map((row) => readOptionalString(row, "entry_id") ?? "").filter((entryId) => entryId.length > 0));
}

/**
 * Counts retirement candidates using the same actionable filter as the query tool.
 *
 * @param executor - SQL executor used for the lookup.
 * @param options - Retirement protection configuration and optional clock.
 * @returns Number of actionable retirement candidates.
 */
export async function countRetirementCandidates(
  executor: SqlExecutor,
  options: {
    protectRecalledDays: number;
    protectMinImportance: number;
    skipRecentlyEvaluatedDays?: number;
    now?: Date;
  },
): Promise<SurgeonRetirementCandidateCounts> {
  const now = options.now ?? new Date();

  const rawFilter = buildCandidateFilter({
    scope: "all",
    protectRecalledDays: options.protectRecalledDays,
    protectMinImportance: options.protectMinImportance,
    now,
  });

  const availableAllFilter = buildCandidateFilter({
    scope: "all",
    protectRecalledDays: options.protectRecalledDays,
    protectMinImportance: options.protectMinImportance,
    skipRecentlyEvaluatedDays: options.skipRecentlyEvaluatedDays,
    now,
  });

  const [rawResult, availableAllResult] = await Promise.all([
    executor.execute({
      sql: `
        SELECT
          e.id,
          e.subject,
          e.type,
          e.importance,
          e.quality_score,
          e.expiry,
          e.created_at,
          e.updated_at,
          e.recall_count,
          e.last_recalled_at,
          e.tags
        FROM entries AS e
        WHERE ${rawFilter.whereClauses.join("\n        AND ")}
        ORDER BY e.updated_at ASC
      `,
      args: rawFilter.args,
    }),
    executor.execute({
      sql: `
        SELECT
          e.id,
          e.subject,
          e.type,
          e.importance,
          e.quality_score,
          e.expiry,
          e.created_at,
          e.updated_at,
          e.recall_count,
          e.last_recalled_at,
          e.tags
        FROM entries AS e
        WHERE ${availableAllFilter.whereClauses.join("\n        AND ")}
        ORDER BY e.updated_at ASC
      `,
      args: availableAllFilter.args,
    }),
  ]);

  const rawCandidates = rawResult.rows.map((row) => mapCandidateRow(row));
  const availableCandidates = availableAllResult.rows.map((row) => mapCandidateRow(row));
  const rawActionableCount = rawCandidates.filter((candidate) => isActionableRetirementCandidate(candidate)).length;
  const availableActionableCount = availableCandidates.filter((candidate) => isActionableRetirementCandidate(candidate)).length;
  const availableAllCount = availableCandidates.length;

  return {
    rawActionableCount,
    availableActionableCount,
    availableAllCount,
    recentlyEvaluatedFilteredCount: Math.max(0, rawActionableCount - availableActionableCount),
  };
}

/**
 * Loads one entry with surgeon-specific related-entry context.
 *
 * @param executor - SQL executor used for the lookups.
 * @param entryId - Entry identifier to inspect.
 * @returns Inspection payload, or null when the entry does not exist.
 */
export async function inspectSurgeonEntry(executor: SqlExecutor, entryId: string): Promise<SurgeonEntryInspection | null> {
  const entry = await getEntryByIdIncludingInactive(executor, entryId);
  if (!entry) {
    return null;
  }

  const normalizedSubject = entry.subject.trim().toLowerCase();
  const normalizedClusterId = entry.cluster_id?.trim();

  const [sameSubjectResult, sameClusterResult, supersedesCountResult, supersedesSampleResult] = await Promise.all([
    normalizedSubject.length > 0
      ? executor.execute({
          sql: `
          SELECT
            id,
            subject,
            type,
            importance,
            expiry,
            created_at,
            retired
          FROM entries
          WHERE ${buildActiveEntryClause()}
            AND id <> ?
            AND LOWER(TRIM(subject)) = ?
          ORDER BY updated_at DESC
          LIMIT 10
        `,
          args: [entry.id, normalizedSubject],
        })
      : Promise.resolve({ rows: [] } as { rows: Row[] }),
    normalizedClusterId
      ? executor.execute({
          sql: `
          SELECT
            id,
            subject,
            type,
            importance,
            expiry,
            created_at,
            retired
          FROM entries
          WHERE ${buildActiveEntryClause()}
            AND id <> ?
            AND cluster_id = ?
          ORDER BY updated_at DESC
          LIMIT 10
        `,
          args: [entry.id, normalizedClusterId],
        })
      : Promise.resolve({ rows: [] } as { rows: Row[] }),
    executor.execute({
      sql: `
        SELECT COUNT(*) AS supersedes_count
        FROM entries
        WHERE superseded_by = ?
      `,
      args: [entry.id],
    }),
    executor.execute({
      sql: `
        SELECT
          id,
          subject,
          type,
          importance,
          expiry,
          created_at,
          retired
        FROM entries
        WHERE superseded_by = ?
        ORDER BY created_at DESC
        LIMIT 5
      `,
      args: [entry.id],
    }),
  ]);

  return {
    entry,
    tags: entry.tags,
    related: {
      sameSubject: sameSubjectResult.rows.map((row) => mapEntrySummaryRow(row)),
      sameCluster: sameClusterResult.rows.map((row) => mapEntrySummaryRow(row)),
      supersedesCount: supersedesCountResult.rows[0] ? readNumber(supersedesCountResult.rows[0], "supersedes_count", 0) : 0,
      supersedesSample: supersedesSampleResult.rows.map((row) => mapEntrySummaryRow(row)),
    },
  };
}

/**
 * Lists entries eligible for claim-key-quality maintenance.
 *
 * @param executor - SQL executor used for the lookup.
 * @param query - Optional claim-key-quality filters.
 * @returns Matched entries ordered deterministically for one pass.
 */
export async function listClaimKeyQualityEntries(
  executor: SqlExecutor,
  query: {
    project?: string;
    type?: string;
    claimKeyPrefix?: string;
    entryIds?: string[];
    includeInactive?: boolean;
  },
): Promise<Entry[]> {
  const whereClauses = [query.includeInactive === true ? "1 = 1" : buildActiveEntryClause("e")];
  const args: Array<string | number | null> = [];
  const project = normalizeOptionalString(query.project);
  if (project) {
    whereClauses.push(`(e.project = ? OR ${buildTagContainsClause("e")})`);
    args.push(project, project);
  }

  const type = normalizeOptionalString(query.type);
  if (type) {
    whereClauses.push("e.type = ?");
    args.push(type);
  }

  const claimKeyPrefix = normalizeOptionalString(query.claimKeyPrefix);
  if (claimKeyPrefix) {
    whereClauses.push("e.claim_key LIKE ?");
    args.push(`${claimKeyPrefix}/%`);
  }

  const normalizedEntryIds = normalizeStringArray(query.entryIds ?? []);
  if (normalizedEntryIds.length > 0) {
    const placeholders = normalizedEntryIds.map(() => "?").join(", ");
    whereClauses.push(`e.id IN (${placeholders})`);
    args.push(...normalizedEntryIds);
  }

  const result = await executor.execute({
    sql: `
      SELECT
        ${ENTRY_SELECT_COLUMNS}
      FROM entries AS e
      WHERE ${whereClauses.join("\n        AND ")}
      ORDER BY
        CASE WHEN e.retired = 0 AND e.superseded_by IS NULL THEN 0 ELSE 1 END ASC,
        COALESCE(e.claim_key, '') ASC,
        e.created_at ASC,
        e.id ASC
    `,
    args,
  });

  return result.rows.map((row) => mapEntryRow(row));
}

/**
 * Shared SQL filter fragments for candidate list and count queries.
 */
interface CandidateFilterState {
  whereClauses: string[];
  args: Array<string | number | null>;
}

/**
 * Builds the shared SQL filter fragment used by candidate list and count queries.
 *
 * @param query - Candidate filtering options.
 * @returns SQL predicates and bound arguments.
 */
function buildCandidateFilter(query: SurgeonCandidateQuery): CandidateFilterState {
  const now = query.now ?? new Date();
  const protectMinImportance = normalizeNonNegativeInteger(query.protectMinImportance);
  const protectRecalledDays = normalizeNonNegativeInteger(query.protectRecalledDays);
  const protectRecalledCutoffIso = new Date(now.getTime() - protectRecalledDays * DAY_MS).toISOString();
  const currentRunId = normalizeOptionalString(query.runId);

  const whereClauses = [buildActiveEntryClause("e"), "e.expiry <> 'core'", "e.importance < ?", "(e.last_recalled_at IS NULL OR e.last_recalled_at < ?)"];
  const args: Array<string | number | null> = [protectMinImportance, protectRecalledCutoffIso];

  if (currentRunId) {
    whereClauses.push(`NOT EXISTS (
      SELECT 1
      FROM surgeon_run_actions AS sra
      WHERE sra.run_id = ?
        AND sra.action_type IN (${SURGEON_RETIREMENT_SAME_RUN_SUPPRESSION_ACTION_TYPES.map(() => "?").join(", ")})
        AND (sra.entry_id = e.id OR (json_valid(sra.entry_ids) AND EXISTS (SELECT 1 FROM json_each(sra.entry_ids) AS je WHERE je.value = e.id)))
    )`);
    args.push(currentRunId, ...SURGEON_RETIREMENT_SAME_RUN_SUPPRESSION_ACTION_TYPES);
  }

  const project = normalizeOptionalString(query.project);
  if (project) {
    whereClauses.push(buildTagContainsClause("e"));
    args.push(project);
  }

  const type = normalizeOptionalString(query.type);
  if (type) {
    whereClauses.push("e.type = ?");
    args.push(type);
  }

  if (Number.isFinite(query.importanceMax)) {
    whereClauses.push("e.importance <= ?");
    args.push(normalizeNonNegativeInteger(query.importanceMax as number));
  }

  if (typeof query.minAgeDays === "number" && Number.isFinite(query.minAgeDays) && query.minAgeDays > 0) {
    const minAgeCutoffIso = new Date(now.getTime() - normalizeNonNegativeInteger(query.minAgeDays as number) * DAY_MS).toISOString();
    whereClauses.push("e.created_at <= ?");
    args.push(minAgeCutoffIso);
  }

  if (typeof query.skipRecentlyEvaluatedDays === "number" && Number.isFinite(query.skipRecentlyEvaluatedDays) && query.skipRecentlyEvaluatedDays > 0) {
    const skipCutoffIso = new Date(now.getTime() - normalizeNonNegativeInteger(query.skipRecentlyEvaluatedDays as number) * DAY_MS).toISOString();
    whereClauses.push(`NOT EXISTS (
      SELECT 1
      FROM surgeon_run_actions AS sra
      INNER JOIN surgeon_runs AS sr ON sr.id = sra.run_id
      WHERE sra.action_type IN (${SURGEON_RETIREMENT_RECENT_EVALUATION_ACTION_TYPES.map(() => "?").join(", ")})
        AND (sra.entry_id = e.id OR (json_valid(sra.entry_ids) AND EXISTS (SELECT 1 FROM json_each(sra.entry_ids) AS je WHERE je.value = e.id)))
        AND sr.started_at > ?
    )`);
    args.push(...SURGEON_RETIREMENT_RECENT_EVALUATION_ACTION_TYPES, skipCutoffIso);
  }

  return { whereClauses, args };
}

/**
 * Loads active rows that share a non-null claim key with at least one sibling.
 *
 * @param executor - SQL executor used for the lookup.
 * @param type - Optional entry-type filter.
 * @returns Raw rows ordered by claim key and creation time.
 */
async function loadClaimKeySupersessionRows(executor: SqlExecutor, type: string | null): Promise<Row[]> {
  const whereClauses = [buildActiveEntryClause("e"), "e.claim_key IS NOT NULL"];
  const args: Array<string | number | null> = [];

  if (type) {
    whereClauses.push("e.type = ?");
    args.push(type);
  }

  const duplicateWhereClauses = ["claim_key IS NOT NULL"];
  const duplicateArgs: Array<string | number | null> = [];
  if (type) {
    duplicateWhereClauses.push("type = ?");
    duplicateArgs.push(type);
  }

  const result = await executor.execute({
    sql: `
      SELECT
        e.id,
        e.subject,
        e.type,
        e.importance,
        e.expiry,
        e.created_at,
        e.content,
        e.claim_key,
        e.tags
      FROM entries AS e
      WHERE ${whereClauses.join("\n        AND ")}
        AND e.claim_key IN (
          SELECT claim_key
          FROM entries
          WHERE ${duplicateWhereClauses.join("\n            AND ")}
            AND retired = 0
            AND superseded_by IS NULL
          GROUP BY claim_key
          HAVING COUNT(*) >= 2
        )
      ORDER BY e.claim_key ASC, e.created_at ASC, e.id ASC
    `,
    args: [...args, ...duplicateArgs],
  });

  return result.rows;
}

/**
 * Loads active rows that share the same normalized subject and type.
 *
 * @param executor - SQL executor used for the lookup.
 * @param type - Optional entry-type filter.
 * @returns Raw rows ordered by normalized subject, type, and creation time.
 */
async function loadSubjectSupersessionRows(executor: SqlExecutor, type: string | null): Promise<Row[]> {
  const whereClauses = [buildActiveEntryClause("e")];
  const args: Array<string | number | null> = [];

  if (type) {
    whereClauses.push("e.type = ?");
    args.push(type);
  }

  const duplicateWhereClauses = ["retired = 0", "superseded_by IS NULL"];
  const duplicateArgs: Array<string | number | null> = [];
  if (type) {
    duplicateWhereClauses.push("type = ?");
    duplicateArgs.push(type);
  }

  const result = await executor.execute({
    sql: `
      SELECT
        e.id,
        e.subject,
        e.type,
        e.importance,
        e.expiry,
        e.created_at,
        e.content,
        e.claim_key,
        e.tags
      FROM entries AS e
      INNER JOIN (
        SELECT
          LOWER(TRIM(subject)) AS normalized_subject,
          type
        FROM entries
        WHERE ${duplicateWhereClauses.join("\n          AND ")}
        GROUP BY LOWER(TRIM(subject)), type
        HAVING COUNT(*) >= 2
      ) AS groups
        ON LOWER(TRIM(e.subject)) = groups.normalized_subject
       AND e.type = groups.type
      WHERE ${whereClauses.join("\n        AND ")}
      ORDER BY LOWER(TRIM(e.subject)) ASC, e.type ASC, e.created_at ASC, e.id ASC
    `,
    args: [...duplicateArgs, ...args],
  });

  return result.rows;
}

/**
 * Groups raw claim-key rows into supersession candidate clusters.
 *
 * @param rows - Raw rows ordered by claim key and creation time.
 * @returns Hydrated claim-key clusters.
 */
function groupClaimKeySupersessionRows(rows: Row[]): SurgeonSupersessionCluster[] {
  const clusters = new Map<string, SurgeonSupersessionCluster>();

  for (const row of rows) {
    const claimKey = readOptionalString(row, "claim_key");
    if (!claimKey) {
      continue;
    }

    const existing = clusters.get(claimKey);
    if (existing) {
      existing.entries.push(mapSupersessionClusterEntry(row));
      continue;
    }

    clusters.set(claimKey, {
      groupKey: claimKey,
      groupedBy: "claim_key",
      entries: [mapSupersessionClusterEntry(row)],
    });
  }

  return [...clusters.values()];
}

/**
 * Groups raw subject rows into supersession candidate clusters.
 *
 * @param rows - Raw rows ordered by normalized subject, type, and creation time.
 * @returns Hydrated subject clusters.
 */
function groupSubjectSupersessionRows(rows: Row[]): SurgeonSupersessionCluster[] {
  const clusters = new Map<string, SurgeonSupersessionCluster>();

  for (const row of rows) {
    const groupKey = buildNormalizedSubjectClusterKey(row);
    const existing = clusters.get(groupKey);
    if (existing) {
      existing.entries.push(mapSupersessionClusterEntry(row));
      continue;
    }

    clusters.set(groupKey, {
      groupKey,
      groupedBy: "subject",
      entries: [mapSupersessionClusterEntry(row)],
    });
  }

  return [...clusters.values()];
}

/**
 * Builds the JSON tag-membership predicate for one entry alias.
 *
 * @param alias - Table alias that owns the `tags` column.
 * @returns SQL fragment that checks for an exact tag value.
 */
function buildTagContainsClause(alias: string): string {
  return `EXISTS (
    SELECT 1
    FROM json_each(
      CASE
        WHEN json_valid(COALESCE(${alias}.tags, '[]')) THEN COALESCE(${alias}.tags, '[]')
        ELSE '[]'
      END
    )
    WHERE json_each.value = ?
  )`;
}

/**
 * Normalizes the candidate scope to the supported query values.
 *
 * @param scope - Caller-supplied scope.
 * @returns Supported candidate scope.
 */
function normalizeScope(scope: SurgeonCandidateQuery["scope"]): "actionable" | "all" {
  return scope === "all" ? "all" : "actionable";
}

/**
 * Normalizes the supersession scope to a supported grouping family.
 *
 * @param scope - Caller-supplied scope.
 * @returns Supported supersession scope.
 */
function normalizeSupersessionScope(scope: SurgeonSupersessionCandidateQuery["scope"]): "claim_key" | "subject" | "all" {
  if (scope === "subject" || scope === "all") {
    return scope;
  }

  return "claim_key";
}

/**
 * Maps a raw candidate row into the surgeon candidate summary shape.
 *
 * @param row - Raw database row.
 * @returns Hydrated candidate summary.
 */
function mapCandidateRow(row: Row): SurgeonCandidateSummary {
  return {
    id: readRequiredString(row, "id"),
    subject: readRequiredString(row, "subject"),
    type: readRequiredString(row, "type"),
    importance: readNumber(row, "importance", 0),
    qualityScore: readNumber(row, "quality_score", 0.5),
    expiry: readRequiredString(row, "expiry"),
    createdAt: readRequiredString(row, "created_at"),
    updatedAt: readRequiredString(row, "updated_at"),
    recallCount: readNumber(row, "recall_count", 0),
    lastRecalledAt: readOptionalString(row, "last_recalled_at") ?? null,
    tags: deserializeTags(row.tags),
  };
}

/**
 * Normalizes list limits into the default-positive pagination range.
 *
 * @param limit - Raw limit value.
 * @returns Safe list limit.
 */
function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return 20;
  }

  return Math.floor(limit);
}

/**
 * Normalizes optional cluster limits while preserving the "all clusters" case.
 *
 * @param limit - Raw limit value.
 * @returns Safe list limit, or null when no explicit limit was requested.
 */
function normalizeOptionalLimit(limit: number | undefined): number | null {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }

  return Math.floor(limit);
}

/**
 * Normalizes offsets into a non-negative integer.
 *
 * @param offset - Raw offset value.
 * @returns Safe list offset.
 */
function normalizeOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset <= 0) {
    return 0;
  }

  return Math.floor(offset);
}

/**
 * Normalizes numeric filters into non-negative integers.
 *
 * @param value - Raw numeric value.
 * @returns Safe non-negative integer.
 */
function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

/**
 * Normalizes optional strings into nullable trimmed values.
 *
 * @param value - Raw optional string.
 * @returns Trimmed string or null.
 */
function normalizeOptionalString(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Trims, removes blanks, and deduplicates generic string-array filters.
 *
 * @param values - Raw filter values.
 * @returns Stable list of non-empty unique strings.
 */
function normalizeStringArray(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

/**
 * Maps one raw row into the supersession-cluster entry shape.
 *
 * @param row - Raw database row.
 * @returns Hydrated cluster entry.
 */
function mapSupersessionClusterEntry(row: Row): SurgeonSupersessionClusterEntry {
  return {
    id: readRequiredString(row, "id"),
    subject: readRequiredString(row, "subject"),
    type: readRequiredString(row, "type"),
    importance: readNumber(row, "importance", 0),
    expiry: readRequiredString(row, "expiry"),
    createdAt: readRequiredString(row, "created_at"),
    content: readRequiredString(row, "content"),
    claimKey: readOptionalString(row, "claim_key") ?? null,
    tags: deserializeTags(row.tags),
  };
}

/**
 * Builds the stable cluster key used for normalized subject groupings.
 *
 * @param row - Raw database row.
 * @returns Stable normalized subject key including entry type.
 */
function buildNormalizedSubjectClusterKey(row: Row): string {
  const subject = readRequiredString(row, "subject").trim().toLowerCase();
  const type = readRequiredString(row, "type").trim();
  return `${subject}::${type}`;
}

/**
 * Maps a raw database row into the lightweight inspection summary shape.
 *
 * @param row - Raw database row.
 * @returns Hydrated entry summary.
 */
function mapEntrySummaryRow(row: Row): SurgeonEntrySummary {
  return {
    id: readRequiredString(row, "id"),
    subject: readRequiredString(row, "subject"),
    type: readRequiredString(row, "type"),
    importance: readNumber(row, "importance", 0),
    expiry: readRequiredString(row, "expiry"),
    createdAt: readRequiredString(row, "created_at"),
    retired: readBoolean(row, "retired"),
  };
}

/**
 * Loads one entry by ID without applying active-entry filters.
 *
 * @param executor - SQL executor used for the lookup.
 * @param entryId - Entry identifier to resolve.
 * @returns Entry from any state, or null when absent.
 */
async function getEntryByIdIncludingInactive(executor: SqlExecutor, entryId: string): Promise<Entry | null> {
  const normalizedEntryId = entryId.trim();
  if (normalizedEntryId.length === 0) {
    return null;
  }

  const result = await executor.execute({
    sql: `
      SELECT
        ${ENTRY_SELECT_COLUMNS}
      FROM entries
      WHERE id = ?
      LIMIT 1
    `,
    args: [normalizedEntryId],
  });

  const row = result.rows[0];
  return row ? mapEntryRow(row) : null;
}
