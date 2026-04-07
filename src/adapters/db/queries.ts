import { randomUUID } from "node:crypto";

import type { InArgs, InStatement, ResultSet } from "@libsql/client";

import type { Entry, EntryUpdateInput } from "../../core/types.js";
import { ACTIVE_ENTRY_CLAUSE, ENTRY_SELECT_COLUMNS, mapEntryRow, readRequiredString, serializeEmbeddingForVector, serializeTags } from "./row-mapping.js";

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
export async function insertEntry(executor: SqlExecutor, entry: Entry, embedding: number[], contentHash: string): Promise<string> {
  const now = new Date().toISOString();
  const id = entry.id.trim().length > 0 ? entry.id.trim() : randomUUID();
  const createdAt = normalizeTimestamp(entry.created_at) ?? now;
  const updatedAt = normalizeTimestamp(entry.updated_at) ?? now;
  const vectorJson = serializeEmbeddingForVector(embedding);
  await executor.execute({
    sql: `
      INSERT INTO entries (
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
        minhash_sig,
        quality_score,
        recall_count,
        last_recalled_at,
        superseded_by,
        valid_from,
        valid_to,
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
        cluster_id,
        user_id,
        project,
        retired,
        retired_at,
        retired_reason,
        created_at,
        updated_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        CASE WHEN ? IS NULL THEN NULL ELSE vector32(?) END,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
      null,
      normalizeNumber(entry.quality_score, DEFAULT_QUALITY_SCORE),
      normalizeInteger(entry.recall_count, 0),
      normalizeOptionalString(entry.last_recalled_at),
      normalizeOptionalString(entry.superseded_by),
      normalizeOptionalString(entry.valid_from),
      normalizeOptionalString(entry.valid_to),
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
      normalizeOptionalString(entry.cluster_id),
      normalizeOptionalString(entry.user_id),
      normalizeOptionalString(entry.project),
      entry.retired ? 1 : 0,
      normalizeOptionalString(entry.retired_at),
      normalizeOptionalString(entry.retired_reason),
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
export async function getEntries(executor: SqlExecutor, ids: string[]): Promise<Entry[]> {
  const normalizedIds = dedupeStrings(ids);
  if (normalizedIds.length === 0) {
    return [];
  }

  const byId = new Map<string, Entry>();
  for (const chunk of chunkValues(normalizedIds, LOOKUP_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await executor.execute({
      sql: `
        SELECT
          ${ENTRY_SELECT_COLUMNS}
        FROM entries
        WHERE id IN (${placeholders})
          AND ${ACTIVE_ENTRY_CLAUSE}
      `,
      args: chunk,
    });

    for (const row of result.rows) {
      const entry = mapEntryRow(row);
      byId.set(entry.id, entry);
    }
  }

  return ids.map((id) => byId.get(id.trim())).filter((entry): entry is Entry => entry !== undefined);
}

/**
 * Fetches a single active entry by ID.
 *
 * @param executor - SQL executor used for the lookup.
 * @param id - Entry ID to resolve.
 * @returns Active entry, or null when missing.
 */
export async function getEntry(executor: SqlExecutor, id: string): Promise<Entry | null> {
  const [entry] = await getEntries(executor, [id]);
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
        FROM entries
        WHERE content_hash IN (${placeholders})
          AND ${ACTIVE_ENTRY_CLAUSE}
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
        FROM entries
        WHERE norm_content_hash IN (${placeholders})
          AND ${ACTIVE_ENTRY_CLAUSE}
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
 * Marks an active entry as retired.
 *
 * @param executor - SQL executor used for the update.
 * @param id - Entry ID to retire.
 * @param reason - Optional retirement reason.
 * @returns True when an active row was updated.
 */
export async function retireEntry(executor: SqlExecutor, id: string, reason?: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await executor.execute({
    sql: `
      UPDATE entries
      SET retired = 1,
          retired_at = ?,
          retired_reason = ?,
          updated_at = ?
      WHERE id = ?
        AND ${ACTIVE_ENTRY_CLAUSE}
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
export async function supersedeEntry(executor: SqlExecutor, oldId: string, newId: string, kind?: string, reason?: string): Promise<boolean> {
  const normalizedOldId = oldId.trim();
  const normalizedNewId = newId.trim();
  if (normalizedOldId.length === 0 || normalizedNewId.length === 0 || normalizedOldId === normalizedNewId) {
    return false;
  }

  const existing = await executor.execute({
    sql: `
      SELECT id
      FROM entries
      WHERE id = ?
        AND ${ACTIVE_ENTRY_CLAUSE}
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
      UPDATE entries
      SET superseded_by = ?,
          supersession_kind = ?,
          supersession_reason = ?,
          updated_at = ?
      WHERE id = ?
        AND ${ACTIVE_ENTRY_CLAUSE}
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
export async function findActiveEntriesByClaimKey(executor: SqlExecutor, claimKey: string): Promise<Entry[]> {
  const normalizedClaimKey = claimKey.trim();
  if (normalizedClaimKey.length === 0) {
    return [];
  }

  const result = await executor.execute({
    sql: `
      SELECT *
      FROM entries
      WHERE claim_key = ?
        AND ${ACTIVE_ENTRY_CLAUSE}
    `,
    args: [normalizedClaimKey],
  });

  return result.rows.map((row) => mapEntryRow(row));
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
      FROM entries
      WHERE claim_key IS NOT NULL
        AND instr(claim_key, '/') > 1
        AND ${ACTIVE_ENTRY_CLAUSE}
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
      FROM entries
      WHERE claim_key IS NOT NULL
        AND ${ACTIVE_ENTRY_CLAUSE}
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
 * Updates mutable fields on an active entry.
 *
 * @param executor - SQL executor used for the update.
 * @param id - Entry ID to update.
 * @param fields - Mutable fields supported by the port contract.
 * @returns True when an active row was updated.
 */
export async function updateEntry(
  executor: SqlExecutor,
  id: string,
  fields: EntryUpdateInput,
  options?: {
    includeInactive?: boolean;
  },
): Promise<boolean> {
  const assignments: string[] = [];
  const args: Array<number | string | null> = [];

  if (fields.importance !== undefined) {
    assignments.push("importance = ?");
    args.push(normalizeInteger(fields.importance, 0));
  }

  if (fields.expiry !== undefined) {
    assignments.push("expiry = ?");
    args.push(fields.expiry);
  }

  if (fields.claim_key !== undefined) {
    assignments.push("claim_key = ?");
    args.push(normalizeOptionalString(fields.claim_key));
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
      UPDATE entries
      SET ${assignments.join(", ")}
      WHERE id = ?
        AND ${options?.includeInactive === true ? "1 = 1" : ACTIVE_ENTRY_CLAUSE}
    `,
    args,
  });

  return result.rowsAffected > 0;
}

/**
 * Records a recall event and updates the entry recall counters.
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
      UPDATE entries
      SET recall_count = COALESCE(recall_count, 0) + 1,
          last_recalled_at = ?,
          updated_at = ?
      WHERE id = ?
        AND ${ACTIVE_ENTRY_CLAUSE}
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
        entry_id,
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
 * @param entryCount - Number of entries produced from the file.
 * @returns Promise that resolves after the write completes.
 */
export async function insertIngestLogEntry(executor: SqlExecutor, filePath: string, fileHash: string, entryCount: number): Promise<void> {
  await executor.execute({
    sql: `
      INSERT INTO ingest_log (
        file_path,
        file_hash,
        ingested_at,
        entry_count
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        file_hash = excluded.file_hash,
        ingested_at = excluded.ingested_at,
        entry_count = excluded.entry_count
    `,
    args: [filePath, fileHash, new Date().toISOString(), normalizeInteger(entryCount, 0)],
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

/** Falls back when a numeric value is missing or non-finite. */
function normalizeNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Coerces a numeric value to a finite integer fallback-safe form. */
function normalizeInteger(value: number, fallback: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Number.isFinite(normalized) ? normalized : fallback;
}
