import type { Row } from "@libsql/client";

import type { Entry } from "../../core/types.js";
import { buildActiveEntryClause, deserializeTags, mapEntryRow, readBoolean, readNumber, readOptionalString, readRequiredString } from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const ENTRY_SELECT_COLUMNS = `
  id,
  type,
  subject,
  content,
  importance,
  expiry,
  tags,
  source_file,
  source_context,
  embedding,
  content_hash,
  norm_content_hash,
  quality_score,
  recall_count,
  last_recalled_at,
  superseded_by,
  cluster_id,
  retired,
  retired_at,
  retired_reason,
  created_at,
  updated_at
`;

/**
 * Aggregate corpus health summary used by surgeon startup and status tools.
 */
export interface SurgeonHealthStats {
  total: number;
  byType: Record<string, number>;
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
    now?: Date;
  },
): Promise<SurgeonHealthStats> {
  const now = options.now ?? new Date();
  const last7Cutoff = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const last30Cutoff = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const last90Cutoff = new Date(now.getTime() - 90 * DAY_MS).toISOString();

  const [totalResult, byTypeResult, recencyResult, recallResult, qualityResult, retirementCandidateCount] = await Promise.all([
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
      now,
    }),
  ]);

  const totalRow = totalResult.rows[0];
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
    retirementCandidateCount,
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
export async function listRetirementCandidates(executor: SqlExecutor, query: SurgeonCandidateQuery): Promise<SurgeonCandidateSummary[]> {
  const filter = buildCandidateFilter(query);
  const result = await executor.execute({
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
      WHERE ${filter.whereClauses.join("\n        AND ")}
      ORDER BY e.updated_at ASC
    `,
    args: filter.args,
  });

  const candidates = result.rows.map((row) => mapCandidateRow(row));
  candidates.sort(compareCandidates);

  const offset = normalizeOffset(query.offset);
  const limit = normalizeLimit(query.limit);
  return candidates.slice(offset, offset + limit);
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
    now?: Date;
  },
): Promise<number> {
  const filter = buildCandidateFilter({
    scope: "actionable",
    protectRecalledDays: options.protectRecalledDays,
    protectMinImportance: options.protectMinImportance,
    now: options.now,
  });

  const result = await executor.execute({
    sql: `
      SELECT COUNT(*) AS candidate_count
      FROM entries AS e
      WHERE ${filter.whereClauses.join("\n        AND ")}
    `,
    args: filter.args,
  });

  const row = result.rows[0];
  return row ? readNumber(row, "candidate_count", 0) : 0;
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
  const scope = normalizeScope(query.scope);
  const protectMinImportance = normalizeNonNegativeInteger(query.protectMinImportance);
  const protectRecalledDays = normalizeNonNegativeInteger(query.protectRecalledDays);
  const protectRecalledCutoffIso = new Date(now.getTime() - protectRecalledDays * DAY_MS).toISOString();
  const currentRunId = normalizeOptionalString(query.runId);

  const whereClauses = [buildActiveEntryClause("e"), "e.expiry <> 'core'", "e.importance < ?", "(e.last_recalled_at IS NULL OR e.last_recalled_at < ?)"];
  const args: Array<string | number | null> = [protectMinImportance, protectRecalledCutoffIso];

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

  if (scope === "actionable") {
    whereClauses.push(`(
      e.expiry = 'temporary'
      OR e.type = 'todo'
      OR (e.type = 'event' AND (e.importance <= 6 OR e.expiry = 'permanent'))
      OR (e.type = 'fact' AND e.importance <= 5 AND COALESCE(e.recall_count, 0) = 0)
    )`);
  }

  if (Number.isFinite(query.importanceMax)) {
    whereClauses.push("e.importance <= ?");
    args.push(normalizeNonNegativeInteger(query.importanceMax as number));
  }

  if (Number.isFinite(query.minAgeDays) && (query.minAgeDays ?? 0) > 0) {
    const minAgeCutoffIso = new Date(now.getTime() - normalizeNonNegativeInteger(query.minAgeDays as number) * DAY_MS).toISOString();
    whereClauses.push("e.created_at <= ?");
    args.push(minAgeCutoffIso);
  }

  if (Number.isFinite(query.skipRecentlyEvaluatedDays) && (query.skipRecentlyEvaluatedDays ?? 0) > 0) {
    const skipCutoffIso = new Date(now.getTime() - normalizeNonNegativeInteger(query.skipRecentlyEvaluatedDays as number) * DAY_MS).toISOString();
    whereClauses.push(`NOT EXISTS (
      SELECT 1
      FROM surgeon_run_actions AS sra
      INNER JOIN surgeon_runs AS sr ON sr.id = sra.run_id
      WHERE sra.entry_id = e.id
        AND sr.started_at > ?
        AND (? IS NULL OR sr.id <> ?)
    )`);
    args.push(skipCutoffIso, currentRunId, currentRunId);
  }

  return { whereClauses, args };
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
 * Compares two candidate summaries using the surgeon prioritization rules.
 *
 * @param left - Left candidate.
 * @param right - Right candidate.
 * @returns Sort comparator value.
 */
function compareCandidates(left: SurgeonCandidateSummary, right: SurgeonCandidateSummary): number {
  const tierDelta = candidatePriorityTier(left) - candidatePriorityTier(right);
  if (tierDelta !== 0) {
    return tierDelta;
  }

  const leftNeverRecalled = left.recallCount === 0;
  const rightNeverRecalled = right.recallCount === 0;
  if (leftNeverRecalled !== rightNeverRecalled) {
    return leftNeverRecalled ? -1 : 1;
  }

  const createdDelta = parseTimestamp(left.createdAt) - parseTimestamp(right.createdAt);
  if (createdDelta !== 0) {
    return createdDelta;
  }

  if (left.importance !== right.importance) {
    return left.importance - right.importance;
  }

  const updatedDelta = left.updatedAt.localeCompare(right.updatedAt);
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return left.id.localeCompare(right.id);
}

/**
 * Assigns a candidate priority tier used for surgeon ordering.
 *
 * @param candidate - Candidate to classify.
 * @returns Tier number where lower values sort first.
 */
function candidatePriorityTier(candidate: SurgeonCandidateSummary): number {
  if (candidate.expiry === "temporary") {
    return 0;
  }

  if (candidate.type === "todo") {
    return 1;
  }

  if (candidate.type === "event" && candidate.importance <= 4) {
    return 2;
  }

  if (looksLikeStatusArtifact(candidate.subject)) {
    return 3;
  }

  return 4;
}

/**
 * Detects whether a subject looks like a status-artifact memory.
 *
 * @param subject - Candidate subject text.
 * @returns True when the subject matches status-artifact heuristics.
 */
function looksLikeStatusArtifact(subject: string): boolean {
  const normalized = subject.trim().toLowerCase();
  return (
    normalized.includes("session handoff") ||
    normalized.includes("status update") ||
    normalized.includes("progress snapshot") ||
    normalized.includes("session summary") ||
    normalized.includes("next steps") ||
    normalized.includes("in progress") ||
    normalized.startsWith("handoff")
  );
}

/**
 * Parses an ISO timestamp into a sortable numeric value.
 *
 * @param value - Timestamp text.
 * @returns Parsed timestamp or a max sentinel for invalid input.
 */
function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

/**
 * Normalizes list limits into the default-positive pagination range.
 *
 * @param limit - Raw limit value.
 * @returns Safe list limit.
 */
function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit ?? 0) <= 0) {
    return 20;
  }

  return Math.floor(limit as number);
}

/**
 * Normalizes offsets into a non-negative integer.
 *
 * @param offset - Raw offset value.
 * @returns Safe list offset.
 */
function normalizeOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset) || (offset ?? 0) <= 0) {
    return 0;
  }

  return Math.floor(offset as number);
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
