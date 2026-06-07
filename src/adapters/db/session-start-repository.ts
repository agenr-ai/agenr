import type { SessionStartRepository } from "../../app/session-start/index.js";
import type { Durable } from "../../core/types.js";

import { parseJsonStringArray } from "./dreaming-run-shared.js";
import {
  buildActiveDurableClause,
  buildValidAsOfClause,
  DURABLE_SELECT_COLUMNS,
  mapDurableRow,
  readOptionalString,
  readRequiredString,
} from "./row-mapping.js";
import { getDurables, type SqlExecutor } from "./queries.js";

/**
 * Creates the DB-backed repository used by the app-layer session-start service.
 *
 * @param executor - SQL executor used for session-start durable-memory lookups.
 * @returns Feature-scoped repository for session-start selection.
 */
export function createSessionStartRepository(executor: SqlExecutor): SessionStartRepository {
  return {
    listCoreDurables: async (limit, now) => listCoreDurables(executor, limit, now),
    getActiveProfileSnapshot: async (maxAgeMs, now) => getActiveProfileSnapshot(executor, maxAgeMs, now),
    listDurablesByIds: async (ids) => getDurables(executor, ids),
  };
}

/**
 * Loads the active profile snapshot when it is younger than the supplied age.
 *
 * @param executor - SQL executor used for the lookup.
 * @param maxAgeMs - Maximum allowed snapshot age.
 * @returns Active profile snapshot metadata, or null.
 */
async function getActiveProfileSnapshot(
  executor: SqlExecutor,
  maxAgeMs: number,
  now = new Date(),
): Promise<Awaited<ReturnType<SessionStartRepository["getActiveProfileSnapshot"]>>> {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return null;
  }

  const minCreatedAt = new Date(now.getTime() - maxAgeMs).toISOString();
  const result = await executor.execute({
    sql: `
      SELECT
        p.id,
        p.durable_ids,
        p.directive_ids,
        p.as_of,
        p.run_id,
        p.created_at
      FROM dream_state AS s
      JOIN profile_snapshots AS p ON p.id = s.active_profile_snapshot_id
      WHERE s.id = 'default'
        AND datetime(p.created_at) >= datetime(?)
      LIMIT 1
    `,
    args: [minCreatedAt],
  });

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: readRequiredString(row, "id"),
    durableIds: parseJsonStringArray(readOptionalString(row, "durable_ids")),
    directiveIds: parseJsonStringArray(readOptionalString(row, "directive_ids")),
    asOf: readRequiredString(row, "as_of"),
    runId: readOptionalString(row, "run_id") ?? null,
    createdAt: readRequiredString(row, "created_at"),
  };
}

/**
 * Lists active always-on core entries ordered for session-start use.
 *
 * @param executor - SQL executor used for the lookup.
 * @param limit - Maximum number of entries to return.
 * @returns Active core entries ordered by importance and recency.
 */
async function listCoreDurables(executor: SqlExecutor, limit: number, now = new Date()): Promise<Durable[]> {
  if (limit <= 0) {
    return [];
  }

  // Filter expired and not-yet-valid core durables in SQL so the LIMIT applies
  // to rows that are actually valid right now. Without this guard a core row
  // whose valid_to has already passed could auto-inject at session start, which
  // is exactly the stale-memory failure the dreaming program closes.
  const nowIso = now.toISOString();
  const result = await executor.execute({
    sql: `
      SELECT
        ${DURABLE_SELECT_COLUMNS}
      FROM durables
      WHERE ${buildActiveDurableClause()}
        AND expiry = 'core'
        AND ${buildValidAsOfClause()}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `,
    args: [nowIso, nowIso, limit],
  });

  return result.rows.map((row) => mapDurableRow(row));
}
