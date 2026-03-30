import type { Row } from "@libsql/client";

export { cosineSimilarity } from "../../core/recall/scoring.js";
import type { Entry } from "../../core/types.js";

const DEFAULT_QUALITY_SCORE = 0.5;
const ACTIVE_ENTRY_CLAUSE = "retired = 0 AND superseded_by IS NULL";

export { ACTIVE_ENTRY_CLAUSE };

/**
 * Builds the SQL predicate that filters out retired and superseded entries.
 *
 * @param alias - Optional table alias to prefix column references.
 * @returns Active-entry predicate for raw SQL fragments.
 */
export function buildActiveEntryClause(alias?: string): string {
  if (!alias) {
    return ACTIVE_ENTRY_CLAUSE;
  }

  return `${alias}.retired = 0 AND ${alias}.superseded_by IS NULL`;
}

/**
 * Serializes an embedding for storage and vector index queries.
 *
 * @param embedding - Numeric embedding vector.
 * @returns JSON array string, or null when the vector is empty.
 */
export function serializeEmbeddingForVector(embedding: number[]): string | null {
  if (embedding.length === 0) {
    return null;
  }

  return JSON.stringify(embedding.map((value) => (Number.isFinite(value) ? value : 0)));
}

/**
 * Serializes entry tags for database persistence.
 *
 * @param tags - Raw entry tags.
 * @returns Stable JSON string for storage.
 */
export function serializeTags(tags: string[]): string {
  const normalizedTags = tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  return JSON.stringify(normalizedTags);
}

/**
 * Deserializes a stored tag payload from a database row.
 *
 * Supports both the current JSON-array format and the older pipe-delimited
 * representation so read paths remain tolerant during adapter refactors.
 *
 * @param value - Raw database value.
 * @returns Parsed tag list.
 */
export function deserializeTags(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  const normalized = value.trim();
  if (normalized.startsWith("|") && normalized.endsWith("|")) {
    return normalized
      .slice(1, -1)
      .split("|")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    return [];
  }
}

/**
 * Reads a required string column from a query row.
 *
 * @param row - Raw libSQL result row.
 * @param key - Column name to read.
 * @returns Trimmed string value from the row.
 */
export function readRequiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string column "${key}" in database row.`);
  }

  return value;
}

/**
 * Reads an optional string column from a query row.
 *
 * @param row - Raw libSQL result row.
 * @param key - Column name to read.
 * @returns String value when present, otherwise undefined.
 */
export function readOptionalString(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Reads a numeric column from a query row with fallback coercion.
 *
 * @param row - Raw libSQL result row.
 * @param key - Column name to read.
 * @param fallback - Fallback used when the value is missing or invalid.
 * @returns Finite numeric value.
 */
export function readNumber(row: Row, key: string, fallback = 0): number {
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

/**
 * Reads a boolean-like column from a query row.
 *
 * @param row - Raw libSQL result row.
 * @param key - Column name to read.
 * @returns Boolean representation of the stored value.
 */
export function readBoolean(row: Row, key: string): boolean {
  return readNumber(row, key, 0) !== 0;
}

/**
 * Reads an embedding blob column into a JavaScript number array.
 *
 * @param row - Raw libSQL result row.
 * @param key - Column name to read.
 * @returns Decoded embedding vector.
 */
export function readEmbedding(row: Row, key: string): number[] {
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

/**
 * Maps a raw database row into the core entry shape.
 *
 * @param row - Raw libSQL result row.
 * @returns Hydrated core entry.
 */
export function mapEntryRow(row: Row): Entry {
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
    user_id: readOptionalString(row, "user_id"),
    project: readOptionalString(row, "project"),
    retired: readBoolean(row, "retired"),
    retired_at: readOptionalString(row, "retired_at"),
    retired_reason: readOptionalString(row, "retired_reason"),
    created_at: readRequiredString(row, "created_at"),
    updated_at: readRequiredString(row, "updated_at"),
  };
}
