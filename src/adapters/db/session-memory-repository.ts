import { randomUUID } from "node:crypto";

import type { Row } from "@libsql/client";

import type {
  NormalizedSessionArtifactInput,
  RecordTriggerIntakeInput,
  RecordTriggerIntakeResult,
  SessionArtifact,
  SessionArtifactKind,
  SessionLineageEdge,
  SessionMemoryRepository,
  SessionArtifactListFilter,
  SessionArtifactSourceRefListFilter,
  UpsertSessionLineageEdgeInput,
} from "../../app/session-memory/index.js";
import { normalizeBoundedLimit } from "../../app/working-memory/limits.js";
import { parseOptionalJson, serializeOptionalJson } from "./json.js";
import { parseSessionArtifactKind, parseSessionLineageReason } from "./session-memory-parsing.js";
import { readOptionalString, readRequiredString } from "./row-mapping.js";
import type { SqlDatabase } from "./client.js";
import type { SqlExecutor } from "./queries.js";

const SESSION_LINEAGE_EDGE_SELECT_COLUMNS = `
  id,
  child_session_key,
  parent_session_key,
  parent_source_ref,
  reason,
  fork_durable_id,
  fork_position,
  observed_at
`;

const SESSION_ARTIFACT_SELECT_COLUMNS = `
  id,
  kind,
  session_key,
  source,
  source_id,
  source_ref,
  content_hash,
  summary,
  metadata_json,
  created_at,
  expires_at
`;

/**
 * Creates a libSQL-backed repository for schema v12 session memory.
 *
 * @param database - Initialized agenr database.
 * @returns Session-memory repository.
 */
export function createSessionMemoryRepository(database: SqlDatabase): SessionMemoryRepository {
  return {
    upsertLineageEdge: (input) => upsertLineageEdge(database, input),
    upsertSessionArtifact: (input) => upsertSessionArtifact(database, input),
    recordTriggerIntake: (input) => recordTriggerIntake(database, input),
    listSessionArtifacts: (filter) => listSessionArtifacts(database, filter),
    listSessionArtifactsBySourceRef: (filter) => listSessionArtifactsBySourceRef(database, filter),
    getLatestLineageEdgeForChild: (childSessionKey) => getLatestLineageEdgeForChild(database, childSessionKey),
  };
}

/** Inserts one lineage edge unless a matching edge already exists. */
async function upsertLineageEdge(database: SqlDatabase, input: UpsertSessionLineageEdgeInput): Promise<SessionLineageEdge> {
  return database.withTransaction(async (transaction) => upsertLineageEdgeWithExecutor(transaction as SqlDatabase, input));
}

/** Persists one or more trigger facts in one transaction. */
async function recordTriggerIntake(database: SqlDatabase, input: RecordTriggerIntakeInput): Promise<RecordTriggerIntakeResult> {
  return database.withTransaction(async (transaction) => {
    const executor = transaction as SqlDatabase;
    const result: RecordTriggerIntakeResult = {};

    if (input.lineage) {
      result.lineageEdge = await upsertLineageEdgeWithExecutor(executor, input.lineage);
    }

    if (input.artifact) {
      result.artifact = await upsertSessionArtifact(executor, input.artifact);
    }

    return result;
  });
}

/** Inserts one lineage edge unless a matching edge already exists. */
async function upsertLineageEdgeWithExecutor(executor: SqlExecutor, input: UpsertSessionLineageEdgeInput): Promise<SessionLineageEdge> {
  const existing = await findMatchingLineageEdge(executor, input);
  if (existing) {
    return existing;
  }

  const id = randomUUID();
  await executor.execute({
    sql: `
      INSERT INTO session_lineage_edges (
        id,
        child_session_key,
        parent_session_key,
        parent_source_ref,
        reason,
        fork_durable_id,
        fork_position,
        observed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      id,
      input.childSessionKey,
      input.parentSessionKey ?? null,
      input.parentSourceRef ?? null,
      input.reason,
      input.forkEntryId ?? null,
      input.forkPosition ?? null,
      input.observedAt,
    ],
  });

  const edge = await getLineageEdge(executor, id);
  if (!edge) {
    throw new Error(`Session lineage edge ${id} was not found after write.`);
  }

  return edge;
}

/** Inserts or updates one session artifact. */
async function upsertSessionArtifact(executor: SqlExecutor, input: NormalizedSessionArtifactInput): Promise<SessionArtifact> {
  const createdAt = new Date().toISOString();
  await executor.execute({
    sql: `
      INSERT INTO session_artifacts (
        id,
        kind,
        session_key,
        source,
        source_id,
        source_ref,
        content_hash,
        summary,
        metadata_json,
        created_at,
        expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, source, source_id) DO UPDATE SET
        session_key = excluded.session_key,
        source_ref = excluded.source_ref,
        content_hash = excluded.content_hash,
        summary = excluded.summary,
        metadata_json = excluded.metadata_json,
        expires_at = excluded.expires_at
    `,
    args: [
      randomUUID(),
      input.kind,
      input.sessionKey,
      input.source,
      input.sourceId,
      input.sourceRef ?? null,
      input.contentHash,
      input.summary,
      serializeOptionalJson(input.metadata),
      createdAt,
      input.expiresAt ?? null,
    ],
  });

  const artifact = await getSessionArtifactBySource(executor, input.kind, input.source, input.sourceId);
  if (!artifact) {
    throw new Error(`Session artifact ${input.kind}/${input.source}/${input.sourceId} was not found after write.`);
  }

  return artifact;
}

/** Lists session artifacts for one filter. */
async function listSessionArtifacts(executor: SqlExecutor, filter: SessionArtifactListFilter): Promise<SessionArtifact[]> {
  const sessionKey = filter.sessionKey.trim();
  if (!sessionKey) {
    return [];
  }

  return querySessionArtifacts(executor, {
    conditions: ["session_key = ?"],
    args: [sessionKey],
    kinds: filter.kinds,
    limit: filter.limit,
  });
}

/** Lists session artifacts linked to one source reference. */
async function listSessionArtifactsBySourceRef(executor: SqlExecutor, filter: SessionArtifactSourceRefListFilter): Promise<SessionArtifact[]> {
  const sourceRef = filter.sourceRef.trim();
  if (!sourceRef) {
    return [];
  }

  return querySessionArtifacts(executor, {
    conditions: ["source_ref = ?"],
    args: [sourceRef],
    kinds: filter.kinds,
    limit: filter.limit,
  });
}

/** Loads the newest lineage edge for one child session. */
async function getLatestLineageEdgeForChild(executor: SqlExecutor, childSessionKey: string): Promise<SessionLineageEdge | null> {
  const normalizedChild = childSessionKey.trim();
  if (!normalizedChild) {
    return null;
  }

  const result = await executor.execute({
    sql: `
      SELECT ${SESSION_LINEAGE_EDGE_SELECT_COLUMNS}
      FROM session_lineage_edges
      WHERE child_session_key = ?
      ORDER BY observed_at DESC, id ASC
      LIMIT 1
    `,
    args: [normalizedChild],
  });

  const row = result.rows[0];
  return row ? mapSessionLineageEdgeRow(row) : null;
}

/** Finds an existing edge with the same child, parent, and reason. */
async function findMatchingLineageEdge(executor: SqlExecutor, input: UpsertSessionLineageEdgeInput): Promise<SessionLineageEdge | null> {
  const parentSessionKeyClause = input.parentSessionKey ? "parent_session_key = ?" : "parent_session_key IS NULL";
  const parentSourceRefClause = input.parentSourceRef ? "parent_source_ref = ?" : "parent_source_ref IS NULL";
  const args = [
    input.childSessionKey,
    input.reason,
    ...(input.parentSessionKey ? [input.parentSessionKey] : []),
    ...(input.parentSourceRef ? [input.parentSourceRef] : []),
  ];

  const result = await executor.execute({
    sql: `
      SELECT ${SESSION_LINEAGE_EDGE_SELECT_COLUMNS}
      FROM session_lineage_edges
      WHERE child_session_key = ?
        AND reason = ?
        AND ${parentSessionKeyClause}
        AND ${parentSourceRefClause}
      ORDER BY observed_at DESC, id ASC
      LIMIT 1
    `,
    args,
  });
  const row = result.rows[0];
  return row ? mapSessionLineageEdgeRow(row) : null;
}

/** Loads one lineage edge by primary key. */
async function getLineageEdge(executor: SqlExecutor, id: string): Promise<SessionLineageEdge | null> {
  const result = await executor.execute({
    sql: `
      SELECT ${SESSION_LINEAGE_EDGE_SELECT_COLUMNS}
      FROM session_lineage_edges
      WHERE id = ?
      LIMIT 1
    `,
    args: [id],
  });

  const row = result.rows[0];
  return row ? mapSessionLineageEdgeRow(row) : null;
}

/** Loads one artifact by source identity. */
async function getSessionArtifactBySource(executor: SqlExecutor, kind: SessionArtifactKind, source: string, sourceId: string): Promise<SessionArtifact | null> {
  const result = await executor.execute({
    sql: `
      SELECT ${SESSION_ARTIFACT_SELECT_COLUMNS}
      FROM session_artifacts
      WHERE kind = ?
        AND source = ?
        AND source_id = ?
      LIMIT 1
    `,
    args: [kind, source, sourceId],
  });

  const row = result.rows[0];
  return row ? mapSessionArtifactRow(row) : null;
}

/** Appends an optional kind filter to one SQL query. */
function appendKindFilter(conditions: string[], args: Array<string | number>, kinds: SessionArtifactKind[] | undefined): void {
  if (kinds && kinds.length > 0) {
    conditions.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    args.push(...kinds);
  }
}

/** Shared session-artifact list query for keyed lookup dimensions. */
async function querySessionArtifacts(
  executor: SqlExecutor,
  filter: {
    conditions: string[];
    args: Array<string | number>;
    kinds?: SessionArtifactKind[];
    limit?: number;
  },
): Promise<SessionArtifact[]> {
  const conditions = [...filter.conditions];
  const args = [...filter.args];
  appendKindFilter(conditions, args, filter.kinds);

  const limit = normalizeBoundedLimit(filter.limit, 20, 100);
  const result = await executor.execute({
    sql: `
      SELECT ${SESSION_ARTIFACT_SELECT_COLUMNS}
      FROM session_artifacts
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC, id ASC
      LIMIT ?
    `,
    args: [...args, limit],
  });

  return result.rows.map((row) => mapSessionArtifactRow(row));
}

/** Maps a database row into a session-lineage edge. */
function mapSessionLineageEdgeRow(row: Row): SessionLineageEdge {
  return {
    id: readRequiredString(row, "id"),
    childSessionKey: readRequiredString(row, "child_session_key"),
    parentSessionKey: readOptionalString(row, "parent_session_key"),
    parentSourceRef: readOptionalString(row, "parent_source_ref"),
    reason: parseSessionLineageReason(readRequiredString(row, "reason")),
    forkEntryId: readOptionalString(row, "fork_durable_id"),
    forkPosition: readOptionalString(row, "fork_position"),
    observedAt: readRequiredString(row, "observed_at"),
  };
}

/** Maps a database row into a session artifact. */
function mapSessionArtifactRow(row: Row): SessionArtifact {
  return {
    id: readRequiredString(row, "id"),
    kind: parseSessionArtifactKind(readRequiredString(row, "kind")),
    sessionKey: readRequiredString(row, "session_key"),
    source: readRequiredString(row, "source"),
    sourceId: readRequiredString(row, "source_id"),
    sourceRef: readOptionalString(row, "source_ref"),
    contentHash: readRequiredString(row, "content_hash"),
    summary: readRequiredString(row, "summary"),
    metadata: parseOptionalJson(readOptionalString(row, "metadata_json"), "metadata_json"),
    createdAt: readRequiredString(row, "created_at"),
    expiresAt: readOptionalString(row, "expires_at"),
  };
}
