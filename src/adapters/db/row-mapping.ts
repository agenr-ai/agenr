import type { Row } from "@libsql/client";

export { cosineSimilarity } from "../../core/recall/scoring.js";
import { parseClaimKeySource, parseClaimKeyStatus, parseClaimSupportMode } from "../../core/claim-key-lifecycle.js";
import type { Durable, Episode } from "../../core/types.js";

const DEFAULT_QUALITY_SCORE = 0.5;
const ACTIVE_DURABLE_CLAUSE = "retired = 0 AND superseded_by IS NULL";
const ACTIVE_EPISODE_CLAUSE = "retired = 0 AND superseded_by IS NULL";
const DURABLE_SELECT_COLUMNS = `
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
`;

export { ACTIVE_DURABLE_CLAUSE, ACTIVE_EPISODE_CLAUSE, DURABLE_SELECT_COLUMNS };

/**
 * Builds the SQL predicate that filters out retired and superseded entries.
 *
 * @param alias - Optional table alias to prefix column references.
 * @returns Active-entry predicate for raw SQL fragments.
 */
export function buildActiveDurableClause(alias?: string): string {
  if (!alias) {
    return ACTIVE_DURABLE_CLAUSE;
  }

  return `${alias}.retired = 0 AND ${alias}.superseded_by IS NULL`;
}

/**
 * Builds the SQL predicate that keeps only durables whose valid-time window
 * contains a given as-of instant.
 *
 * This is the SQL half of the bi-temporal as-of contract used by automatic
 * injection. A row qualifies when its `valid_from` is null or at/ before the
 * instant and its `valid_to` is null or at/after the instant. Bounds are
 * compared through SQLite `datetime()` so the predicate stays correct across
 * the ISO-8601 timestamp variants the store may persist (trailing `Z` versus
 * an explicit UTC offset) rather than relying on lexical string ordering.
 *
 * The caller must bind the same as-of timestamp to both placeholders this
 * fragment emits, in left-to-right order.
 *
 * @param alias - Optional table alias to prefix column references.
 * @returns Valid-time predicate with two ordered bound-parameter placeholders.
 */
export function buildValidAsOfClause(alias?: string): string {
  const validFrom = alias ? `${alias}.valid_from` : "valid_from";
  const validTo = alias ? `${alias}.valid_to` : "valid_to";
  return `(${validFrom} IS NULL OR datetime(${validFrom}) <= datetime(?)) AND (${validTo} IS NULL OR datetime(${validTo}) >= datetime(?))`;
}

/**
 * Builds the SQL predicate that filters out retired and superseded episodes.
 *
 * @param alias - Optional table alias to prefix column references.
 * @returns Active-episode predicate for raw SQL fragments.
 */
export function buildActiveEpisodeClause(alias?: string): string {
  if (!alias) {
    return ACTIVE_EPISODE_CLAUSE;
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
 * Reads an optional numeric column from a query row.
 *
 * @param row - Raw libSQL result row.
 * @param key - Column name to read.
 * @returns Finite numeric value when present, otherwise undefined.
 */
export function readOptionalNumber(row: Row, key: string): number | undefined {
  const value = row[key];
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : undefined;
  }

  return undefined;
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
export function mapDurableRow(row: Row): Durable {
  const type = readRequiredString(row, "type");
  const expiry = readRequiredString(row, "expiry");

  return {
    id: readRequiredString(row, "id"),
    type: type as Durable["type"],
    subject: readRequiredString(row, "subject"),
    content: readRequiredString(row, "content"),
    importance: readNumber(row, "importance", 0),
    expiry: expiry as Durable["expiry"],
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
    valid_from: readOptionalString(row, "valid_from"),
    valid_to: readOptionalString(row, "valid_to"),
    claim_key: readOptionalString(row, "claim_key"),
    claim_key_raw: readOptionalString(row, "claim_key_raw"),
    claim_key_status: readOptionalLifecycleEnum(row, "claim_key_status", parseClaimKeyStatus),
    claim_key_source: readOptionalLifecycleEnum(row, "claim_key_source", parseClaimKeySource),
    claim_key_confidence: readOptionalNumber(row, "claim_key_confidence"),
    claim_key_rationale: readOptionalString(row, "claim_key_rationale"),
    claim_support_source_kind: readOptionalString(row, "claim_support_source_kind"),
    claim_support_locator: readOptionalString(row, "claim_support_locator"),
    claim_support_observed_at: readOptionalString(row, "claim_support_observed_at"),
    claim_support_mode: readOptionalLifecycleEnum(row, "claim_support_mode", parseClaimSupportMode),
    supersession_kind: readOptionalString(row, "supersession_kind"),
    supersession_reason: readOptionalString(row, "supersession_reason"),
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

/**
 * Reads one optional lifecycle enum from a query row and rejects invalid stored values.
 *
 * @param row - Raw libSQL result row.
 * @param key - Column name to read.
 * @param parse - Enum parser used to validate the stored string.
 * @returns Parsed enum value when present.
 */
function readOptionalLifecycleEnum<T extends string>(row: Row, key: string, parse: (value: unknown) => T | undefined): T | undefined {
  const value = readOptionalString(row, key);
  if (value === undefined) {
    return undefined;
  }

  const parsed = parse(value);
  if (!parsed) {
    throw new Error(`Invalid lifecycle value ${JSON.stringify(value)} for database column "${key}".`);
  }

  return parsed;
}

/**
 * Maps a raw database row into the core episode shape.
 *
 * @param row - Raw libSQL result row.
 * @returns Hydrated core episode.
 */
export function mapEpisodeRow(row: Row): Episode {
  const source = readRequiredString(row, "source");
  const activityLevel = readOptionalString(row, "activity_level");

  return {
    id: readRequiredString(row, "id"),
    source: source as Episode["source"],
    sourceId: readOptionalString(row, "source_id"),
    sourceRef: readOptionalString(row, "source_ref"),
    transcriptHash: readOptionalString(row, "transcript_hash"),
    summaryHash: readOptionalString(row, "summary_hash"),
    agentId: readOptionalString(row, "agent_id"),
    surface: readOptionalString(row, "surface"),
    startedAt: readRequiredString(row, "started_at"),
    endedAt: readOptionalString(row, "ended_at"),
    summary: readRequiredString(row, "summary"),
    tags: deserializeTags(row.tags),
    activityLevel: activityLevel as Episode["activityLevel"],
    userId: readOptionalString(row, "user_id"),
    project: readOptionalString(row, "project"),
    genModel: readOptionalString(row, "gen_model"),
    genVersion: readOptionalString(row, "gen_version"),
    messageCount: readOptionalNumber(row, "message_count"),
    embedding: readEmbedding(row, "embedding"),
    retired: readBoolean(row, "retired"),
    retiredAt: readOptionalString(row, "retired_at"),
    retiredReason: readOptionalString(row, "retired_reason"),
    supersededBy: readOptionalString(row, "superseded_by"),
    createdAt: readRequiredString(row, "created_at"),
    updatedAt: readRequiredString(row, "updated_at"),
  };
}
