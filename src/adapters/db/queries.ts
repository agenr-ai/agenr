import { randomUUID } from "node:crypto";

import type { InArgs, InStatement, ResultSet, Row } from "@libsql/client";

import type { Entry } from "../../core/types.js";

const ACTIVE_ENTRY_CLAUSE = "retired = 0 AND superseded_by IS NULL";
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
        cluster_id,
        retired,
        retired_at,
        retired_reason,
        created_at,
        updated_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        CASE WHEN ? IS NULL THEN NULL ELSE vector32(?) END,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
      normalizeOptionalString(entry.cluster_id),
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
 * Searches active entries by vector similarity.
 *
 * @param executor - SQL executor used for the search.
 * @param embedding - Query embedding vector.
 * @param limit - Maximum number of matches to return.
 * @returns Entry IDs paired with cosine similarity scores.
 */
export async function vectorSearch(executor: SqlExecutor, embedding: number[], limit: number): Promise<Array<{ id: string; score: number }>> {
  if (limit <= 0 || embedding.length === 0) {
    return [];
  }

  let result: ResultSet;
  try {
    result = await executor.execute({
      sql: `
        SELECT
          e.id,
          e.embedding
        FROM vector_top_k('idx_entries_embedding', vector32(?), ?) AS v
        JOIN entries AS e ON e.rowid = v.id
        WHERE e.embedding IS NOT NULL
          AND ${buildActiveEntryClause("e")}
      `,
      args: [JSON.stringify(embedding), limit],
    });
  } catch (error) {
    throw wrapVectorError(error);
  }

  const scored = result.rows
    .map((row) => {
      const id = readRequiredString(row, "id");
      const rowEmbedding = readEmbedding(row, "embedding");
      return {
        id,
        score: cosineSimilarity(embedding, rowEmbedding),
      };
    })
    .filter((row) => row.score > 0);

  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, limit);
}

/**
 * Searches active entries by full-text content.
 *
 * @param executor - SQL executor used for the search.
 * @param query - Raw user query text.
 * @param limit - Maximum number of matches to return.
 * @returns Entry IDs paired with lexical relevance scores.
 */
export async function textSearch(executor: SqlExecutor, query: string, limit: number): Promise<Array<{ id: string; score: number }>> {
  if (limit <= 0) {
    return [];
  }

  const variants = buildFtsQueries(query);
  if (variants.length === 0) {
    return [];
  }

  const matches = new Map<string, number>();
  for (const variant of variants) {
    let result: ResultSet;
    try {
      result = await executor.execute({
        sql: `
          SELECT
            e.id,
            bm25(entries_fts, 1.0, 2.0) AS rank
          FROM entries_fts
          JOIN entries AS e ON e.rowid = entries_fts.rowid
          WHERE entries_fts MATCH ?
            AND ${buildActiveEntryClause("e")}
          ORDER BY bm25(entries_fts, 1.0, 2.0)
          LIMIT ?
        `,
        args: [variant, limit],
      });
    } catch {
      continue;
    }

    for (const row of result.rows) {
      const id = readRequiredString(row, "id");
      const rank = readNumber(row, "rank", Number.POSITIVE_INFINITY);
      const score = lexicalScore(rank);
      const existing = matches.get(id);
      if (existing === undefined || score > existing) {
        matches.set(id, score);
      }
    }
  }

  return Array.from(matches.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
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
          cluster_id,
          retired,
          retired_at,
          retired_reason,
          created_at,
          updated_at
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
 * Updates mutable fields on an active entry.
 *
 * @param executor - SQL executor used for the update.
 * @param id - Entry ID to update.
 * @param fields - Mutable fields supported by the port contract.
 * @returns True when an active row was updated.
 */
export async function updateEntry(executor: SqlExecutor, id: string, fields: { importance?: number; expiry?: string }): Promise<boolean> {
  const assignments: string[] = [];
  const args: Array<number | string> = [];

  if (fields.importance !== undefined) {
    assignments.push("importance = ?");
    args.push(normalizeInteger(fields.importance, 0));
  }

  if (fields.expiry !== undefined) {
    assignments.push("expiry = ?");
    args.push(fields.expiry);
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
        AND ${ACTIVE_ENTRY_CLAUSE}
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

function buildActiveEntryClause(alias?: string): string {
  if (!alias) {
    return ACTIVE_ENTRY_CLAUSE;
  }
  return `${alias}.retired = 0 AND ${alias}.superseded_by IS NULL`;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTimestamp(value: string | undefined): string | null {
  return normalizeOptionalString(value);
}

function normalizeNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeInteger(value: number, fallback: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Number.isFinite(normalized) ? normalized : fallback;
}

function serializeEmbeddingForVector(embedding: number[]): string | null {
  if (embedding.length === 0) {
    return null;
  }

  return JSON.stringify(embedding.map((value) => (Number.isFinite(value) ? value : 0)));
}

function serializeTags(tags: string[]): string {
  const normalizedTags = tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  return JSON.stringify(normalizedTags);
}

function deserializeTags(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    return [];
  }
}

function readRequiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string column "${key}" in database row.`);
  }
  return value;
}

function readOptionalString(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(row: Row, key: string, fallback = 0): number {
  const value = row[key];
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : fallback;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : fallback;
  }
  return fallback;
}

function readBoolean(row: Row, key: string): boolean {
  return readNumber(row, key, 0) !== 0;
}

function readEmbedding(row: Row, key: string): number[] {
  const value = row[key];
  if (value instanceof ArrayBuffer) {
    return Array.from(new Float32Array(value));
  }

  if (ArrayBuffer.isView(value)) {
    const length = Math.floor(value.byteLength / Float32Array.BYTES_PER_ELEMENT);
    if (length === 0) {
      return [];
    }

    if (value.byteOffset % Float32Array.BYTES_PER_ELEMENT !== 0) {
      const copy = new Uint8Array(value.byteLength);
      copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return Array.from(new Float32Array(copy.buffer, 0, length));
    }

    return Array.from(new Float32Array(value.buffer, value.byteOffset, length));
  }

  return [];
}

function mapEntryRow(row: Row): Entry {
  const type = readRequiredString(row, "type");
  const expiry = readRequiredString(row, "expiry");

  return {
    id: readRequiredString(row, "id"),
    type: type as Entry["type"],
    subject: readRequiredString(row, "subject"),
    content: readRequiredString(row, "content"),
    importance: readNumber(row, "importance", 0),
    expiry: expiry as Entry["expiry"],
    tags: deserializeTags(row.tags),
    source_file: readOptionalString(row, "source_file"),
    source_context: readOptionalString(row, "source_context"),
    embedding: readEmbedding(row, "embedding"),
    content_hash: readOptionalString(row, "content_hash"),
    norm_content_hash: readOptionalString(row, "norm_content_hash"),
    quality_score: readNumber(row, "quality_score", DEFAULT_QUALITY_SCORE),
    recall_count: readNumber(row, "recall_count", 0),
    last_recalled_at: readOptionalString(row, "last_recalled_at"),
    superseded_by: readOptionalString(row, "superseded_by"),
    cluster_id: readOptionalString(row, "cluster_id"),
    retired: readBoolean(row, "retired"),
    retired_at: readOptionalString(row, "retired_at"),
    retired_reason: readOptionalString(row, "retired_reason"),
    created_at: readRequiredString(row, "created_at"),
    updated_at: readRequiredString(row, "updated_at"),
  };
}

function buildFtsQueries(query: string): string[] {
  const normalized = query.trim();
  if (normalized.length === 0) {
    return [];
  }

  const sanitizedTokens = normalized.match(/[A-Za-z0-9_]+/g) ?? [];
  const queries = new Set<string>();
  queries.add(`"${normalized.replaceAll('"', '""')}"`);

  if (sanitizedTokens.length > 0) {
    queries.add(sanitizedTokens.join(" "));
    queries.add(sanitizedTokens.map((token) => `${token}*`).join(" "));
    queries.add(sanitizedTokens.map((token) => `${token}*`).join(" OR "));
  }

  return Array.from(queries);
}

function lexicalScore(rank: number): number {
  if (!Number.isFinite(rank)) {
    return 0;
  }
  return 1 / (1 + Math.max(rank, 0));
}

function cosineSimilarity(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  if (size === 0) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < size; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function wrapVectorError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Vector search is unavailable: ${message}`);
}
