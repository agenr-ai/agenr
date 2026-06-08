import type { Episode, Procedure } from "../../core/types.js";
import { ACTIVE_EPISODE_CLAUSE, mapEpisodeRow } from "./row-mapping.js";
import { ACTIVE_PROCEDURE_CLAUSE, PROCEDURE_SELECT_COLUMNS, mapProcedureRow } from "./procedure-row-mapping.js";
import type { SqlExecutor } from "./queries.js";

const EPISODE_LIST_COLUMNS = `
  id,
  source,
  source_id,
  source_ref,
  transcript_hash,
  summary_hash,
  agent_id,
  surface,
  started_at,
  ended_at,
  summary,
  tags,
  activity_level,
  user_id,
  project,
  gen_model,
  gen_version,
  message_count,
  valid_from,
  valid_to,
  supersession_kind,
  supersession_reason,
  superseded_by,
  created_at,
  updated_at
`;

const DEFAULT_PROCEDURE_LIMIT = 200;
const DEFAULT_EPISODE_LIMIT = 50;
const MAX_EPISODE_LIMIT = 200;

/**
 * Lists every active procedure revision for the operator console.
 *
 * The core `ProcedureDatabasePort` only exposes point lookups and ranked
 * search, so this read-only admin query fills the "show the whole active
 * procedure corpus" gap the Memory Explorer needs.
 *
 * @param executor - SQL executor bound to the live or transaction client.
 * @param limit - Maximum revisions to return. Defaults to 200.
 * @returns Active procedure revisions ordered by procedure key.
 */
export async function listActiveProcedures(executor: SqlExecutor, limit = DEFAULT_PROCEDURE_LIMIT): Promise<Procedure[]> {
  const result = await executor.execute({
    sql: `
      SELECT ${PROCEDURE_SELECT_COLUMNS}
      FROM procedures
      WHERE ${ACTIVE_PROCEDURE_CLAUSE}
      ORDER BY procedure_key ASC, updated_at DESC
      LIMIT ?
    `,
    args: [Math.max(1, Math.trunc(limit))],
  });

  return result.rows.map(mapProcedureRow);
}

/**
 * Recent-episode browser result with the total active episode count.
 */
export interface WebEpisodeListResult {
  /** Episodes for the requested page ordered newest first. */
  episodes: Episode[];
  /** Total active episodes ignoring pagination. */
  total: number;
  /** Limit applied to this page. */
  limit: number;
  /** Offset applied to this page. */
  offset: number;
}

/**
 * Lists recent active episodes for the operator console.
 *
 * Embeddings are intentionally excluded from the projection to keep the list
 * payload small; the detail view can rehydrate a single episode when needed.
 *
 * @param executor - SQL executor bound to the live or transaction client.
 * @param options - Optional project filter and pagination controls.
 * @returns Paginated active episodes ordered by start time, newest first.
 */
export async function listRecentEpisodes(
  executor: SqlExecutor,
  options: { project?: string; limit?: number; offset?: number } = {},
): Promise<WebEpisodeListResult> {
  const limit = Math.min(MAX_EPISODE_LIMIT, Math.max(1, Math.trunc(options.limit ?? DEFAULT_EPISODE_LIMIT)));
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const project = options.project?.trim();

  const conditions = [ACTIVE_EPISODE_CLAUSE];
  const args: (string | number)[] = [];
  if (project && project.length > 0) {
    conditions.push("project = ?");
    args.push(project);
  }
  const clause = `WHERE ${conditions.join(" AND ")}`;

  const countResult = await executor.execute({
    sql: `SELECT COUNT(*) AS total FROM episodes ${clause}`,
    args,
  });
  const total = readCount(countResult.rows[0]?.total);

  const listResult = await executor.execute({
    sql: `
      SELECT ${EPISODE_LIST_COLUMNS}
      FROM episodes
      ${clause}
      ORDER BY datetime(started_at) DESC, id DESC
      LIMIT ? OFFSET ?
    `,
    args: [...args, limit, offset],
  });

  return {
    episodes: listResult.rows.map(mapEpisodeRow),
    total,
    limit,
    offset,
  };
}

/** Reads a numeric count from a libSQL aggregate cell. */
function readCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}
