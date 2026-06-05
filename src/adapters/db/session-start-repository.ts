import type { SessionStartRepository } from "../../app/session-start/index.js";
import type { Durable } from "../../core/types.js";

import { buildActiveDurableClause, buildValidAsOfClause, DURABLE_SELECT_COLUMNS, mapDurableRow } from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";

/**
 * Creates the DB-backed repository used by the app-layer session-start service.
 *
 * @param executor - SQL executor used for session-start durable-memory lookups.
 * @returns Feature-scoped repository for session-start selection.
 */
export function createSessionStartRepository(executor: SqlExecutor): SessionStartRepository {
  return {
    listCoreEntries: async (limit) => listCoreEntries(executor, limit),
  };
}

/**
 * Lists active always-on core entries ordered for session-start use.
 *
 * @param executor - SQL executor used for the lookup.
 * @param limit - Maximum number of entries to return.
 * @returns Active core entries ordered by importance and recency.
 */
async function listCoreEntries(executor: SqlExecutor, limit: number): Promise<Durable[]> {
  if (limit <= 0) {
    return [];
  }

  // Filter expired and not-yet-valid core durables in SQL so the LIMIT applies
  // to rows that are actually valid right now. Without this guard a core row
  // whose valid_to has already passed could auto-inject at session start, which
  // is exactly the stale-memory failure the dreaming program closes.
  const nowIso = new Date().toISOString();
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
