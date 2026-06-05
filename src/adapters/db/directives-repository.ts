import { MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX } from "../../core/directives/abstain.js";
import type { Durable } from "../../core/types.js";

import { buildActiveDurableClause, buildValidAsOfClause, DURABLE_SELECT_COLUMNS, mapDurableRow } from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";

/**
 * Upper bound on directive rows fetched per injection pass.
 *
 * Memory directives are expected to be few. Capping the lookup keeps a
 * misconfigured corpus from loading an unbounded directive set into every
 * session-start and before-turn pass.
 */
const MAX_ABSTAIN_DIRECTIVES = 50;

/**
 * Lists active, currently valid user memory directives.
 *
 * A directive is any active durable whose claim key lives in the
 * `user/memory_directive/*` family. Retired, superseded, and expired or
 * not-yet-valid rows are excluded so a directive only constrains injection
 * while it is actually in force.
 *
 * @param executor - SQL executor used for the lookup.
 * @returns Active memory-directive durables, most recently created first.
 */
export async function listActiveAbstainDirectives(executor: SqlExecutor): Promise<Durable[]> {
  const nowIso = new Date().toISOString();
  const result = await executor.execute({
    sql: `
      SELECT
        ${DURABLE_SELECT_COLUMNS}
      FROM durables
      WHERE ${buildActiveDurableClause()}
        AND claim_key LIKE ?
        AND ${buildValidAsOfClause()}
      ORDER BY created_at DESC
      LIMIT ?
    `,
    args: [`${MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX}%`, nowIso, nowIso, MAX_ABSTAIN_DIRECTIVES],
  });

  return result.rows.map((row) => mapDurableRow(row));
}
