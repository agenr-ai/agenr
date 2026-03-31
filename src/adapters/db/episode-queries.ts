import { createHash, randomUUID } from "node:crypto";

import type { EpisodeInput, EpisodeUpsertResult, TemporalWindow } from "../../core/episode/types.js";
import type { Episode, EpisodeActivityLevel, EpisodeSource } from "../../core/types.js";
import { buildActiveEpisodeClause, cosineSimilarity, mapEpisodeRow, serializeEmbeddingForVector, serializeTags } from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";

const EPISODE_SELECT_COLUMNS = `
  id,
  source,
  source_id,
  source_ref,
  transcript_hash,
  summary_hash,
  agent_id,
  surface,
  started_at,
  ended_at,
  summary,
  tags,
  activity_level,
  user_id,
  project,
  gen_model,
  gen_version,
  message_count,
  embedding,
  retired,
  retired_at,
  retired_reason,
  superseded_by,
  created_at,
  updated_at
`;

/**
 * Query-ready normalized episode payload used for persistence and change
 * detection.
 */
interface NormalizedEpisodePayload {
  source: EpisodeSource;
  sourceId?: string;
  sourceRef?: string;
  transcriptHash?: string;
  agentId?: string;
  surface?: string;
  startedAt: string;
  endedAt?: string;
  summary: string;
  tags: string[];
  activityLevel?: EpisodeActivityLevel;
  userId?: string;
  project?: string;
  genModel?: string;
  genVersion?: string;
  messageCount?: number;
  embedding?: number[];
}

/**
 * Loads one episode by the stable `(source, source_id)` identity.
 *
 * @param executor - SQL executor used for the lookup.
 * @param source - Episode source namespace.
 * @param sourceId - Stable logical source identifier.
 * @returns Matching episode, or null when none exists.
 */
export async function getEpisodeBySourceId(executor: SqlExecutor, source: EpisodeSource, sourceId: string): Promise<Episode | null> {
  const normalizedSourceId = normalizeOptionalString(sourceId);
  if (!normalizedSourceId) {
    return null;
  }

  const result = await executor.execute({
    sql: `
      SELECT ${EPISODE_SELECT_COLUMNS}
      FROM episodes
      WHERE source = ?
        AND source_id = ?
      LIMIT 1
    `,
    args: [source, normalizedSourceId],
  });

  const row = result.rows[0];
  return row ? mapEpisodeRow(row) : null;
}

/**
 * Loads one episode by the fallback `(source, transcript_hash)` identity.
 *
 * @param executor - SQL executor used for the lookup.
 * @param source - Episode source namespace.
 * @param transcriptHash - Stable transcript-content hash.
 * @returns Matching episode, or null when none exists.
 */
export async function getEpisodeByTranscriptHash(executor: SqlExecutor, source: EpisodeSource, transcriptHash: string): Promise<Episode | null> {
  const normalizedTranscriptHash = normalizeOptionalString(transcriptHash);
  if (!normalizedTranscriptHash) {
    return null;
  }

  const result = await executor.execute({
    sql: `
      SELECT ${EPISODE_SELECT_COLUMNS}
      FROM episodes
      WHERE source = ?
        AND transcript_hash = ?
      LIMIT 1
    `,
    args: [source, normalizedTranscriptHash],
  });

  const row = result.rows[0];
  return row ? mapEpisodeRow(row) : null;
}

/**
 * Inserts or updates an episode row using normalized payload hashing for
 * idempotence.
 *
 * @param executor - SQL executor used for the write.
 * @param input - Episode payload before adapter-managed fields are applied.
 * @returns Persisted episode plus the storage action taken.
 */
export async function upsertEpisode(executor: SqlExecutor, input: EpisodeInput): Promise<EpisodeUpsertResult> {
  const payload = normalizeEpisodePayload(input);
  const summaryHash = createEpisodePayloadHash(payload);
  const existing =
    payload.sourceId !== undefined
      ? await getEpisodeBySourceId(executor, payload.source, payload.sourceId)
      : await getEpisodeByTranscriptHash(executor, payload.source, readRequiredIdentityHash(payload));

  if (!existing) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const vectorJson = serializeEmbeddingForVector(payload.embedding ?? []);
    await executor.execute({
      sql: `
        INSERT INTO episodes (
          id,
          source,
          source_id,
          source_ref,
          transcript_hash,
          summary_hash,
          agent_id,
          surface,
          started_at,
          ended_at,
          summary,
          tags,
          activity_level,
          user_id,
          project,
          gen_model,
          gen_version,
          message_count,
          embedding,
          retired,
          retired_at,
          retired_reason,
          superseded_by,
          created_at,
          updated_at
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          CASE WHEN ? IS NULL THEN NULL ELSE vector32(?) END,
          0, NULL, NULL, NULL, ?, ?
        )
      `,
      args: [
        id,
        payload.source,
        toNullableString(payload.sourceId),
        toNullableString(payload.sourceRef),
        toNullableString(payload.transcriptHash),
        summaryHash,
        toNullableString(payload.agentId),
        toNullableString(payload.surface),
        payload.startedAt,
        toNullableString(payload.endedAt),
        payload.summary,
        serializeTags(payload.tags),
        toNullableString(payload.activityLevel),
        toNullableString(payload.userId),
        toNullableString(payload.project),
        toNullableString(payload.genModel),
        toNullableString(payload.genVersion),
        toNullableInteger(payload.messageCount),
        vectorJson,
        vectorJson,
        now,
        now,
      ],
    });

    return {
      episode: await getEpisodeById(executor, id),
      action: "inserted",
    };
  }

  const existingSummaryHash = existing.summaryHash ?? createEpisodePayloadHash(normalizeEpisodePayload(fromStoredEpisode(existing)));
  if (existingSummaryHash === summaryHash) {
    return {
      episode: existing,
      action: "unchanged",
    };
  }

  const now = new Date().toISOString();
  const vectorJson = serializeEmbeddingForVector(payload.embedding ?? []);
  await executor.execute({
    sql: `
      UPDATE episodes
      SET source_ref = ?,
          transcript_hash = ?,
          summary_hash = ?,
          agent_id = ?,
          surface = ?,
          started_at = ?,
          ended_at = ?,
          summary = ?,
          tags = ?,
          activity_level = ?,
          user_id = ?,
          project = ?,
          gen_model = ?,
          gen_version = ?,
          message_count = ?,
          embedding = CASE WHEN ? IS NULL THEN NULL ELSE vector32(?) END,
          updated_at = ?
      WHERE id = ?
    `,
    args: [
      toNullableString(payload.sourceRef),
      toNullableString(payload.transcriptHash),
      summaryHash,
      toNullableString(payload.agentId),
      toNullableString(payload.surface),
      payload.startedAt,
      toNullableString(payload.endedAt),
      payload.summary,
      serializeTags(payload.tags),
      toNullableString(payload.activityLevel),
      toNullableString(payload.userId),
      toNullableString(payload.project),
      toNullableString(payload.genModel),
      toNullableString(payload.genVersion),
      toNullableInteger(payload.messageCount),
      vectorJson,
      vectorJson,
      now,
      existing.id,
    ],
  });

  return {
    episode: await getEpisodeById(executor, existing.id),
    action: "updated",
  };
}

/**
 * Lists non-retired episodes whose time range overlaps the requested temporal
 * window.
 *
 * @param executor - SQL executor used for the lookup.
 * @param window - Temporal window to evaluate against episode ranges.
 * @param limit - Optional maximum row count.
 * @returns Matching episodes ordered stably by newest start time first.
 */
export async function listEpisodesByTimeWindow(executor: SqlExecutor, window: TemporalWindow, limit?: number): Promise<Episode[]> {
  const bounds = resolveWindowBounds(window);
  if (!bounds) {
    return [];
  }

  const whereClauses = [buildActiveEpisodeClause()];
  const args: Array<number | string> = [];

  if (bounds.start && bounds.end) {
    whereClauses.push("started_at <= ?");
    whereClauses.push("COALESCE(ended_at, started_at) >= ?");
    args.push(bounds.end, bounds.start);
  } else if (bounds.start) {
    whereClauses.push("COALESCE(ended_at, started_at) >= ?");
    args.push(bounds.start);
  } else if (bounds.end) {
    whereClauses.push("started_at <= ?");
    args.push(bounds.end);
  } else {
    return [];
  }

  const normalizedLimit = normalizePositiveInteger(limit);
  const result = await executor.execute({
    sql: `
      SELECT ${EPISODE_SELECT_COLUMNS}
      FROM episodes
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY started_at DESC, id ASC
      ${normalizedLimit ? "LIMIT ?" : ""}
    `,
    args: normalizedLimit ? [...args, normalizedLimit] : args,
  });

  return result.rows.map((row) => mapEpisodeRow(row));
}

/**
 * Finds active episodes by vector similarity to a query embedding.
 *
 * @param executor - SQL executor used for vector search.
 * @param params - Query embedding and maximum result count.
 * @returns Ranked episode candidates with cosine similarity scores.
 */
export async function episodeVectorSearch(
  executor: SqlExecutor,
  params: {
    embedding: number[];
    limit: number;
  },
): Promise<Array<{ episode: Episode; vectorSim: number }>> {
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
        SELECT ${prefixColumns(EPISODE_SELECT_COLUMNS, "e")}
        FROM vector_top_k('idx_episodes_embedding', vector32(?), ?) AS v
        JOIN episodes AS e ON e.rowid = v.id
        WHERE ${buildActiveEpisodeClause("e")}
        LIMIT ?
      `,
      args: [serializedEmbedding, params.limit, params.limit],
    });
  } catch (error) {
    throw wrapEpisodeVectorError(error);
  }

  return result.rows
    .map((row) => {
      const episode = mapEpisodeRow(row);
      return {
        episode,
        vectorSim: cosineSimilarity(params.embedding, episode.embedding ?? []),
      };
    })
    .filter((candidate) => candidate.vectorSim > 0)
    .sort((left, right) => right.vectorSim - left.vectorSim)
    .slice(0, params.limit);
}

/**
 * Lists active episodes that do not yet have an embedding vector.
 *
 * @param executor - SQL executor used for the lookup.
 * @param limit - Optional maximum row count.
 * @returns Episodes still missing embeddings, newest first.
 */
export async function listEpisodesWithoutEmbeddings(executor: SqlExecutor, limit?: number): Promise<Episode[]> {
  const normalizedLimit = normalizePositiveInteger(limit);
  const result = await executor.execute({
    sql: `
      SELECT ${EPISODE_SELECT_COLUMNS}
      FROM episodes
      WHERE ${buildActiveEpisodeClause()}
        AND embedding IS NULL
      ORDER BY started_at DESC, id ASC
      ${normalizedLimit ? "LIMIT ?" : ""}
    `,
    args: normalizedLimit ? [normalizedLimit] : [],
  });

  return result.rows.map((row) => mapEpisodeRow(row));
}

/**
 * Updates only the embedding column for one episode row.
 *
 * @param executor - SQL executor used for the update.
 * @param id - Episode identifier.
 * @param embedding - Embedding vector to persist.
 * @returns Promise that resolves after the update is committed.
 */
export async function updateEpisodeEmbedding(executor: SqlExecutor, id: string, embedding: number[]): Promise<void> {
  const now = new Date().toISOString();
  const vectorJson = serializeEmbeddingForVector(embedding);
  await executor.execute({
    sql: `
      UPDATE episodes
      SET embedding = CASE WHEN ? IS NULL THEN NULL ELSE vector32(?) END,
          updated_at = ?
      WHERE id = ?
    `,
    args: [vectorJson, vectorJson, now, id],
  });
}

/**
 * Builds the deterministic payload hash stored in `summary_hash`.
 *
 * @param payload - Normalized episode payload.
 * @returns SHA-256 hash covering the normalized persisted payload.
 */
function createEpisodePayloadHash(payload: NormalizedEpisodePayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Converts a stored episode back into write-shape data for fallback
 * normalization and hashing.
 *
 * @param episode - Stored episode row.
 * @returns Episode-input-like payload.
 */
function fromStoredEpisode(episode: Episode): EpisodeInput {
  return {
    source: episode.source,
    sourceId: episode.sourceId,
    sourceRef: episode.sourceRef,
    transcriptHash: episode.transcriptHash,
    agentId: episode.agentId,
    surface: episode.surface,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
    summary: episode.summary,
    tags: episode.tags,
    activityLevel: episode.activityLevel,
    userId: episode.userId,
    project: episode.project,
    genModel: episode.genModel,
    genVersion: episode.genVersion,
    messageCount: episode.messageCount,
    embedding: episode.embedding,
  };
}

/**
 * Loads one episode by primary key after a write.
 *
 * @param executor - SQL executor used for the lookup.
 * @param id - Episode primary key.
 * @returns Persisted episode row.
 */
async function getEpisodeById(executor: SqlExecutor, id: string): Promise<Episode> {
  const result = await executor.execute({
    sql: `
      SELECT ${EPISODE_SELECT_COLUMNS}
      FROM episodes
      WHERE id = ?
      LIMIT 1
    `,
    args: [id],
  });

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Episode ${id} was not found after persistence.`);
  }

  return mapEpisodeRow(row);
}

/**
 * Normalizes user-supplied episode input into a stable persisted payload.
 *
 * @param input - Episode write payload.
 * @returns Normalized payload used for persistence and hashing.
 */
function normalizeEpisodePayload(input: EpisodeInput): NormalizedEpisodePayload {
  const sourceId = normalizeOptionalString(input.sourceId);
  const transcriptHash = normalizeOptionalString(input.transcriptHash);
  if (!sourceId && !transcriptHash) {
    throw new Error("Episode writes require either sourceId or transcriptHash.");
  }

  const startedAt = normalizeRequiredString(input.startedAt, "startedAt");
  const endedAt = normalizeOptionalString(input.endedAt);
  const summary = normalizeSummary(input.summary);

  return {
    source: input.source,
    ...(sourceId ? { sourceId } : {}),
    ...(normalizeOptionalString(input.sourceRef) ? { sourceRef: normalizeOptionalString(input.sourceRef) ?? undefined } : {}),
    ...(transcriptHash ? { transcriptHash } : {}),
    ...(normalizeOptionalString(input.agentId) ? { agentId: normalizeOptionalString(input.agentId) ?? undefined } : {}),
    ...(normalizeOptionalString(input.surface) ? { surface: normalizeOptionalString(input.surface) ?? undefined } : {}),
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    summary,
    tags: normalizeTags(input.tags),
    ...(normalizeActivityLevel(input.activityLevel) ? { activityLevel: normalizeActivityLevel(input.activityLevel) } : {}),
    ...(normalizeOptionalString(input.userId) ? { userId: normalizeOptionalString(input.userId) ?? undefined } : {}),
    ...(normalizeOptionalText(input.project) ? { project: normalizeOptionalText(input.project) ?? undefined } : {}),
    ...(normalizeOptionalString(input.genModel) ? { genModel: normalizeOptionalString(input.genModel) ?? undefined } : {}),
    ...(normalizeOptionalString(input.genVersion) ? { genVersion: normalizeOptionalString(input.genVersion) ?? undefined } : {}),
    ...(normalizeOptionalInteger(input.messageCount) !== undefined ? { messageCount: normalizeOptionalInteger(input.messageCount) } : {}),
    ...(normalizeEmbedding(input.embedding) ? { embedding: normalizeEmbedding(input.embedding) } : {}),
  };
}

/**
 * Resolves one temporal window into concrete ISO timestamp bounds.
 *
 * @param window - Temporal window definition.
 * @returns ISO bounds, or null when the window is incomplete.
 */
function resolveWindowBounds(window: TemporalWindow): { start?: string; end?: string } | null {
  switch (window.kind) {
    case "interval": {
      if (!window.start || !window.end) {
        return null;
      }
      return { start: window.start.toISOString(), end: window.end.toISOString() };
    }
    case "anchor": {
      if (!window.anchor || window.radiusDays === undefined || window.radiusDays < 0) {
        return null;
      }
      const radiusMs = Math.trunc(window.radiusDays) * 24 * 60 * 60 * 1000;
      return {
        start: new Date(window.anchor.getTime() - radiusMs).toISOString(),
        end: new Date(window.anchor.getTime() + radiusMs).toISOString(),
      };
    }
    case "open_end":
      return window.start ? { start: window.start.toISOString() } : null;
    case "open_start":
      return window.end ? { end: window.end.toISOString() } : null;
    default:
      return null;
  }
}

/**
 * Reads the fallback transcript identity from a normalized payload.
 *
 * @param payload - Normalized payload.
 * @returns Required transcript hash string.
 */
function readRequiredIdentityHash(payload: NormalizedEpisodePayload): string {
  if (!payload.transcriptHash) {
    throw new Error("Episode writes without sourceId require transcriptHash.");
  }

  return payload.transcriptHash;
}

/**
 * Normalizes activity-level values into the supported enum space.
 *
 * @param value - Candidate activity level.
 * @returns Supported activity level, or undefined when unset.
 */
function normalizeActivityLevel(value: EpisodeActivityLevel | undefined): EpisodeActivityLevel | undefined {
  if (!value) {
    return undefined;
  }

  return value;
}

/**
 * Normalizes optional strings into trimmed values.
 *
 * @param value - Optional text input.
 * @returns Trimmed non-empty string, or undefined when absent.
 */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Normalizes free-form text while collapsing internal whitespace.
 *
 * @param value - Optional free-form text.
 * @returns Normalized text, or undefined when absent.
 */
function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized : undefined;
}

/**
 * Normalizes summary prose for stable persistence and hashing.
 *
 * @param value - Raw summary text.
 * @returns Trimmed summary with collapsed whitespace.
 */
function normalizeSummary(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    throw new Error("Episode summary must not be empty.");
  }

  return normalized;
}

/**
 * Normalizes tags into a stable lowercase deduped order.
 *
 * @param tags - Candidate tag list.
 * @returns Sorted normalized tags capped to eight values.
 */
function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }

  return Array.from(new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0)))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 8);
}

/**
 * Normalizes an optional integer field.
 *
 * @param value - Candidate integer value.
 * @returns Integer when finite, otherwise undefined.
 */
function normalizeOptionalInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.trunc(value);
}

/**
 * Normalizes an embedding array into finite numeric values.
 *
 * @param embedding - Candidate embedding vector.
 * @returns Normalized embedding, or undefined when absent.
 */
function normalizeEmbedding(embedding: number[] | undefined): number[] | undefined {
  if (!embedding || embedding.length === 0) {
    return undefined;
  }

  return embedding.map((value) => (Number.isFinite(value) ? value : 0));
}

/**
 * Ensures required strings are present and trimmed.
 *
 * @param value - Candidate required string.
 * @param fieldName - Field name for error messages.
 * @returns Trimmed string.
 */
function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Episode field "${fieldName}" must not be empty.`);
  }

  return normalized;
}

/**
 * Normalizes an optional positive integer limit.
 *
 * @param value - Candidate limit.
 * @returns Positive integer limit, or undefined when unset.
 */
function normalizePositiveInteger(value: number | undefined): number | undefined {
  const normalized = normalizeOptionalInteger(value);
  if (normalized === undefined || normalized <= 0) {
    return undefined;
  }

  return normalized;
}

/**
 * Prefixes each column in a comma-separated column list with a table alias.
 *
 * @param columns - Multi-line comma-separated column string.
 * @param alias - Table alias to prepend.
 * @returns Column list with each column prefixed.
 */
function prefixColumns(columns: string, alias: string): string {
  return columns
    .split(",")
    .map((col) => {
      const trimmed = col.trim();
      return trimmed ? `${alias}.${trimmed}` : "";
    })
    .filter(Boolean)
    .join(", ");
}

/**
 * Wraps episode vector-search failures in a consistent adapter error.
 *
 * @param error - Original vector-search failure.
 * @returns Adapter-scoped error with a stable prefix.
 */
function wrapEpisodeVectorError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Episode vector search is unavailable: ${message}`);
}

/**
 * Converts an optional string into a nullable SQL-safe binding.
 *
 * @param value - Optional string value.
 * @returns String when present, otherwise null.
 */
function toNullableString(value: string | undefined): string | null {
  return value ?? null;
}

/**
 * Converts an optional integer into a nullable SQL-safe binding.
 *
 * @param value - Optional integer value.
 * @returns Integer when present, otherwise null.
 */
function toNullableInteger(value: number | undefined): number | null {
  return value ?? null;
}
