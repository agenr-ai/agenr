import { randomUUID } from "node:crypto";

import { buildLexicalPlan, type LexicalSearchTier } from "../../core/recall/lexical.js";
import { normalizeProcedureDefinition } from "../../core/procedures/normalization.js";
import type { Procedure, ProcedureDefinition } from "../../core/types.js";
import {
  ACTIVE_PROCEDURE_CLAUSE,
  buildActiveProcedureClause,
  mapProcedureRow,
  PROCEDURE_SELECT_COLUMNS,
  serializeProcedureBody,
} from "./procedure-row-mapping.js";
import type { SqlExecutor } from "./queries.js";
import { cosineSimilarity, readNumber, serializeEmbeddingForVector } from "./row-mapping.js";

const LOOKUP_CHUNK_SIZE = 100;
const FTS_TIERS = ["exact", "all_tokens", "any_tokens"] as const;

/**
 * Inserts or updates one procedure revision row.
 *
 * @param executor - SQL executor used for the write.
 * @param procedure - Canonical procedure payload to persist.
 * @returns Stored procedure row.
 */
export async function upsertProcedure(executor: SqlExecutor, procedure: Procedure): Promise<Procedure> {
  const payload = normalizeStoredProcedure(procedure);
  const id = payload.id.trim().length > 0 ? payload.id.trim() : randomUUID();
  const now = new Date().toISOString();
  const createdAt = normalizeTimestamp(payload.created_at) ?? now;
  const updatedAt = normalizeTimestamp(payload.updated_at) ?? now;
  const vectorJson = serializeEmbeddingForVector(payload.embedding ?? []);

  await executor.execute({
    sql: `
      INSERT INTO procedures (
        id,
        procedure_key,
        title,
        goal,
        body_json,
        recall_text,
        source_file,
        source_hash,
        revision_hash,
        embedding,
        retired,
        retired_at,
        retired_reason,
        superseded_by,
        created_at,
        updated_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        CASE WHEN ? IS NULL THEN NULL ELSE vector32(?) END,
        ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        procedure_key = excluded.procedure_key,
        title = excluded.title,
        goal = excluded.goal,
        body_json = excluded.body_json,
        recall_text = excluded.recall_text,
        source_file = excluded.source_file,
        source_hash = excluded.source_hash,
        revision_hash = excluded.revision_hash,
        embedding = excluded.embedding,
        retired = excluded.retired,
        retired_at = excluded.retired_at,
        retired_reason = excluded.retired_reason,
        superseded_by = excluded.superseded_by,
        updated_at = excluded.updated_at
    `,
    args: [
      id,
      payload.procedure_key,
      payload.title,
      payload.goal,
      serializeProcedureBody(payload.body),
      payload.recall_text,
      toNullableString(payload.source_file),
      payload.source_hash,
      payload.revision_hash,
      vectorJson,
      vectorJson,
      payload.retired ? 1 : 0,
      toNullableString(payload.retired_at),
      toNullableString(payload.retired_reason),
      toNullableString(payload.superseded_by),
      createdAt,
      updatedAt,
    ],
  });

  return getProcedureById(executor, id);
}

/**
 * Fetches a single active procedure revision by ID.
 *
 * @param executor - SQL executor used for the lookup.
 * @param id - Procedure ID to resolve.
 * @returns Active procedure, or null when missing.
 */
export async function getProcedure(executor: SqlExecutor, id: string): Promise<Procedure | null> {
  const [procedure] = await hydrateProcedures(executor, [id]);
  return procedure ?? null;
}

/**
 * Fetches active procedure revisions by ID while preserving the input order.
 *
 * @param executor - SQL executor used for the lookup.
 * @param ids - Procedure IDs to resolve.
 * @returns Active procedures for the requested IDs.
 */
export async function hydrateProcedures(executor: SqlExecutor, ids: string[]): Promise<Procedure[]> {
  const normalizedIds = dedupeStrings(ids);
  if (normalizedIds.length === 0) {
    return [];
  }

  const byId = new Map<string, Procedure>();
  for (const chunk of chunkValues(normalizedIds, LOOKUP_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await executor.execute({
      sql: `
        SELECT
          ${PROCEDURE_SELECT_COLUMNS}
        FROM procedures
        WHERE id IN (${placeholders})
          AND ${ACTIVE_PROCEDURE_CLAUSE}
      `,
      args: chunk,
    });

    for (const row of result.rows) {
      const procedure = mapProcedureRow(row);
      byId.set(procedure.id, procedure);
    }
  }

  return ids.map((id) => byId.get(id.trim())).filter((procedure): procedure is Procedure => procedure !== undefined);
}

/**
 * Fetches one active procedure revision by its stable procedure key.
 *
 * @param executor - SQL executor used for the lookup.
 * @param procedureKey - Stable procedure key.
 * @returns Active procedure revision, or null when missing.
 */
export async function findActiveProcedureByKey(executor: SqlExecutor, procedureKey: string): Promise<Procedure | null> {
  const normalizedKey = normalizeOptionalString(procedureKey);
  if (!normalizedKey) {
    return null;
  }

  const result = await executor.execute({
    sql: `
      SELECT ${PROCEDURE_SELECT_COLUMNS}
      FROM procedures
      WHERE procedure_key = ?
        AND ${ACTIVE_PROCEDURE_CLAUSE}
      LIMIT 1
    `,
    args: [normalizedKey],
  });

  const row = result.rows[0];
  return row ? mapProcedureRow(row) : null;
}

/**
 * Finds active procedures by vector similarity.
 *
 * @param executor - SQL executor used for the lookup.
 * @param params - Vector search parameters.
 * @returns Matching procedures with cosine similarity scores.
 */
export async function procedureVectorSearch(
  executor: SqlExecutor,
  params: {
    embedding: number[];
    limit: number;
  },
): Promise<Array<{ procedure: Procedure; vectorSim: number }>> {
  if (params.limit <= 0 || params.embedding.length === 0) {
    return [];
  }

  const serializedEmbedding = serializeEmbeddingForVector(params.embedding);
  if (!serializedEmbedding) {
    return [];
  }

  let result;
  try {
    result = await executor.execute({
      sql: `
        SELECT ${prefixColumns(PROCEDURE_SELECT_COLUMNS, "p")}
        FROM vector_top_k('idx_procedures_embedding', vector32(?), ?) AS v
        JOIN procedures AS p ON p.rowid = v.id
        WHERE ${buildActiveProcedureClause("p")}
        LIMIT ?
      `,
      args: [serializedEmbedding, params.limit, params.limit],
    });
  } catch (error) {
    throw wrapProcedureVectorError(error);
  }

  return result.rows
    .map((row) => {
      const procedure = mapProcedureRow(row);
      return {
        procedure,
        vectorSim: cosineSimilarity(params.embedding, procedure.embedding ?? []),
      };
    })
    .filter((candidate) => candidate.vectorSim > 0)
    .sort((left, right) => right.vectorSim - left.vectorSim)
    .slice(0, params.limit);
}

/**
 * Finds active procedures by lexical search over the procedure FTS index.
 *
 * @param executor - SQL executor used for the lookup.
 * @param params - FTS search parameters.
 * @returns Matching procedures with adapter-level rank values.
 */
export async function procedureFtsSearch(
  executor: SqlExecutor,
  params: { text: string; limit: number },
): Promise<Array<{ procedure: Procedure; rank: number }>> {
  const query = normalizeOptionalString(params.text);
  if (!query || params.limit <= 0) {
    return [];
  }

  const plan = buildLexicalPlan(query);
  if (plan.length === 0) {
    return [];
  }

  const matches = new Map<
    string,
    {
      procedure: Procedure;
      rank: number;
      tier: LexicalSearchTier["tier"];
    }
  >();

  for (const tier of plan) {
    let result;
    try {
      result = await executor.execute({
        sql: `
          SELECT
            ${prefixColumns(PROCEDURE_SELECT_COLUMNS, "p")},
            bm25(procedures_fts, 1.0, 2.0) AS rank
          FROM procedures_fts
          JOIN procedures AS p ON p.rowid = procedures_fts.rowid
          WHERE procedures_fts MATCH ?
            AND ${buildActiveProcedureClause("p")}
          ORDER BY bm25(procedures_fts, 1.0, 2.0)
          LIMIT ?
        `,
        args: [compileLexicalTier(tier), params.limit],
      });
    } catch {
      continue;
    }

    for (const row of result.rows) {
      const procedure = mapProcedureRow(row);
      if (matches.has(procedure.id)) {
        continue;
      }

      matches.set(procedure.id, {
        procedure,
        rank: readNumber(row, "rank", Number.POSITIVE_INFINITY),
        tier: tier.tier,
      });
    }
  }

  return Array.from(matches.values())
    .sort(compareProcedureFtsMatches)
    .slice(0, params.limit)
    .map(({ procedure, rank }) => ({
      procedure,
      rank,
    }));
}

/**
 * Lists active procedures that do not yet have an embedding vector.
 *
 * @param executor - SQL executor used for the lookup.
 * @param limit - Optional maximum row count.
 * @returns Procedures still missing embeddings, newest first.
 */
export async function listProceduresWithoutEmbeddings(executor: SqlExecutor, limit?: number): Promise<Procedure[]> {
  const normalizedLimit = normalizePositiveInteger(limit);
  const result = await executor.execute({
    sql: `
      SELECT ${PROCEDURE_SELECT_COLUMNS}
      FROM procedures
      WHERE ${ACTIVE_PROCEDURE_CLAUSE}
        AND embedding IS NULL
      ORDER BY created_at DESC, id ASC
      ${normalizedLimit ? "LIMIT ?" : ""}
    `,
    args: normalizedLimit ? [normalizedLimit] : [],
  });

  return result.rows.map((row) => mapProcedureRow(row));
}

/**
 * Updates only the embedding column for one procedure row.
 *
 * @param executor - SQL executor used for the update.
 * @param id - Procedure identifier.
 * @param embedding - Embedding vector to persist.
 * @returns Promise that resolves after the update is committed.
 */
export async function updateProcedureEmbedding(executor: SqlExecutor, id: string, embedding: number[]): Promise<void> {
  const now = new Date().toISOString();
  const vectorJson = serializeEmbeddingForVector(embedding);
  await executor.execute({
    sql: `
      UPDATE procedures
      SET embedding = CASE WHEN ? IS NULL THEN NULL ELSE vector32(?) END,
          updated_at = ?
      WHERE id = ?
    `,
    args: [vectorJson, vectorJson, now, id],
  });
}

/**
 * Marks one active procedure revision as retired.
 *
 * @param executor - SQL executor used for the update.
 * @param id - Procedure identifier.
 * @param reason - Optional retirement reason.
 * @returns True when an active row was updated.
 */
export async function retireProcedure(executor: SqlExecutor, id: string, reason?: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await executor.execute({
    sql: `
      UPDATE procedures
      SET retired = 1,
          retired_at = ?,
          retired_reason = ?,
          updated_at = ?
      WHERE id = ?
        AND ${ACTIVE_PROCEDURE_CLAUSE}
    `,
    args: [now, toNullableString(normalizeOptionalString(reason)), now, id],
  });

  return result.rowsAffected > 0;
}

/**
 * Marks one active procedure revision as superseded by a newer revision.
 *
 * @param executor - SQL executor used for the update.
 * @param oldId - Active procedure revision that should become historical.
 * @param newId - Replacement procedure revision identifier.
 * @param reason - Optional human-readable supersession reason.
 * @returns True when the target procedure was active and updated.
 */
export async function supersedeProcedure(executor: SqlExecutor, oldId: string, newId: string, reason?: string): Promise<boolean> {
  const normalizedOldId = normalizeOptionalString(oldId);
  const normalizedNewId = normalizeOptionalString(newId);
  if (!normalizedOldId || !normalizedNewId || normalizedOldId === normalizedNewId) {
    return false;
  }

  const now = new Date().toISOString();
  const result = await executor.execute({
    sql: `
      UPDATE procedures
      SET superseded_by = ?,
          retired_reason = COALESCE(?, retired_reason),
          updated_at = ?
      WHERE id = ?
        AND ${ACTIVE_PROCEDURE_CLAUSE}
    `,
    args: [normalizedNewId, toNullableString(normalizeOptionalString(reason)), now, normalizedOldId],
  });

  return result.rowsAffected > 0;
}

/**
 * Loads one procedure row by primary key after a write.
 *
 * @param executor - SQL executor used for the lookup.
 * @param id - Procedure primary key.
 * @returns Persisted procedure row.
 */
async function getProcedureById(executor: SqlExecutor, id: string): Promise<Procedure> {
  const result = await executor.execute({
    sql: `
      SELECT ${PROCEDURE_SELECT_COLUMNS}
      FROM procedures
      WHERE id = ?
      LIMIT 1
    `,
    args: [id],
  });

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Procedure ${id} was not found after persistence.`);
  }

  return mapProcedureRow(row);
}

/**
 * Normalizes one stored procedure payload before persistence.
 *
 * @param procedure - Procedure payload provided by the caller.
 * @returns Normalized procedure plus the canonical body payload.
 */
function normalizeStoredProcedure(procedure: Procedure): Procedure & { body: ProcedureDefinition } {
  const body = normalizeProcedureDefinition(
    {
      procedure_key: procedure.procedure_key,
      title: procedure.title,
      goal: procedure.goal,
      when_to_use: procedure.when_to_use,
      when_not_to_use: procedure.when_not_to_use,
      prerequisites: procedure.prerequisites,
      steps: procedure.steps,
      verification: procedure.verification,
      failure_modes: procedure.failure_modes,
      sources: procedure.sources,
    },
    "procedure write payload",
  );

  return {
    ...procedure,
    ...body,
    body,
    recall_text: normalizeRequiredText(procedure.recall_text, "recall_text"),
    revision_hash: normalizeRequiredText(procedure.revision_hash, "revision_hash"),
    source_hash: normalizeRequiredText(procedure.source_hash, "source_hash"),
    source_file: normalizeOptionalString(procedure.source_file),
    retired_at: normalizeOptionalString(procedure.retired_at),
    retired_reason: normalizeOptionalString(procedure.retired_reason),
    superseded_by: normalizeOptionalString(procedure.superseded_by),
    embedding: normalizeEmbedding(procedure.embedding),
  };
}

/**
 * Ensures one required text field is present and trimmed.
 *
 * @param value - Raw string value.
 * @param label - Human-readable field name.
 * @returns Trimmed non-empty string.
 */
function normalizeRequiredText(value: string, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`Procedure ${label} must be a non-empty string.`);
  }

  return normalized;
}

/**
 * Normalizes one optional string into a trimmed value.
 *
 * @param value - Optional text value.
 * @returns Trimmed string, or undefined when absent.
 */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Normalizes one optional timestamp field.
 *
 * @param value - Optional timestamp string.
 * @returns Trimmed timestamp, or undefined when absent.
 */
function normalizeTimestamp(value: string | undefined): string | undefined {
  return normalizeOptionalString(value);
}

/**
 * Normalizes one embedding array into finite numeric values.
 *
 * @param embedding - Candidate embedding vector.
 * @returns Normalized embedding vector, or undefined when absent.
 */
function normalizeEmbedding(embedding: number[] | undefined): number[] | undefined {
  if (!embedding || embedding.length === 0) {
    return undefined;
  }

  return embedding.map((value) => (Number.isFinite(value) ? value : 0));
}

/**
 * Normalizes one optional positive integer limit.
 *
 * @param value - Candidate numeric limit.
 * @returns Positive integer when valid.
 */
function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.trunc(value);
}

/**
 * Splits one array into fixed-size lookup chunks.
 *
 * @param values - Input values to chunk.
 * @param size - Maximum chunk size.
 * @returns Ordered chunks.
 */
function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

/**
 * Trims, removes blanks, and deduplicates string lookup values.
 *
 * @param values - Raw string lookup values.
 * @returns Stable list of non-empty unique strings.
 */
function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

/**
 * Prefixes a comma-delimited column list with one table alias.
 *
 * @param columns - Comma-delimited column list.
 * @param alias - Table alias to prefix.
 * @returns Aliased column list.
 */
function prefixColumns(columns: string, alias: string): string {
  return columns
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column.length > 0)
    .map((column) => `${alias}.${column}`)
    .join(", ");
}

/**
 * Orders FTS candidates by lexical tier priority, then BM25 rank.
 *
 * @param left - Left procedure FTS candidate.
 * @param right - Right procedure FTS candidate.
 * @returns Negative when `left` should sort first.
 */
function compareProcedureFtsMatches(
  left: { procedure: Procedure; rank: number; tier: LexicalSearchTier["tier"] },
  right: { procedure: Procedure; rank: number; tier: LexicalSearchTier["tier"] },
): number {
  const tierDelta = ftsTierPriority(left.tier) - ftsTierPriority(right.tier);
  if (tierDelta !== 0) {
    return tierDelta;
  }

  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }

  return left.procedure.procedure_key.localeCompare(right.procedure.procedure_key);
}

/**
 * Resolves a stable numeric sort priority for one procedure FTS tier.
 *
 * @param tier - Candidate lexical tier.
 * @returns Lower numbers sort first.
 */
function ftsTierPriority(tier: LexicalSearchTier["tier"]): number {
  return FTS_TIERS.indexOf(tier as (typeof FTS_TIERS)[number]);
}

/**
 * Compiles one lexical search tier into a SQLite FTS5 MATCH expression.
 *
 * @param tier - Planned lexical tier.
 * @returns SQLite FTS5 MATCH query text.
 */
function compileLexicalTier(tier: LexicalSearchTier): string {
  if (tier.tier === "exact") {
    return `"${tier.text.replaceAll('"', '""')}"`;
  }

  return tier.tier === "all_tokens" ? tier.tokens.join(" ") : tier.tokens.join(" OR ");
}

/**
 * Wraps one procedure vector-search failure in a stable adapter error.
 *
 * @param error - Original vector-search failure.
 * @returns Adapter-scoped error with a stable prefix.
 */
function wrapProcedureVectorError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Procedure vector search is unavailable: ${message}`);
}

/**
 * Converts one optional string into a nullable SQL-safe binding.
 *
 * @param value - Optional string value.
 * @returns String when present, otherwise null.
 */
function toNullableString(value: string | undefined): string | null {
  return value ?? null;
}
