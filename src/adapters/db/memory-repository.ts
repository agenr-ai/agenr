import { DURABLE_VECTOR_INDEX_NAME } from "./schema.js";
import { EMBEDDING_DIMENSIONS } from "../embeddings.js";
import type { ClaimFamily, EntryTrace, MemoryStatusSnapshot, MemoryRepository, EntryRecallEvent } from "../../app/memory/ports.js";
import { resolveClaimSlotPolicy, type ClaimSlotPolicyConfig } from "../../core/claim-slot-policy.js";
import type { Durable } from "../../core/types.js";
import { buildActiveDurableClause, DURABLE_SELECT_COLUMNS, mapDurableRow, readNumber, readOptionalString, readRequiredString } from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";

const ZERO_VECTOR = JSON.stringify(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0));

/**
 * Creates the DB-backed memory repository used by adapter-facing runtime code.
 *
 * @param executor - SQL executor used for all memory read-model queries.
 * @param options - Optional read-side policy overrides for claim-aware surfaces.
 * @returns Repository that hides DB internals behind feature-scoped methods.
 */
export function createMemoryRepository(
  executor: SqlExecutor,
  options: {
    claimSlotPolicyConfig?: ClaimSlotPolicyConfig;
  } = {},
): MemoryRepository {
  return {
    findEntryBySubject: async (subject) => findEntryBySubject(executor, subject),
    findMostRecentEntry: async () => findMostRecentEntry(executor),
    getEntryTrace: async (entryId) => getEntryTrace(executor, entryId, options.claimSlotPolicyConfig),
    getMemoryStatusSnapshot: async () => getMemoryStatusSnapshot(executor),
    probeVectorAvailability: async () => probeVectorAvailability(executor),
  };
}

/**
 * Finds the most recent entry that matches a subject string.
 *
 * Exact case-insensitive matches rank above substring matches.
 *
 * @param executor - SQL executor used for the lookup.
 * @param subject - Free-form subject text supplied by the caller.
 * @returns Matching entry from any state, or `null` when none match.
 */
async function findEntryBySubject(executor: SqlExecutor, subject: string): Promise<Durable | null> {
  const normalizedSubject = subject.trim();
  if (normalizedSubject.length === 0) {
    return null;
  }

  const result = await executor.execute({
    sql: `
      SELECT
        ${DURABLE_SELECT_COLUMNS},
        CASE
          WHEN lower(subject) = lower(?) THEN 0
          WHEN lower(subject) LIKE lower(?) THEN 1
          ELSE 2
        END AS match_rank
      FROM durables
      WHERE lower(subject) = lower(?)
         OR lower(subject) LIKE lower(?)
      ORDER BY match_rank ASC, created_at DESC
      LIMIT 1
    `,
    args: [normalizedSubject, `%${normalizedSubject}%`, normalizedSubject, `%${normalizedSubject}%`],
  });

  const row = result.rows[0];
  return row ? mapDurableRow(row) : null;
}

/**
 * Finds the most recently created entry from any state.
 *
 * @param executor - SQL executor used for the lookup.
 * @returns Newest entry, or `null` when the database is empty.
 */
async function findMostRecentEntry(executor: SqlExecutor): Promise<Durable | null> {
  const result = await executor.execute({
    sql: `
      SELECT
        ${DURABLE_SELECT_COLUMNS}
      FROM durables
      ORDER BY created_at DESC
      LIMIT 1
    `,
  });

  const row = result.rows[0];
  return row ? mapDurableRow(row) : null;
}

/**
 * Loads the currently available trace view for one entry.
 *
 * @param executor - SQL executor used for the lookup.
 * @param entryId - Entry identifier to trace.
 * @returns Minimal provenance facts for the requested entry, or `null` when missing.
 */
async function getEntryTrace(executor: SqlExecutor, entryId: string, claimSlotPolicyConfig?: ClaimSlotPolicyConfig): Promise<EntryTrace | null> {
  const entry = await getDurableByIdIncludingInactive(executor, entryId);
  if (!entry) {
    return null;
  }

  const [supersededBy, supersedes, claimFamily, recallEvents] = await Promise.all([
    entry.superseded_by ? getDurableByIdIncludingInactive(executor, entry.superseded_by) : Promise.resolve(null),
    listSupersededEntries(executor, entry.id),
    entry.claim_key ? getClaimFamily(executor, entry.claim_key, claimSlotPolicyConfig) : Promise.resolve(undefined),
    listRecallEvents(executor, entry.id),
  ]);

  return {
    entry,
    ...(supersededBy ? { supersededBy } : {}),
    supersedes,
    ...(claimFamily ? { claimFamily } : {}),
    recallEvents,
  };
}

/**
 * Reads aggregate entry counts for host memory runtime status surfaces.
 *
 * @param executor - SQL executor used for the lookup.
 * @returns Count snapshot for active entries, active core entries, and distinct source files.
 */
async function getMemoryStatusSnapshot(executor: SqlExecutor): Promise<MemoryStatusSnapshot> {
  const result = await executor.execute({
    sql: `
      SELECT
        COUNT(*) AS active_entries,
        SUM(CASE WHEN expiry = 'core' THEN 1 ELSE 0 END) AS core_entries,
        COUNT(DISTINCT source_file) AS source_files
      FROM durables
      WHERE ${buildActiveDurableClause()}
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
 * Checks whether the libSQL vector extension and agenr index are usable.
 *
 * @param executor - SQL executor used for the probe query.
 * @returns `true` when vector search can run successfully.
 */
async function probeVectorAvailability(executor: SqlExecutor): Promise<boolean> {
  try {
    await executor.execute({
      sql: `
        SELECT COUNT(*) AS matches
        FROM vector_top_k('${DURABLE_VECTOR_INDEX_NAME}', vector32(?), ?) AS matches
      `,
      args: [ZERO_VECTOR, 1],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Looks up an entry by ID without filtering out retired or superseded rows.
 *
 * @param executor - SQL executor used for the lookup.
 * @param entryId - Entry identifier to resolve.
 * @returns Entry from any state, or `null` when absent.
 */
async function getDurableByIdIncludingInactive(executor: SqlExecutor, entryId: string): Promise<Durable | null> {
  const normalizedId = entryId.trim();
  if (normalizedId.length === 0) {
    return null;
  }

  const result = await executor.execute({
    sql: `
      SELECT
        ${DURABLE_SELECT_COLUMNS}
      FROM durables
      WHERE id = ?
      LIMIT 1
    `,
    args: [normalizedId],
  });

  const row = result.rows[0];
  return row ? mapDurableRow(row) : null;
}

/**
 * Lists entries that the target entry superseded.
 *
 * @param executor - SQL executor used for the lookup.
 * @param entryId - Canonical entry identifier.
 * @returns Older entries that now point at the target via `superseded_by`.
 */
async function listSupersededEntries(executor: SqlExecutor, entryId: string): Promise<Durable[]> {
  const result = await executor.execute({
    sql: `
      SELECT
        ${DURABLE_SELECT_COLUMNS}
      FROM durables
      WHERE superseded_by = ?
      ORDER BY created_at DESC
    `,
    args: [entryId],
  });

  return result.rows.map((row) => mapDurableRow(row));
}

/**
 * Loads the narrow same-claim-key family view used by trace inspection.
 *
 * @param executor - SQL executor used for the lookup.
 * @param claimKey - Shared claim key to inspect.
 * @returns Ordered claim family, or undefined when the key is empty.
 */
async function getClaimFamily(executor: SqlExecutor, claimKey: string, claimSlotPolicyConfig?: ClaimSlotPolicyConfig): Promise<ClaimFamily | undefined> {
  const normalizedClaimKey = claimKey.trim();
  if (normalizedClaimKey.length === 0) {
    return undefined;
  }

  const result = await executor.execute({
    sql: `
      SELECT
        ${DURABLE_SELECT_COLUMNS}
      FROM durables
      WHERE claim_key = ?
      ORDER BY created_at ASC, id ASC
    `,
    args: [normalizedClaimKey],
  });
  const entries = result.rows.map((row) => mapDurableRow(row));

  const slotPolicy = resolveClaimSlotPolicy(normalizedClaimKey, claimSlotPolicyConfig);

  return {
    claimKey: normalizedClaimKey,
    slotPolicy: slotPolicy.policy,
    slotPolicyReason: slotPolicy.reason,
    entries,
  };
}

/**
 * Lists recent recall telemetry rows for one entry.
 *
 * @param executor - SQL executor used for the lookup.
 * @param entryId - Entry identifier to inspect.
 * @returns Recent recall events ordered newest first.
 */
async function listRecallEvents(executor: SqlExecutor, entryId: string): Promise<EntryRecallEvent[]> {
  const result = await executor.execute({
    sql: `
      SELECT
        query,
        session_key,
        recalled_at
      FROM recall_events
      WHERE durable_id = ?
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
