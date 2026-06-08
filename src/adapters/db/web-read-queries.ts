import type { Episode, Procedure } from "../../core/types.js";
import { validateTemporalValidityRange } from "../../core/temporal-validity.js";
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
 * Metadata-only fields the operator console may update on an episode.
 */
export interface WebEpisodeMetadataPatch {
  /** Source reference or locator. Empty clears the field. */
  sourceRef?: string;
  /** Host surface. Empty clears the field. */
  surface?: string;
  /** User id. Empty clears the field. */
  userId?: string;
  /** Project scope. Empty clears the field. */
  project?: string;
  /** Activity level. */
  activityLevel?: Episode["activityLevel"] | "";
  /** Episode tags. Empty array clears tags. */
  tags?: string[];
  /** Valid-from bound. Empty clears the field. */
  validFrom?: string;
  /** Valid-to bound. Empty clears the field. */
  validTo?: string;
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

/**
 * Updates metadata-only fields on an active episode.
 *
 * Summary text and source identity are deliberately not changed here. Operators
 * can correct routing and lifecycle metadata without rewriting the narrative
 * record produced by ingest.
 *
 * @param executor - SQL executor bound to the live or transaction client.
 * @param id - Target episode id.
 * @param fields - Metadata fields to replace.
 * @returns True when an active episode was updated.
 */
export async function updateEpisodeMetadata(executor: SqlExecutor, id: string, fields: WebEpisodeMetadataPatch): Promise<boolean> {
  const assignments: string[] = [];
  const args: Array<number | string | null> = [];
  const validityPatch = fields.validFrom !== undefined || fields.validTo !== undefined;
  const currentValidity = validityPatch ? await loadEpisodeValidityBounds(executor, id) : null;

  if (validityPatch && currentValidity === null) {
    return false;
  }

  if (currentValidity) {
    const nextValidity = validateTemporalValidityRange(
      fields.validFrom !== undefined ? normalizeOptionalString(fields.validFrom) : currentValidity.validFrom,
      fields.validTo !== undefined ? normalizeOptionalString(fields.validTo) : currentValidity.validTo,
    );
    if (!nextValidity.ok) {
      throw new Error(nextValidity.message);
    }
  }

  addOptionalStringAssignment(assignments, args, "source_ref", fields.sourceRef);
  addOptionalStringAssignment(assignments, args, "surface", fields.surface);
  addOptionalStringAssignment(assignments, args, "user_id", fields.userId);
  addOptionalStringAssignment(assignments, args, "project", fields.project);

  if (fields.activityLevel !== undefined) {
    assignments.push("activity_level = ?");
    args.push(normalizeOptionalString(fields.activityLevel));
  }

  if (fields.tags !== undefined) {
    assignments.push("tags = ?");
    args.push(JSON.stringify(fields.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)));
  }

  addOptionalStringAssignment(assignments, args, "valid_from", fields.validFrom);
  addOptionalStringAssignment(assignments, args, "valid_to", fields.validTo);

  if (assignments.length === 0) {
    return false;
  }

  assignments.push("updated_at = ?");
  args.push(new Date().toISOString(), id.trim());

  const result = await executor.execute({
    sql: `
      UPDATE episodes
      SET ${assignments.join(", ")}
      WHERE id = ?
        AND ${ACTIVE_EPISODE_CLAUSE}
    `,
    args,
  });

  return result.rowsAffected > 0;
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

/** Adds a nullable string replacement assignment when the field is present. */
function addOptionalStringAssignment(assignments: string[], args: Array<number | string | null>, column: string, value: string | undefined): void {
  if (value === undefined) {
    return;
  }

  assignments.push(`${column} = ?`);
  args.push(normalizeOptionalString(value));
}

/** Converts empty strings to null-bound values for persistence. */
function normalizeOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** Loads the currently persisted active validity bounds for one episode. */
async function loadEpisodeValidityBounds(executor: SqlExecutor, id: string): Promise<{ validFrom?: string; validTo?: string } | null> {
  const result = await executor.execute({
    sql: `
      SELECT valid_from, valid_to
      FROM episodes
      WHERE id = ?
        AND ${ACTIVE_EPISODE_CLAUSE}
      LIMIT 1
    `,
    args: [id.trim()],
  });

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    validFrom: typeof row.valid_from === "string" ? row.valid_from : undefined,
    validTo: typeof row.valid_to === "string" ? row.valid_to : undefined,
  };
}
