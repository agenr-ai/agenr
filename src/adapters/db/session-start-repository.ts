import type { SessionStartRepository } from "../../app/session-start/index.js";
import type { Entry } from "../../core/types.js";

import { buildActiveEntryClause, ENTRY_SELECT_COLUMNS, mapEntryRow } from "./row-mapping.js";
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
async function listCoreEntries(executor: SqlExecutor, limit: number): Promise<Entry[]> {
  if (limit <= 0) {
    return [];
  }

  const result = await executor.execute({
    sql: `
      SELECT
        ${ENTRY_SELECT_COLUMNS}
      FROM entries
      WHERE ${buildActiveEntryClause()}
        AND expiry = 'core'
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `,
    args: [limit],
  });

  return result.rows.map((row) => mapEntryRow(row));
}
