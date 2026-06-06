import type { EntryRecallEvent, EntryTraceDreamAction, EntryTraceProfileSnapshot } from "../../app/memory/ports.js";
import { mapActionRow } from "./dreaming-run-shared.js";
import { readNumber, readOptionalString, readRequiredString } from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";

/** Maximum recall events returned by the trace read model. */
export const TRACE_RECALL_EVENT_LIMIT = 25;

/** Maximum dreaming actions returned by the trace read model. */
export const TRACE_DREAM_ACTION_LIMIT = 50;

/** Maximum profile snapshots returned by the trace read model. */
export const TRACE_PROFILE_SNAPSHOT_LIMIT = 10;

/**
 * Counts recall telemetry rows linked to one durable.
 *
 * @param executor - SQL executor used for the lookup.
 * @param entryId - Durable identifier to inspect.
 * @returns Total recall-event count for the durable.
 */
export async function countRecallEventsForDurable(executor: SqlExecutor, entryId: string): Promise<number> {
  const normalizedId = entryId.trim();
  if (normalizedId.length === 0) {
    return 0;
  }

  const result = await executor.execute({
    sql: `
      SELECT COUNT(*) AS total
      FROM recall_events
      WHERE durable_id = ?
    `,
    args: [normalizedId],
  });

  return readNumber(result.rows[0] ?? {}, "total", 0);
}

/**
 * Lists recent recall telemetry rows for one durable.
 *
 * @param executor - SQL executor used for the lookup.
 * @param entryId - Durable identifier to inspect.
 * @param limit - Maximum number of events to return.
 * @returns Recent recall events ordered newest first.
 */
export async function listRecallEventsForDurable(executor: SqlExecutor, entryId: string, limit = TRACE_RECALL_EVENT_LIMIT): Promise<EntryRecallEvent[]> {
  const normalizedId = entryId.trim();
  if (normalizedId.length === 0) {
    return [];
  }

  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TRACE_RECALL_EVENT_LIMIT;
  const result = await executor.execute({
    sql: `
      SELECT
        query,
        session_key,
        recalled_at
      FROM recall_events
      WHERE durable_id = ?
      ORDER BY recalled_at DESC
      LIMIT ?
    `,
    args: [normalizedId, safeLimit],
  });

  return result.rows.map((row) => ({
    query: readOptionalString(row, "query"),
    sessionKey: readOptionalString(row, "session_key"),
    recalledAt: readRequiredString(row, "recalled_at"),
  }));
}

/**
 * Lists dreaming audit actions that reference one durable.
 *
 * @param executor - SQL executor used for the lookup.
 * @param entryId - Durable identifier to inspect.
 * @param limit - Maximum number of actions to return.
 * @returns Dream actions ordered oldest first.
 */
export async function listDreamActionsForDurable(executor: SqlExecutor, entryId: string, limit = TRACE_DREAM_ACTION_LIMIT): Promise<EntryTraceDreamAction[]> {
  const normalizedId = entryId.trim();
  if (normalizedId.length === 0) {
    return [];
  }

  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TRACE_DREAM_ACTION_LIMIT;
  const result = await executor.execute({
    sql: `
      SELECT
        id,
        run_id,
        action_type,
        durable_ids,
        reasoning,
        details_json,
        created_at
      FROM dream_run_actions
      WHERE durable_id = ?
         OR EXISTS (
           SELECT 1
           FROM json_each(dream_run_actions.durable_ids) AS ids
           WHERE ids.value = ?
         )
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `,
    args: [normalizedId, normalizedId, safeLimit],
  });

  return result.rows.map((row) => {
    const action = mapActionRow(row);
    return {
      id: action.id,
      runId: action.runId,
      actionType: action.actionType,
      reasoning: action.reasoning,
      details: action.details ?? null,
      createdAt: action.createdAt,
    };
  });
}

/**
 * Lists profile snapshots that included one durable as a profile or directive row.
 *
 * @param executor - SQL executor used for the lookup.
 * @param entryId - Durable identifier to inspect.
 * @param limit - Maximum number of snapshots to return.
 * @returns Profile snapshots ordered newest first.
 */
export async function listProfileSnapshotsForDurable(
  executor: SqlExecutor,
  entryId: string,
  limit = TRACE_PROFILE_SNAPSHOT_LIMIT,
): Promise<EntryTraceProfileSnapshot[]> {
  const normalizedId = entryId.trim();
  if (normalizedId.length === 0) {
    return [];
  }

  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TRACE_PROFILE_SNAPSHOT_LIMIT;
  const result = await executor.execute({
    sql: `
      SELECT
        id,
        durable_ids,
        directive_ids,
        as_of,
        run_id,
        created_at
      FROM profile_snapshots
      WHERE EXISTS (
        SELECT 1
        FROM json_each(profile_snapshots.durable_ids) AS profile_ids
        WHERE profile_ids.value = ?
      )
      OR EXISTS (
        SELECT 1
        FROM json_each(COALESCE(profile_snapshots.directive_ids, '[]')) AS directive_ids
        WHERE directive_ids.value = ?
      )
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    args: [normalizedId, normalizedId, safeLimit],
  });

  return result.rows.map((row) => {
    const durableIds = parseJsonStringArray(readOptionalString(row, "durable_ids"));
    const role: EntryTraceProfileSnapshot["role"] = durableIds.includes(normalizedId) ? "profile" : "directive";

    return {
      id: readRequiredString(row, "id"),
      asOf: readRequiredString(row, "as_of"),
      runId: readOptionalString(row, "run_id") ?? null,
      createdAt: readRequiredString(row, "created_at"),
      role,
    };
  });
}

/** Parses a JSON string array field, retaining only string entries. */
function parseJsonStringArray(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}
