import { randomUUID } from "node:crypto";

import type { InArgs, InStatement, ResultSet } from "@libsql/client";

import { validateDirectClaimKeyLifecycleUpdate } from "../../core/claim-key-lifecycle.js";
import type { ClaimKeyEntityPrefixStats } from "../../core/claim-key-entity-family.js";
import { validateTemporalValidityRange } from "../../core/temporal-validity.js";
import type { Durable, DurableUpdateInput } from "../../core/types.js";
import { ACTIVE_DURABLE_CLAUSE, DURABLE_SELECT_COLUMNS, mapDurableRow, readRequiredString, serializeEmbeddingForVector, serializeTags } from "./row-mapping.js";

const LOOKUP_CHUNK_SIZE = 100;
const DEFAULT_QUALITY_SCORE = 0.5;

/**
 * Minimal SQL executor contract shared by libSQL clients and transactions.
 */
export interface SqlExecutor {
  /**
   * Executes a single SQL statement.
   *
   * @param stmt - Statement object with SQL and optional bound arguments.
   * @returns Result set for the executed statement.
   */
  execute(stmt: InStatement): Promise<ResultSet>;

  /**
   * Executes a single SQL statement with positional or named arguments.
   *
   * @param sql - SQL text to run.
   * @param args - Bound arguments for the statement.
   * @returns Result set for the executed statement.
   */
  execute(sql: string, args?: InArgs): Promise<ResultSet>;
}

/**
 * Inserts an entry row and returns the persisted entry ID.
 *
 * @param executor - SQL executor used for the insert.
 * @param entry - Canonical entry payload to persist.
 * @param embedding - Embedding vector to store with the entry.
 * @param contentHash - Stable content hash for dedup checks.
 * @returns Persisted entry ID.
 */
export async function insertDurable(executor: SqlExecutor, entry: Durable, embedding: number[], contentHash: string): Promise<string> {
  const now = new Date().toISOString();
  const id = entry.id.trim().length > 0 ? entry.id.trim() : randomUUID();
  const createdAt = normalizeTimestamp(entry.created_at) ?? now;
  const updatedAt = normalizeTimestamp(entry.updated_at) ?? now;
  const vectorJson = serializeEmbeddingForVector(embedding);
  await executor.execute({
    sql: `
      INSERT INTO durables (
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
        directive_polarity,
        directive_trigger,
        claim_key,
        claim_key_raw,
        claim_key_status,
        claim_key_source,
        claim_key_confidence,
        claim_key_rationale,
        claim_support_source_kind,
        claim_support_locator,
        claim_support_observed_at,
        claim_support_mode,
        supersession_kind,
        supersession_reason,
        user_id,
        project,
        created_at,
        updated_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        CASE WHEN ? IS NULL THEN NULL ELSE vector32(?) END,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `,
    args: [
      id,
      entry.type,
      entry.subject,
      entry.content,
      normalizeInteger(entry.importance, 0),
      entry.expiry,
      serializeTags(entry.tags),
      normalizeOptionalString(entry.source_file),
      normalizeOptionalString(entry.source_context),
      vectorJson,
      vectorJson,
      contentHash.trim(),
      normalizeOptionalString(entry.norm_content_hash),
      normalizeNumber(entry.quality_score, DEFAULT_QUALITY_SCORE),
      normalizeInteger(entry.recall_count, 0),
      normalizeOptionalString(entry.last_recalled_at),
      normalizeOptionalString(entry.superseded_by),
      normalizeOptionalString(entry.valid_from),
      normalizeOptionalString(entry.valid_to),
      normalizeOptionalString(entry.directive_polarity),
      normalizeOptionalString(entry.directive_trigger),
      normalizeOptionalString(entry.claim_key),
      normalizeOptionalString(entry.claim_key_raw),
      normalizeOptionalString(entry.claim_key_status),
      normalizeOptionalString(entry.claim_key_source),
      normalizeOptionalNumber(entry.claim_key_confidence),
      normalizeOptionalString(entry.claim_key_rationale),
      normalizeOptionalString(entry.claim_support_source_kind),
      normalizeOptionalString(entry.claim_support_locator),
      normalizeOptionalString(entry.claim_support_observed_at),
      normalizeOptionalString(entry.claim_support_mode),
      normalizeOptionalString(entry.supersession_kind),
      normalizeOptionalString(entry.supersession_reason),
      normalizeOptionalString(entry.user_id),
      normalizeOptionalString(entry.project),
      createdAt,
      updatedAt,
    ],
  });

  return id;
}

/**
 * Fetches active entries by ID, preserving the input order.
 *
 * @param executor - SQL executor used for the lookup.
 * @param ids - Entry IDs to resolve.
 * @returns Active entries for the requested IDs.
 */
export async function getDurables(executor: SqlExecutor, ids: string[]): Promise<Durable[]> {
  const normalizedIds = dedupeStrings(ids);
  if (normalizedIds.length === 0) {
    return [];
  }

  const byId = new Map<string, Durable>();
  for (const chunk of chunkValues(normalizedIds, LOOKUP_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await executor.execute({
      sql: `
        SELECT
          ${DURABLE_SELECT_COLUMNS}
        FROM durables
        WHERE id IN (${placeholders})
          AND ${ACTIVE_DURABLE_CLAUSE}
      `,
      args: chunk,
    });

    for (const row of result.rows) {
      const entry = mapDurableRow(row);
      byId.set(entry.id, entry);
    }
  }

  return ids.map((id) => byId.get(id.trim())).filter((entry): entry is Durable => entry !== undefined);
}

/**
 * Fetches a single active entry by ID.
 *
 * @param executor - SQL executor used for the lookup.
 * @param id - Entry ID to resolve.
 * @returns Active entry, or null when missing.
 */
export async function getDurable(executor: SqlExecutor, id: string): Promise<Durable | null> {
  const [entry] = await getDurables(executor, [id]);
  return entry ?? null;
}

/**
 * Finds which content hashes already exist among active entries.
 *
 * @param executor - SQL executor used for the lookup.
 * @param hashes - Candidate hashes to check.
 * @returns Set of hashes that already exist.
 */
export async function findExistingHashes(executor: SqlExecutor, hashes: string[]): Promise<Set<string>> {
  const normalizedHashes = dedupeStrings(hashes);
  if (normalizedHashes.length === 0) {
    return new Set();
  }

  const matches = new Set<string>();
  for (const chunk of chunkValues(normalizedHashes, LOOKUP_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await executor.execute({
      sql: `
        SELECT DISTINCT content_hash
        FROM durables
        WHERE content_hash IN (${placeholders})
          AND ${ACTIVE_DURABLE_CLAUSE}
      `,
      args: chunk,
    });

    for (const row of result.rows) {
      matches.add(readRequiredString(row, "content_hash"));
    }
  }

  return matches;
}

/**
 * Finds which normalized content hashes already exist among active entries.
 *
 * @param executor - SQL executor used for the lookup.
 * @param hashes - Candidate normalized hashes to check.
 * @returns Set of normalized hashes that already exist.
 */
export async function findExistingNormHashes(executor: SqlExecutor, hashes: string[]): Promise<Set<string>> {
  const normalizedHashes = dedupeStrings(hashes);
  if (normalizedHashes.length === 0) {
    return new Set();
  }

  const matches = new Set<string>();
  for (const chunk of chunkValues(normalizedHashes, LOOKUP_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await executor.execute({
      sql: `
        SELECT DISTINCT norm_content_hash
        FROM durables
        WHERE norm_content_hash IN (${placeholders})
          AND ${ACTIVE_DURABLE_CLAUSE}
      `,
      args: chunk,
    });

    for (const row of result.rows) {
      matches.add(readRequiredString(row, "norm_content_hash"));
    }
  }

  return matches;
}

/**
 * Closes the valid-time window for one active entry, making it stale for current recall.
 *
 * @param executor - SQL executor used for the update.
 * @param id - Entry ID to stale.
 * @param reason - Optional explanation recorded on the entry.
 * @returns True when an active row was updated.
 */
export async function closeDurableValidity(executor: SqlExecutor, id: string, reason?: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await executor.execute({
    sql: `
      UPDATE durables
      SET valid_to = ?,
          supersession_kind = 'stale',
          supersession_reason = ?,
          updated_at = ?
      WHERE id = ?
        AND ${ACTIVE_DURABLE_CLAUSE}
    `,
    args: [now, normalizeOptionalString(reason), now, id],
  });

  return result.rowsAffected > 0;
}

/**
 * Marks one active entry as superseded by a newer replacement entry.
 *
 * @param executor - SQL executor used for the update.
 * @param oldId - Active entry that should become historical.
 * @param newId - Replacement entry identifier.
 * @param kind - Optional explicit supersession relationship.
 * @param reason - Optional explanation recorded on the superseded entry.
 * @returns True when the target entry was active and updated.
 */
export async function supersedeDurable(executor: SqlExecutor, oldId: string, newId: string, kind?: string, reason?: string): Promise<boolean> {
  const normalizedOldId = oldId.trim();
  const normalizedNewId = newId.trim();
  if (normalizedOldId.length === 0 || normalizedNewId.length === 0 || normalizedOldId === normalizedNewId) {
    return false;
  }

  const existing = await executor.execute({
    sql: `
      SELECT id
      FROM durables
      WHERE id = ?
        AND ${ACTIVE_DURABLE_CLAUSE}
      LIMIT 1
    `,
    args: [normalizedOldId],
  });

  if (existing.rows.length === 0) {
    return false;
  }

  const now = new Date().toISOString();
  const result = await executor.execute({
    sql: `
      UPDATE durables
      SET superseded_by = ?,
          supersession_kind = ?,
          supersession_reason = ?,
          updated_at = ?
      WHERE id = ?
        AND superseded_by IS NULL
    `,
    args: [normalizedNewId, normalizeOptionalString(kind) ?? "update", normalizeOptionalString(reason), now, normalizedOldId],
  });

  return result.rowsAffected > 0;
}

/**
 * Loads active entries that share one claim key.
 *
 * @param executor - SQL executor used for the lookup.
 * @param claimKey - Canonical claim key to match.
 * @returns Active entries with the requested claim key.
 */
export async function findActiveDurablesByClaimKey(executor: SqlExecutor, claimKey: string): Promise<Durable[]> {
  const normalizedClaimKey = claimKey.trim();
  if (normalizedClaimKey.length === 0) {
    return [];
  }

  const result = await executor.execute({
    sql: `
      SELECT *
      FROM durables
      WHERE claim_key = ?
        AND ${ACTIVE_DURABLE_CLAUSE}
    `,
    args: [normalizedClaimKey],
  });

  return result.rows.map((row) => mapDurableRow(row));
}

/**
 * Lists distinct entity prefixes derived from active claim keys.
 *
 * @param executor - SQL executor used for the lookup.
 * @returns Sorted distinct entity prefixes such as `react` from `react/version` or `deploy_pipeline` from `deploy_pipeline/rollback_strategy`.
 */
export async function getDistinctClaimKeyPrefixes(executor: SqlExecutor): Promise<string[]> {
  const result = await executor.execute({
    sql: `
      SELECT DISTINCT lower(trim(substr(claim_key, 1, instr(claim_key, '/') - 1))) AS claim_key_prefix
      FROM durables
      WHERE claim_key IS NOT NULL
        AND instr(claim_key, '/') > 1
        AND ${ACTIVE_DURABLE_CLAUSE}
      ORDER BY claim_key_prefix ASC
    `,
  });

  return result.rows.flatMap((row) => {
    const prefix = row.claim_key_prefix;
    return typeof prefix === "string" && prefix.length > 0 ? [prefix] : [];
  });
}

/**
 * Lists bounded full claim-key examples ordered by frequency, importance, and recency.
 *
 * @param executor - SQL executor used for the lookup.
 * @param limit - Maximum number of examples to return.
 * @returns Ordered canonical claim keys suitable for extraction hinting.
 */
export async function getClaimKeyExamples(executor: SqlExecutor, limit = 8): Promise<string[]> {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 8;
  const result = await executor.execute({
    sql: `
      SELECT claim_key
      FROM durables
      WHERE claim_key IS NOT NULL
        AND ${ACTIVE_DURABLE_CLAUSE}
      GROUP BY claim_key
      ORDER BY COUNT(*) DESC, MAX(importance) DESC, MAX(created_at) DESC, claim_key ASC
      LIMIT ?
    `,
    args: [normalizedLimit],
  });

  return result.rows.flatMap((row) => {
    const claimKey = row.claim_key;
    return typeof claimKey === "string" && claimKey.length > 0 ? [claimKey] : [];
  });
}

/**
 * Lists active per-prefix claim-key counts used by conservative alias-family handling.
 *
 * @param executor - SQL executor used for the lookup.
 * @returns Ordered per-prefix counts across active keyed entries.
 */
export async function getClaimKeyEntityPrefixStats(executor: SqlExecutor): Promise<ClaimKeyEntityPrefixStats[]> {
  const result = await executor.execute({
    sql: `
      SELECT
        lower(trim(substr(claim_key, 1, instr(claim_key, '/') - 1))) AS claim_key_prefix,
        COUNT(*) AS active_durable_count,
        COALESCE(SUM(CASE WHEN claim_key_status = 'trusted' THEN 1 ELSE 0 END), 0) AS trusted_durable_count,
        COALESCE(SUM(CASE WHEN claim_key_status = 'tentative' THEN 1 ELSE 0 END), 0) AS tentative_durable_count,
        COALESCE(SUM(CASE WHEN claim_key_status = 'unresolved' THEN 1 ELSE 0 END), 0) AS unresolved_durable_count,
        COALESCE(SUM(CASE WHEN claim_key_source = 'deterministic_repair' THEN 1 ELSE 0 END), 0) AS deterministic_repair_durable_count,
        COALESCE(SUM(CASE WHEN claim_key_source = 'manual' THEN 1 ELSE 0 END), 0) AS manual_durable_count,
        COALESCE(SUM(CASE WHEN claim_key_source = 'model' THEN 1 ELSE 0 END), 0) AS model_durable_count,
        COALESCE(SUM(CASE WHEN claim_key_source = 'json_retry' THEN 1 ELSE 0 END), 0) AS json_retry_durable_count,
        COALESCE(SUM(CASE WHEN claim_key_source = 'dreaming_reconcile' THEN 1 ELSE 0 END), 0) AS dreaming_reconcile_durable_count
      FROM durables
      WHERE claim_key IS NOT NULL
        AND instr(claim_key, '/') > 1
        AND ${ACTIVE_DURABLE_CLAUSE}
      GROUP BY claim_key_prefix
      ORDER BY active_durable_count DESC, trusted_durable_count DESC, claim_key_prefix ASC
    `,
  });

  return result.rows.flatMap((row) => {
    const entityPrefix = row.claim_key_prefix;
    if (typeof entityPrefix !== "string" || entityPrefix.length === 0) {
      return [];
    }

    return [
      {
        entityPrefix,
        activeEntryCount: coerceRowInteger(row.active_durable_count),
        trustedEntryCount: coerceRowInteger(row.trusted_durable_count),
        tentativeEntryCount: coerceRowInteger(row.tentative_durable_count),
        unresolvedEntryCount: coerceRowInteger(row.unresolved_durable_count),
        deterministicRepairEntryCount: coerceRowInteger(row.deterministic_repair_durable_count),
        manualEntryCount: coerceRowInteger(row.manual_durable_count),
        modelEntryCount: coerceRowInteger(row.model_durable_count),
        jsonRetryEntryCount: coerceRowInteger(row.json_retry_durable_count),
        dreamingFamilyReuseDurableCount: coerceRowInteger(row.dreaming_reconcile_durable_count),
      } satisfies ClaimKeyEntityPrefixStats,
    ];
  });
}

/**
 * Updates mutable fields on an active entry.
 *
 * @param executor - SQL executor used for the update.
 * @param id - Entry ID to update.
 * @param fields - Mutable fields supported by the port contract.
 * @returns True when an active row was updated.
 */
export async function updateDurable(
  executor: SqlExecutor,
  id: string,
  fields: DurableUpdateInput,
  options?: {
    includeInactive?: boolean;
  },
): Promise<boolean> {
  const assignments: string[] = [];
  const args: Array<number | string | null> = [];
  const lifecycleUpdate = validateDirectClaimKeyLifecycleUpdate(fields);
  const hasValidityUpdates = fields.valid_from !== undefined || fields.valid_to !== undefined;
  const currentValidity = hasValidityUpdates
    ? await loadCurrentValidityBounds(executor, id, {
        includeInactive: options?.includeInactive === true,
      })
    : null;

  if (hasValidityUpdates && currentValidity === null) {
    return false;
  }

  if (currentValidity) {
    const nextValidity = validateTemporalValidityRange(
      fields.valid_from !== undefined ? fields.valid_from : currentValidity.validFrom,
      fields.valid_to !== undefined ? fields.valid_to : currentValidity.validTo,
    );
    if (!nextValidity.ok) {
      throw new Error(nextValidity.message);
    }
  }

  if (fields.importance !== undefined) {
    assignments.push("importance = ?");
    args.push(normalizeInteger(fields.importance, 0));
  }

  if (fields.expiry !== undefined) {
    assignments.push("expiry = ?");
    args.push(fields.expiry);
  }

  if (lifecycleUpdate) {
    assignments.push("claim_key = ?");
    assignments.push("claim_key_raw = ?");
    assignments.push("claim_key_status = ?");
    assignments.push("claim_key_source = ?");
    assignments.push("claim_key_confidence = ?");
    assignments.push("claim_key_rationale = ?");
    assignments.push("claim_support_source_kind = ?");
    assignments.push("claim_support_locator = ?");
    assignments.push("claim_support_observed_at = ?");
    assignments.push("claim_support_mode = ?");
    args.push(
      normalizeOptionalString(lifecycleUpdate.claim_key),
      normalizeOptionalString(lifecycleUpdate.claim_key_raw),
      normalizeOptionalString(lifecycleUpdate.claim_key_status),
      normalizeOptionalString(lifecycleUpdate.claim_key_source),
      normalizeOptionalNumber(lifecycleUpdate.claim_key_confidence),
      normalizeOptionalString(lifecycleUpdate.claim_key_rationale),
      normalizeOptionalString(lifecycleUpdate.claim_support_source_kind),
      normalizeOptionalString(lifecycleUpdate.claim_support_locator),
      normalizeTimestamp(lifecycleUpdate.claim_support_observed_at),
      normalizeOptionalString(lifecycleUpdate.claim_support_mode),
    );
  }

  if (fields.valid_from !== undefined) {
    assignments.push("valid_from = ?");
    args.push(normalizeOptionalString(fields.valid_from));
  }

  if (fields.valid_to !== undefined) {
    assignments.push("valid_to = ?");
    args.push(normalizeOptionalString(fields.valid_to));
  }

  if (assignments.length === 0) {
    return false;
  }

  const now = new Date().toISOString();
  assignments.push("updated_at = ?");
  args.push(now, id);

  const result = await executor.execute({
    sql: `
      UPDATE durables
      SET ${assignments.join(", ")}
      WHERE id = ?
        AND ${options?.includeInactive === true ? "1 = 1" : ACTIVE_DURABLE_CLAUSE}
    `,
    args,
  });

  return result.rowsAffected > 0;
}

/**
 * Loads the currently persisted validity bounds for one mutable entry.
 *
 * @param executor - SQL executor used for the lookup.
 * @param id - Target entry id.
 * @param options - Whether inactive rows are addressable for this mutation.
 * @returns Current bounds, or null when the entry is missing/inactive.
 */
async function loadCurrentValidityBounds(
  executor: SqlExecutor,
  id: string,
  options?: {
    includeInactive?: boolean;
  },
): Promise<{ validFrom?: string; validTo?: string } | null> {
  const result = await executor.execute({
    sql: `
      SELECT valid_from, valid_to
      FROM durables
      WHERE id = ?
        AND ${options?.includeInactive === true ? "1 = 1" : ACTIVE_DURABLE_CLAUSE}
      LIMIT 1
    `,
    args: [id],
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

/**
 * Records a recall event and updates the durable recall counters.
 *
 * @param executor - SQL executor used for the write.
 * @param entryId - Entry that was recalled.
 * @param query - Query text that caused the recall.
 * @param sessionKey - Optional session key for attribution.
 * @returns Promise that resolves after the write completes.
 */
export async function recordRecallEvent(executor: SqlExecutor, entryId: string, query: string, sessionKey?: string): Promise<void> {
  const now = new Date().toISOString();
  const updateResult = await executor.execute({
    sql: `
      UPDATE durables
      SET recall_count = COALESCE(recall_count, 0) + 1,
          last_recalled_at = ?,
          updated_at = ?
      WHERE id = ?
        AND ${ACTIVE_DURABLE_CLAUSE}
    `,
    args: [now, now, entryId],
  });

  if (updateResult.rowsAffected === 0) {
    return;
  }

  await executor.execute({
    sql: `
      INSERT INTO recall_events (
        id,
        durable_id,
        query,
        session_key,
        recalled_at
      )
      VALUES (?, ?, ?, ?, ?)
    `,
    args: [randomUUID(), entryId, query, normalizeOptionalString(sessionKey), now],
  });
}

/**
 * Reads an ingest-log entry for a source file.
 *
 * @param executor - SQL executor used for the lookup.
 * @param filePath - Source file path to resolve.
 * @returns Stored hash and ingest timestamp, or null when absent.
 */
export async function getIngestLogEntry(executor: SqlExecutor, filePath: string): Promise<{ fileHash: string; ingestedAt: string } | null> {
  const result = await executor.execute({
    sql: `
      SELECT file_hash, ingested_at
      FROM ingest_log
      WHERE file_path = ?
      LIMIT 1
    `,
    args: [filePath],
  });

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    fileHash: readRequiredString(row, "file_hash"),
    ingestedAt: readRequiredString(row, "ingested_at"),
  };
}

/**
 * Inserts or replaces an ingest-log entry for a source file.
 *
 * @param executor - SQL executor used for the write.
 * @param filePath - Source file path that was ingested.
 * @param fileHash - Hash of the ingested file contents.
 * @param durableCount - Number of entries produced from the file.
 * @returns Promise that resolves after the write completes.
 */
export async function insertIngestLogEntry(executor: SqlExecutor, filePath: string, fileHash: string, durableCount: number): Promise<void> {
  await executor.execute({
    sql: `
      INSERT INTO ingest_log (
        file_path,
        file_hash,
        ingested_at,
        durable_count
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        file_hash = excluded.file_hash,
        ingested_at = excluded.ingested_at,
        durable_count = excluded.durable_count
    `,
    args: [filePath, fileHash, new Date().toISOString(), normalizeInteger(durableCount, 0)],
  });
}

/** Trims and deduplicates non-empty string values. */
function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

/** Splits an array into fixed-size chunks. */
function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/** Normalizes optional strings into nullable trimmed values. */
function normalizeOptionalString(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Normalizes optional timestamps into nullable trimmed values. */
function normalizeTimestamp(value: string | undefined): string | null {
  return normalizeOptionalString(value);
}

/** Normalizes optional finite numbers into nullable values. */
function normalizeOptionalNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Coerces one aggregate query value into a non-negative integer. */
function coerceRowInteger(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
  }

  return 0;
}

/** Falls back when a numeric value is missing or non-finite. */
function normalizeNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Coerces a numeric value to a finite integer fallback-safe form. */
function normalizeInteger(value: number, fallback: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Number.isFinite(normalized) ? normalized : fallback;
}
