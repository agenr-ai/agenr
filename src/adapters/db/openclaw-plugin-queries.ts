import type { Entry } from "../../core/types.js";
import { buildActiveEntryClause, mapEntryRow, readNumber, readOptionalString, readRequiredString } from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";

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
  valid_from,
  valid_to,
  claim_key,
  supersession_kind,
  supersession_reason,
  cluster_id,
  user_id,
  project,
  retired,
  retired_at,
  retired_reason,
  created_at,
  updated_at
`;

/**
 * Recent recall event metadata returned by the OpenClaw trace tool.
 */
export interface OpenClawRecallEvent {
  query?: string;
  sessionKey?: string;
  recalledAt: string;
}

/**
 * Minimal provenance view available from the current v1 schema.
 */
export interface OpenClawEntryTrace {
  entry: Entry;
  supersededBy?: Entry;
  supersedes: Entry[];
  recallEvents: OpenClawRecallEvent[];
}

/**
 * Aggregate memory status facts used by the OpenClaw memory runtime.
 */
export interface OpenClawMemoryStatusSnapshot {
  activeEntries: number;
  coreEntries: number;
  sourceFiles: number;
}

/**
 * Lists high-priority core entries for session-start prompt injection.
 *
 * @param executor - SQL executor used for the lookup.
 * @param limit - Maximum number of entries to return.
 * @returns Active core entries ordered by importance and recency.
 */
export async function listOpenClawCoreEntries(executor: SqlExecutor, limit: number): Promise<Entry[]> {
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

/**
 * Finds the most recent entry that matches a subject string.
 *
 * Exact case-insensitive matches rank above substring matches.
 *
 * @param executor - SQL executor used for the lookup.
 * @param subject - Free-form subject text supplied by the caller.
 * @returns Matching entry from any state, or null when none match.
 */
export async function findOpenClawEntryBySubject(executor: SqlExecutor, subject: string): Promise<Entry | null> {
  const normalizedSubject = subject.trim();
  if (normalizedSubject.length === 0) {
    return null;
  }

  const result = await executor.execute({
    sql: `
      SELECT
        ${ENTRY_SELECT_COLUMNS},
        CASE
          WHEN lower(subject) = lower(?) THEN 0
          WHEN lower(subject) LIKE lower(?) THEN 1
          ELSE 2
        END AS match_rank
      FROM entries
      WHERE lower(subject) = lower(?)
         OR lower(subject) LIKE lower(?)
      ORDER BY match_rank ASC, created_at DESC
      LIMIT 1
    `,
    args: [normalizedSubject, `%${normalizedSubject}%`, normalizedSubject, `%${normalizedSubject}%`],
  });

  const row = result.rows[0];
  return row ? mapEntryRow(row) : null;
}

/**
 * Finds the most recently created entry from any state.
 *
 * @param executor - SQL executor used for the lookup.
 * @returns Newest entry, or null when the database is empty.
 */
export async function findOpenClawMostRecentEntry(executor: SqlExecutor): Promise<Entry | null> {
  const result = await executor.execute({
    sql: `
      SELECT
        ${ENTRY_SELECT_COLUMNS}
      FROM entries
      ORDER BY created_at DESC
      LIMIT 1
    `,
  });

  const row = result.rows[0];
  return row ? mapEntryRow(row) : null;
}

/**
 * Loads the currently available trace view for one entry.
 *
 * The v1 schema does not yet store a full provenance graph, so this trace only
 * exposes retirement and supersession relationships plus recent recall events.
 *
 * @param executor - SQL executor used for the lookup.
 * @param entryId - Entry identifier to trace.
 * @returns Minimal provenance facts for the requested entry, or null when missing.
 */
export async function getOpenClawEntryTrace(executor: SqlExecutor, entryId: string): Promise<OpenClawEntryTrace | null> {
  const entry = await getEntryByIdIncludingInactive(executor, entryId);
  if (!entry) {
    return null;
  }

  const [supersededBy, supersedes, recallEvents] = await Promise.all([
    entry.superseded_by ? getEntryByIdIncludingInactive(executor, entry.superseded_by) : Promise.resolve(null),
    listSupersededEntries(executor, entry.id),
    listRecallEvents(executor, entry.id),
  ]);

  return {
    entry,
    ...(supersededBy ? { supersededBy } : {}),
    supersedes,
    recallEvents,
  };
}

/**
 * Reads aggregate entry counts for the OpenClaw memory runtime status surface.
 *
 * @param executor - SQL executor used for the lookup.
 * @returns Count snapshot for active entries, active core entries, and distinct source files.
 */
export async function getOpenClawMemoryStatusSnapshot(executor: SqlExecutor): Promise<OpenClawMemoryStatusSnapshot> {
  const result = await executor.execute({
    sql: `
      SELECT
        COUNT(*) AS active_entries,
        SUM(CASE WHEN expiry = 'core' THEN 1 ELSE 0 END) AS core_entries,
        COUNT(DISTINCT source_file) AS source_files
      FROM entries
      WHERE ${buildActiveEntryClause()}
    `,
  });

  const row = result.rows[0];
  if (!row) {
    return {
      activeEntries: 0,
      coreEntries: 0,
      sourceFiles: 0,
    };
  }

  return {
    activeEntries: readNumber(row, "active_entries", 0),
    coreEntries: readNumber(row, "core_entries", 0),
    sourceFiles: readNumber(row, "source_files", 0),
  };
}

/**
 * Looks up an entry by ID without filtering out retired or superseded rows.
 *
 * @param executor - SQL executor used for the lookup.
 * @param entryId - Entry identifier to resolve.
 * @returns Entry from any state, or null when absent.
 */
async function getEntryByIdIncludingInactive(executor: SqlExecutor, entryId: string): Promise<Entry | null> {
  const normalizedId = entryId.trim();
  if (normalizedId.length === 0) {
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
    args: [normalizedId],
  });

  const row = result.rows[0];
  return row ? mapEntryRow(row) : null;
}

/**
 * Lists entries that the target entry superseded.
 *
 * @param executor - SQL executor used for the lookup.
 * @param entryId - Canonical entry identifier.
 * @returns Older entries that now point at the target via `superseded_by`.
 */
async function listSupersededEntries(executor: SqlExecutor, entryId: string): Promise<Entry[]> {
  const result = await executor.execute({
    sql: `
      SELECT
        ${ENTRY_SELECT_COLUMNS}
      FROM entries
      WHERE superseded_by = ?
      ORDER BY created_at DESC
    `,
    args: [entryId],
  });

  return result.rows.map((row) => mapEntryRow(row));
}

/**
 * Lists recent recall events for one entry.
 *
 * @param executor - SQL executor used for the lookup.
 * @param entryId - Entry identifier to resolve.
 * @returns Recent recall event metadata ordered from newest to oldest.
 */
async function listRecallEvents(executor: SqlExecutor, entryId: string): Promise<OpenClawRecallEvent[]> {
  const result = await executor.execute({
    sql: `
      SELECT
        query,
        session_key,
        recalled_at
      FROM recall_events
      WHERE entry_id = ?
      ORDER BY recalled_at DESC
      LIMIT 10
    `,
    args: [entryId],
  });

  return result.rows.map((row) => ({
    query: readOptionalString(row, "query"),
    sessionKey: readOptionalString(row, "session_key"),
    recalledAt: readRequiredString(row, "recalled_at"),
  }));
}
