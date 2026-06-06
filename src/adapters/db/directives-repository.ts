import { MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX } from "../../core/directives/model.js";
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
const MAX_DIRECTIVES = 50;

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
export async function listActiveAbstainDirectives(executor: SqlExecutor, now = new Date()): Promise<Durable[]> {
  const nowIso = now.toISOString();
  const result = await executor.execute({
    sql: `
      SELECT
        ${DURABLE_SELECT_COLUMNS}
      FROM durables
      WHERE ${buildActiveDurableClause()}
        AND (
          (type = 'directive' AND directive_polarity = 'abstain')
          OR (claim_key LIKE ? AND (directive_polarity IS NULL OR directive_polarity = 'abstain'))
        )
        AND ${buildValidAsOfClause()}
      ORDER BY created_at DESC
      LIMIT ?
    `,
    args: [`${MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX}%`, nowIso, nowIso, MAX_DIRECTIVES],
  });

  return result.rows.map((row) => mapDurableRow(row));
}

/**
 * Lists active proactive directives that should surface at session start.
 *
 * @param executor - SQL executor used for the lookup.
 * @returns Active proactive directive durables, highest priority first.
 */
export async function listActiveSessionStartProactiveDirectives(executor: SqlExecutor, now = new Date()): Promise<Durable[]> {
  const nowIso = now.toISOString();
  const result = await executor.execute({
    sql: `
      SELECT
        ${DURABLE_SELECT_COLUMNS}
      FROM durables
      WHERE ${buildActiveDurableClause()}
        AND type = 'directive'
        AND directive_polarity = 'proactive'
        AND directive_trigger IN ('session_start', 'always')
        AND ${buildValidAsOfClause()}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `,
    args: [nowIso, nowIso, MAX_DIRECTIVES],
  });

  return result.rows.map((row) => mapDurableRow(row));
}

/**
 * Lists active proactive directives whose trigger is topic-scoped.
 *
 * @param executor - SQL executor used for the lookup.
 * @returns Active topic-triggered proactive directive durables, highest priority first.
 */
export async function listActiveTopicProactiveDirectives(executor: SqlExecutor, now = new Date()): Promise<Durable[]> {
  const nowIso = now.toISOString();
  const result = await executor.execute({
    sql: `
      SELECT
        ${DURABLE_SELECT_COLUMNS}
      FROM durables
      WHERE ${buildActiveDurableClause()}
        AND type = 'directive'
        AND directive_polarity = 'proactive'
        AND directive_trigger LIKE 'topic:%'
        AND ${buildValidAsOfClause()}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `,
    args: [nowIso, nowIso, MAX_DIRECTIVES],
  });

  return result.rows.map((row) => mapDurableRow(row));
}
