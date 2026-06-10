import type { Durable } from "../../core/types.js";
import type { DreamClaimKeyContextDurable } from "../../core/dreaming/claim-key-context.js";
import type { DreamEpisodeEvidence, DreamHealthStats } from "../../app/dreaming/ports.js";
import {
  buildActiveDurableClause,
  buildActiveEpisodeClause,
  DURABLE_SELECT_COLUMNS,
  mapDurableRow,
  readNumber,
  readOptionalString,
  readRequiredString,
} from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Collects aggregate active-durable health stats for dreaming status.
 *
 * @param executor - SQL executor used for the lookups.
 * @param now - Optional reference time for recency windows.
 * @returns Aggregate health summary for the active corpus.
 */
export async function getDreamHealthStats(executor: SqlExecutor, now: Date = new Date()): Promise<DreamHealthStats> {
  const last7Cutoff = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const last30Cutoff = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const last90Cutoff = new Date(now.getTime() - 90 * DAY_MS).toISOString();

  const [totalResult, byTypeResult, lifecycleResult, proposalBacklogResult, recencyResult, recallResult, qualityResult] = await Promise.all([
    executor.execute({
      sql: `
        SELECT COUNT(*) AS total
        FROM durables AS e
        WHERE ${buildActiveDurableClause("e")}
      `,
    }),
    executor.execute({
      sql: `
        SELECT e.type, COUNT(*) AS durable_count
        FROM durables AS e
        WHERE ${buildActiveDurableClause("e")}
        GROUP BY e.type
      `,
    }),
    executor.execute({
      sql: `
        SELECT
          COALESCE(SUM(CASE WHEN e.claim_key_status = 'trusted' THEN 1 ELSE 0 END), 0) AS trusted_count,
          COALESCE(SUM(CASE WHEN e.claim_key_status = 'tentative' THEN 1 ELSE 0 END), 0) AS tentative_count,
          COALESCE(SUM(CASE WHEN e.claim_key_status = 'unresolved' THEN 1 ELSE 0 END), 0) AS unresolved_count,
          COALESCE(SUM(CASE WHEN e.claim_key IS NULL OR TRIM(e.claim_key) = '' THEN 1 ELSE 0 END), 0) AS no_key_count
        FROM durables AS e
        WHERE ${buildActiveDurableClause("e")}
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
          FROM dream_proposals
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
        FROM durables AS e
        WHERE ${buildActiveDurableClause("e")}
      `,
      args: [last7Cutoff, last7Cutoff, last30Cutoff, last30Cutoff, last90Cutoff, last90Cutoff],
    }),
    executor.execute({
      sql: `
        SELECT
          COALESCE(SUM(CASE WHEN COALESCE(e.recall_count, 0) = 0 THEN 1 ELSE 0 END), 0) AS never_count,
          COALESCE(SUM(CASE WHEN COALESCE(e.recall_count, 0) BETWEEN 1 AND 5 THEN 1 ELSE 0 END), 0) AS one_to_five_count,
          COALESCE(SUM(CASE WHEN COALESCE(e.recall_count, 0) > 5 THEN 1 ELSE 0 END), 0) AS five_plus_count
        FROM durables AS e
        WHERE ${buildActiveDurableClause("e")}
      `,
    }),
    executor.execute({
      sql: `
        SELECT
          COALESCE(SUM(CASE WHEN COALESCE(e.quality_score, 0.5) >= 0.7 THEN 1 ELSE 0 END), 0) AS high_count,
          COALESCE(SUM(CASE WHEN COALESCE(e.quality_score, 0.5) >= 0.4 AND COALESCE(e.quality_score, 0.5) < 0.7 THEN 1 ELSE 0 END), 0) AS medium_count,
          COALESCE(SUM(CASE WHEN COALESCE(e.quality_score, 0.5) < 0.4 THEN 1 ELSE 0 END), 0) AS low_count,
          COALESCE(AVG(COALESCE(e.quality_score, 0.5)), 0) AS average_score
        FROM durables AS e
        WHERE ${buildActiveDurableClause("e")}
      `,
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
    byType[readRequiredString(row, "type")] = readNumber(row, "durable_count", 0);
  }

  return {
    total: totalRow ? readNumber(totalRow, "total", 0) : 0,
    byType,
    claimKeyLifecycle: {
      trusted: lifecycleRow ? readNumber(lifecycleRow, "trusted_count", 0) : 0,
      tentative: lifecycleRow ? readNumber(lifecycleRow, "tentative_count", 0) : 0,
      unresolved: lifecycleRow ? readNumber(lifecycleRow, "unresolved_count", 0) : 0,
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
  };
}

/**
 * Lists durables eligible for reconcile maintenance.
 *
 * @param executor - SQL executor used for the lookup.
 * @param query - Optional reconcile filters.
 * @returns Matched durables ordered deterministically for one pass.
 */
export async function listReconcileDurables(
  executor: SqlExecutor,
  query: {
    project?: string;
    type?: string;
    claimKeyPrefix?: string;
    durableIds?: string[];
    includeInactive?: boolean;
  },
): Promise<Durable[]> {
  const whereClauses = [query.includeInactive === true ? "1 = 1" : buildActiveDurableClause("e")];
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

  const normalizedDurableIds = normalizeStringArray(query.durableIds ?? []);
  if (normalizedDurableIds.length > 0) {
    const placeholders = normalizedDurableIds.map(() => "?").join(", ");
    whereClauses.push(`e.id IN (${placeholders})`);
    args.push(...normalizedDurableIds);
  }

  const result = await executor.execute({
    sql: `
      SELECT
        ${DURABLE_SELECT_COLUMNS}
      FROM durables AS e
      WHERE ${whereClauses.join("\n        AND ")}
      ORDER BY
        CASE WHEN ${buildActiveDurableClause("e")} THEN 0 ELSE 1 END ASC,
        COALESCE(e.claim_key, '') ASC,
        e.created_at ASC,
        e.id ASC
    `,
    args,
  });

  return result.rows.map((row) => mapDurableRow(row));
}

/** SQL predicate excluding episodes already mined by an applied extract pass. */
const UNSYNTHESIZED_EPISODE_CLAUSE = `NOT EXISTS (
        SELECT 1
        FROM dream_synthesized_episodes AS s
        WHERE s.episode_id = episodes.id
      )`;

/**
 * Lists active episode evidence not yet mined by an applied extract pass.
 *
 * Episodes are first-class dreaming evidence: the extract stage mines durable
 * candidates from their summaries exactly once. Selection prefers the newest
 * sessions so a post-session light run mines the session that just ended, but
 * the selected rows are returned oldest-first so candidate provenance follows
 * the natural session timeline within one run.
 *
 * @param executor - SQL executor used for the lookup.
 * @param options - Optional project filter and row cap.
 * @returns Unsynthesized episode evidence rows ordered oldest-first.
 */
export async function listUnsynthesizedEpisodeEvidence(
  executor: SqlExecutor,
  options: { project?: string; limit?: number } = {},
): Promise<DreamEpisodeEvidence[]> {
  const args: Array<string | number> = [];
  let projectClause = "";
  const project = options.project?.trim();
  if (project) {
    projectClause = " AND project = ?";
    args.push(project);
  }

  const limit = Number.isFinite(options.limit) && (options.limit ?? 0) > 0 ? Math.floor(options.limit!) : 50;
  args.push(limit);

  const result = await executor.execute({
    sql: `
      SELECT *
      FROM (
        SELECT
          id,
          summary,
          started_at,
          ended_at,
          source_id,
          project
        FROM episodes
        WHERE ${UNSYNTHESIZED_EPISODE_CLAUSE}
          AND ${buildActiveEpisodeClause()}
          ${projectClause}
        ORDER BY started_at DESC, id DESC
        LIMIT ?
      )
      ORDER BY started_at ASC, id ASC
    `,
    args,
  });

  return result.rows.map((row) => ({
    id: readRequiredString(row, "id"),
    summary: readRequiredString(row, "summary"),
    startedAt: readRequiredString(row, "started_at"),
    endedAt: readOptionalString(row, "ended_at") ?? null,
    sessionId: readOptionalString(row, "source_id") ?? null,
    project: readOptionalString(row, "project") ?? null,
  }));
}

/**
 * Counts active episodes not yet mined by an applied extract pass.
 *
 * @param executor - SQL executor used for the lookup.
 * @param project - Optional project filter.
 * @returns Number of active episodes still awaiting synthesis.
 */
export async function countUnsynthesizedEpisodes(executor: SqlExecutor, project?: string): Promise<number> {
  const args: Array<string> = [];
  let projectClause = "";
  if (project?.trim()) {
    projectClause = " AND project = ?";
    args.push(project.trim());
  }

  const result = await executor.execute({
    sql: `
      SELECT COUNT(*) AS total
      FROM episodes
      WHERE ${UNSYNTHESIZED_EPISODE_CLAUSE}
        AND ${buildActiveEpisodeClause()}
        ${projectClause}
    `,
    args,
  });

  const row = result.rows[0];
  return row ? readNumber(row, "total", 0) : 0;
}

/**
 * Records episodes mined by an applied extract pass so later runs skip them.
 *
 * The first synthesis record wins: re-marking an already-synthesized episode
 * keeps the original run attribution.
 *
 * @param executor - SQL executor used for the writes.
 * @param input - Episode ids plus the run id and timestamp to attribute.
 */
export async function markEpisodesSynthesized(executor: SqlExecutor, input: { episodeIds: string[]; runId: string; synthesizedAt: string }): Promise<void> {
  const episodeIds = normalizeStringArray(input.episodeIds);
  for (const episodeId of episodeIds) {
    await executor.execute({
      sql: `
        INSERT INTO dream_synthesized_episodes (episode_id, run_id, synthesized_at)
        VALUES (?, ?, ?)
        ON CONFLICT(episode_id) DO NOTHING
      `,
      args: [episodeId, input.runId.trim(), input.synthesizedAt],
    });
  }
}

const HOST_STORE_SOURCE_CLAUSE = `(source_file LIKE 'skeln-session:%' OR source_file LIKE 'openclaw-session:%')`;

/**
 * Lists host-store durables written during one episode session window.
 *
 * @param executor - SQL executor used for the lookup.
 * @param sessionId - Host session identifier carried on the episode row.
 * @param startedAt - Episode lower bound.
 * @param endedAt - Episode upper bound.
 * @returns Host-store durables already captured live during the session.
 */
export async function listSessionHostStoreDurables(executor: SqlExecutor, sessionId: string, startedAt: string, endedAt: string): Promise<Durable[]> {
  const normalizedSessionId = sessionId.trim();
  if (normalizedSessionId.length === 0) {
    return [];
  }

  const result = await executor.execute({
    sql: `
      SELECT ${DURABLE_SELECT_COLUMNS}
      FROM durables
      WHERE created_at >= ?
        AND created_at <= ?
        AND ${HOST_STORE_SOURCE_CLAUSE}
        AND source_file LIKE ?
        AND ${buildActiveDurableClause()}
      ORDER BY created_at ASC, id ASC
    `,
    args: [startedAt, endedAt, `%${normalizedSessionId}%`],
  });

  return result.rows.map((row) => mapDurableRow(row));
}

/**
 * Lists active keyed durables relevant to one dreaming extract episode.
 *
 * @param executor - SQL executor used for the lookup.
 * @param query - Optional project and claim-key entity-prefix filters.
 * @returns Bounded active durables ordered for prompt usefulness.
 */
export async function listActiveClaimKeyContext(
  executor: SqlExecutor,
  query: { project?: string; entityPrefixes?: string[]; limit?: number },
): Promise<DreamClaimKeyContextDurable[]> {
  const project = normalizeOptionalString(query.project);
  const entityPrefixes = normalizeStringArray(query.entityPrefixes ?? []);
  const limit = Number.isFinite(query.limit) && (query.limit ?? 0) > 0 ? Math.floor(query.limit!) : 24;
  const whereClauses = [`e.claim_key IS NOT NULL`, `instr(e.claim_key, '/') > 1`, buildActiveDurableClause("e")];
  const relevanceClauses: string[] = [];
  const relevanceArgs: Array<string | number> = [];

  if (project) {
    relevanceClauses.push("e.project = ?");
    relevanceArgs.push(project);
  }

  if (entityPrefixes.length > 0) {
    const placeholders = entityPrefixes.map(() => "?").join(", ");
    relevanceClauses.push(`lower(trim(substr(e.claim_key, 1, instr(e.claim_key, '/') - 1))) IN (${placeholders})`);
    relevanceArgs.push(...entityPrefixes);
  }

  if (relevanceClauses.length > 0) {
    whereClauses.push(`(${relevanceClauses.join(" OR ")})`);
  }

  const orderArgs: Array<string | number> = [];
  const projectRank = project ? "CASE WHEN e.project = ? THEN 0 ELSE 1 END" : "1";
  if (project) {
    orderArgs.push(project);
  }

  const entityRank =
    entityPrefixes.length > 0
      ? `CASE WHEN lower(trim(substr(e.claim_key, 1, instr(e.claim_key, '/') - 1))) IN (${entityPrefixes.map(() => "?").join(", ")}) THEN 0 ELSE 1 END`
      : "1";
  orderArgs.push(...entityPrefixes);

  const result = await executor.execute({
    sql: `
      SELECT
        e.id,
        e.type,
        e.subject,
        e.content,
        e.claim_key,
        e.project
      FROM durables AS e
      WHERE ${whereClauses.join("\n        AND ")}
      ORDER BY
        ${projectRank} ASC,
        ${entityRank} ASC,
        CASE WHEN e.claim_key_source IN ('dreaming_extract', 'dreaming_temporalize', 'dreaming_reconcile') THEN 0 ELSE 1 END ASC,
        e.importance DESC,
        e.created_at DESC,
        e.claim_key ASC,
        e.id ASC
      LIMIT ?
    `,
    args: [...relevanceArgs, ...orderArgs, limit],
  });

  return result.rows.flatMap((row) => {
    const claimKey = readOptionalString(row, "claim_key")?.trim();
    if (!claimKey) {
      return [];
    }

    return [
      {
        id: readRequiredString(row, "id"),
        type: readRequiredString(row, "type") as DreamClaimKeyContextDurable["type"],
        subject: readRequiredString(row, "subject"),
        content: readRequiredString(row, "content"),
        claimKey,
        ...(readOptionalString(row, "project") ? { project: readOptionalString(row, "project") } : {}),
      },
    ];
  });
}

/**
 * Counts episodes created or updated since a timestamp.
 *
 * @param executor - SQL executor used for the lookup.
 * @param since - ISO timestamp lower bound.
 * @param project - Optional project filter.
 * @returns Number of matching episodes.
 */
export async function countEpisodesSince(executor: SqlExecutor, since: string, project?: string): Promise<number> {
  const args: Array<string> = [since];
  let projectClause = "";
  if (project?.trim()) {
    projectClause = " AND project = ?";
    args.push(project.trim());
  }

  const result = await executor.execute({
    sql: `
      SELECT COUNT(*) AS total
      FROM episodes
      WHERE created_at >= ?
        AND ${buildActiveEpisodeClause()}
        ${projectClause}
    `,
    args,
  });

  const row = result.rows[0];
  return row ? readNumber(row, "total", 0) : 0;
}

/**
 * Counts ingest-log rows recorded since a timestamp.
 *
 * @param executor - SQL executor used for the lookup.
 * @param since - ISO timestamp lower bound.
 * @returns Number of ingest-log rows.
 */
export async function countIngestFilesSince(executor: SqlExecutor, since: string): Promise<number> {
  const result = await executor.execute({
    sql: `
      SELECT COUNT(*) AS total
      FROM ingest_log
      WHERE ingested_at >= ?
    `,
    args: [since],
  });

  const row = result.rows[0];
  return row ? readNumber(row, "total", 0) : 0;
}

/**
 * Counts durables created since a timestamp.
 *
 * @param executor - SQL executor used for the lookup.
 * @param since - ISO timestamp lower bound.
 * @param project - Optional project filter.
 * @returns Number of matching durables.
 */
export async function countDurablesCreatedSince(executor: SqlExecutor, since: string, project?: string): Promise<number> {
  const args: Array<string> = [since];
  let projectClause = "";
  if (project?.trim()) {
    projectClause = " AND project = ?";
    args.push(project.trim());
  }

  const result = await executor.execute({
    sql: `
      SELECT COUNT(*) AS total
      FROM durables
      WHERE created_at >= ?
        ${projectClause}
    `,
    args,
  });

  const row = result.rows[0];
  return row ? readNumber(row, "total", 0) : 0;
}

/**
 * Sums active durable importance created since a timestamp.
 *
 * @param executor - SQL executor used for the lookup.
 * @param since - ISO timestamp lower bound.
 * @param project - Optional project filter.
 * @returns Sum of matching durable importance values.
 */
export async function sumDurableImportanceCreatedSince(executor: SqlExecutor, since: string, project?: string): Promise<number> {
  const args: Array<string> = [since];
  let projectClause = "";
  if (project?.trim()) {
    projectClause = " AND project = ?";
    args.push(project.trim());
  }

  const result = await executor.execute({
    sql: `
      SELECT COALESCE(SUM(COALESCE(importance, 0)), 0) AS total
      FROM durables
      WHERE created_at >= ?
        AND ${buildActiveDurableClause("durables")}
        ${projectClause}
    `,
    args,
  });

  const row = result.rows[0];
  return row ? readNumber(row, "total", 0) : 0;
}

/** Builds a SQLite JSON tag containment predicate for one table alias. */
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

/** Normalizes an optional query filter string. */
function normalizeOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** Normalizes query filter string arrays by trimming blanks. */
function normalizeStringArray(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}
