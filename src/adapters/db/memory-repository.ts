import { buildDurableTraceProvenance, buildDurableTraceTimeline } from "../../app/memory/trace-timeline.js";
import { DURABLE_VECTOR_INDEX_NAME } from "./schema.js";
import { EMBEDDING_DIMENSIONS } from "../embeddings.js";
import type { ClaimFamily, DurableTrace, MemoryStatusSnapshot, MemoryRepository } from "../../app/memory/ports.js";
import { resolveClaimSlotPolicy, type ClaimSlotPolicyConfig } from "../../core/claim-slot-policy.js";
import type { Durable } from "../../core/types.js";
import { countRecallEventsForDurable, listDreamActionsForDurable, listProfileSnapshotsForDurable, listRecallEventsForDurable } from "./trace-queries.js";
import { buildActiveDurableClause, DURABLE_SELECT_COLUMNS, mapDurableRow, readNumber } from "./row-mapping.js";
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
    findDurableBySubject: async (subject) => findDurableBySubject(executor, subject),
    findMostRecentDurable: async () => findMostRecentDurable(executor),
    getDurableTrace: async (durableId) => getDurableTrace(executor, durableId, options.claimSlotPolicyConfig),
    getMemoryStatusSnapshot: async () => getMemoryStatusSnapshot(executor),
    probeVectorAvailability: async () => probeVectorAvailability(executor),
  };
}

/**
 * Finds the most recent durable that matches a subject string.
 *
 * Exact case-insensitive matches rank above substring matches.
 *
 * @param executor - SQL executor used for the lookup.
 * @param subject - Free-form subject text supplied by the caller.
 * @returns Matching durable from any state, or `null` when none match.
 */
async function findDurableBySubject(executor: SqlExecutor, subject: string): Promise<Durable | null> {
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
 * Finds the most recently created durable from any state.
 *
 * @param executor - SQL executor used for the lookup.
 * @returns Newest durable, or `null` when the database is empty.
 */
async function findMostRecentDurable(executor: SqlExecutor): Promise<Durable | null> {
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
 * Loads the currently available trace view for one durable.
 *
 * @param executor - SQL executor used for the lookup.
 * @param durableId - Durable identifier to trace.
 * @returns Minimal provenance facts for the requested durable, or `null` when missing.
 */
async function getDurableTrace(executor: SqlExecutor, durableId: string, claimSlotPolicyConfig?: ClaimSlotPolicyConfig): Promise<DurableTrace | null> {
  const durable = await getDurableByIdIncludingInactive(executor, durableId);
  if (!durable) {
    return null;
  }

  const [supersededBy, supersedes, claimFamily, recallTotalCount, recallEvents, dreamActions, profileSnapshots] = await Promise.all([
    durable.superseded_by ? getDurableByIdIncludingInactive(executor, durable.superseded_by) : Promise.resolve(null),
    listSupersededDurables(executor, durable.id),
    durable.claim_key ? getClaimFamily(executor, durable.claim_key, claimSlotPolicyConfig) : Promise.resolve(undefined),
    countRecallEventsForDurable(executor, durable.id),
    listRecallEventsForDurable(executor, durable.id),
    listDreamActionsForDurable(executor, durable.id),
    listProfileSnapshotsForDurable(executor, durable.id),
  ]);

  const recall = {
    totalCount: recallTotalCount,
    recentEvents: recallEvents,
  };

  return {
    durable,
    ...(supersededBy ? { supersededBy } : {}),
    supersedes,
    ...(claimFamily ? { claimFamily } : {}),
    recall,
    provenance: buildDurableTraceProvenance(durable),
    dreamActions,
    profileSnapshots,
    timeline: buildDurableTraceTimeline({
      durable,
      dreamActions,
      recallEvents,
      profileSnapshots,
    }),
  };
}

/**
 * Reads aggregate durable counts for host memory runtime status surfaces.
 *
 * @param executor - SQL executor used for the lookup.
 * @returns Count snapshot for active durables, active core durables, and distinct source files.
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
      activeDurables: 0,
      coreDurables: 0,
      sourceFiles: 0,
    };
  }

  return {
    // SQL aliases retain legacy column labels; the mapped fields use durable terminology.
    activeDurables: readNumber(row, "active_entries", 0),
    coreDurables: readNumber(row, "core_entries", 0),
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
 * Looks up a durable by ID without filtering out stale or superseded rows.
 *
 * @param executor - SQL executor used for the lookup.
 * @param durableId - Durable identifier to resolve.
 * @returns Durable from any state, or `null` when absent.
 */
async function getDurableByIdIncludingInactive(executor: SqlExecutor, durableId: string): Promise<Durable | null> {
  const normalizedId = durableId.trim();
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
 * Lists durables that the target durable superseded.
 *
 * @param executor - SQL executor used for the lookup.
 * @param durableId - Canonical durable identifier.
 * @returns Older durables that now point at the target via `superseded_by`.
 */
async function listSupersededDurables(executor: SqlExecutor, durableId: string): Promise<Durable[]> {
  const result = await executor.execute({
    sql: `
      SELECT
        ${DURABLE_SELECT_COLUMNS}
      FROM durables
      WHERE superseded_by = ?
      ORDER BY created_at DESC
    `,
    args: [durableId],
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
  const durables = result.rows.map((row) => mapDurableRow(row));

  const slotPolicy = resolveClaimSlotPolicy(normalizedClaimKey, claimSlotPolicyConfig);

  return {
    claimKey: normalizedClaimKey,
    slotPolicy: slotPolicy.policy,
    slotPolicyReason: slotPolicy.reason,
    durables,
  };
}
