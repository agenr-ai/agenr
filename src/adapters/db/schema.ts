import type { Client } from "@libsql/client";

/**
 * Logical schema version stored in the metadata table.
 */
export const SCHEMA_VERSION = "1";

/**
 * libSQL vector index name for entry embeddings.
 */
export const VECTOR_INDEX_NAME = "idx_entries_embedding";

/**
 * Metadata key used to detect interrupted bulk-write phases.
 */
export const BULK_WRITE_STATE_META_KEY = "bulk_write_state";

const CREATE_ENTRIES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    importance INTEGER NOT NULL,
    expiry TEXT NOT NULL,
    tags TEXT,
    source_file TEXT,
    source_context TEXT,
    embedding F32_BLOB(1024),
    content_hash TEXT,
    norm_content_hash TEXT,
    minhash_sig BLOB,
    quality_score REAL NOT NULL DEFAULT 0.5,
    recall_count INTEGER DEFAULT 0,
    last_recalled_at TEXT,
    superseded_by TEXT REFERENCES entries(id),
    cluster_id TEXT,
    retired INTEGER NOT NULL DEFAULT 0,
    retired_at TEXT,
    retired_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const CREATE_ENTRIES_FTS_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    content,
    subject,
    content=entries,
    content_rowid=rowid
  )
`;

/**
 * SQL statement that recreates the FTS insert trigger for active entries.
 */
export const CREATE_ENTRIES_FTS_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries
  WHEN new.retired = 0 AND new.superseded_by IS NULL BEGIN
    INSERT INTO entries_fts(rowid, content, subject)
    VALUES (new.rowid, new.content, new.subject);
  END
`;

/**
 * SQL statement that recreates the FTS delete trigger for active entries.
 */
export const CREATE_ENTRIES_FTS_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries
  WHEN old.retired = 0 AND old.superseded_by IS NULL BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, content, subject)
    VALUES ('delete', old.rowid, old.content, old.subject);
  END
`;

/**
 * SQL statement that recreates the FTS update trigger for active entries.
 */
export const CREATE_ENTRIES_FTS_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, content, subject)
    SELECT 'delete', old.rowid, old.content, old.subject
    WHERE old.retired = 0 AND old.superseded_by IS NULL;

    INSERT INTO entries_fts(rowid, content, subject)
    SELECT new.rowid, new.content, new.subject
    WHERE new.retired = 0 AND new.superseded_by IS NULL;
  END
`;

const CREATE_INGEST_LOG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ingest_log (
    file_path TEXT PRIMARY KEY,
    file_hash TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    entry_count INTEGER DEFAULT 0
  )
`;

const CREATE_RECALL_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS recall_events (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES entries(id),
    query TEXT,
    session_key TEXT,
    recalled_at TEXT NOT NULL
  )
`;

const CREATE_SURGEON_RUNS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS surgeon_runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    actions_taken INTEGER DEFAULT 0,
    summary TEXT
  )
`;

const CREATE_META_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`;

const CREATE_ENTRIES_CONTENT_HASH_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entries_content_hash
  ON entries(content_hash)
`;

const CREATE_ENTRIES_NORM_CONTENT_HASH_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entries_norm_content_hash
  ON entries(norm_content_hash)
`;

const CREATE_ENTRIES_TYPE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entries_type
  ON entries(type)
`;

const CREATE_ENTRIES_EXPIRY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entries_expiry
  ON entries(expiry)
`;

const CREATE_ENTRIES_RETIRED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entries_retired
  ON entries(retired)
`;

const CREATE_ENTRIES_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entries_created_at
  ON entries(created_at)
`;

const CREATE_RECALL_EVENTS_ENTRY_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_recall_events_entry_id
  ON recall_events(entry_id)
`;

const CREATE_RECALL_EVENTS_RECALLED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_recall_events_recalled_at
  ON recall_events(recalled_at)
`;

/**
 * SQL statement that recreates the libSQL vector index for entry embeddings.
 */
export const CREATE_ENTRIES_EMBEDDING_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entries_embedding ON entries (
    libsql_vector_idx(
      embedding,
      'metric=cosine',
      'compress_neighbors=float8',
      'max_neighbors=50'
    )
  )
  WHERE embedding IS NOT NULL
    AND retired = 0
    AND superseded_by IS NULL
`;

const SCHEMA_STATEMENTS = [
  CREATE_ENTRIES_TABLE_SQL,
  CREATE_ENTRIES_FTS_TABLE_SQL,
  CREATE_ENTRIES_FTS_INSERT_TRIGGER_SQL,
  CREATE_ENTRIES_FTS_DELETE_TRIGGER_SQL,
  CREATE_ENTRIES_FTS_UPDATE_TRIGGER_SQL,
  CREATE_INGEST_LOG_TABLE_SQL,
  CREATE_RECALL_EVENTS_TABLE_SQL,
  CREATE_SURGEON_RUNS_TABLE_SQL,
  CREATE_META_TABLE_SQL,
  CREATE_ENTRIES_CONTENT_HASH_INDEX_SQL,
  CREATE_ENTRIES_NORM_CONTENT_HASH_INDEX_SQL,
  CREATE_ENTRIES_TYPE_INDEX_SQL,
  CREATE_ENTRIES_EXPIRY_INDEX_SQL,
  CREATE_ENTRIES_RETIRED_INDEX_SQL,
  CREATE_ENTRIES_CREATED_AT_INDEX_SQL,
  CREATE_RECALL_EVENTS_ENTRY_ID_INDEX_SQL,
  CREATE_RECALL_EVENTS_RECALLED_AT_INDEX_SQL,
] as const;

/**
 * Creates the agenr database schema and supporting indexes.
 *
 * @param db - libSQL client connected to the target database.
 * @returns Promise that resolves once schema initialization is complete.
 */
export async function initSchema(db: Client): Promise<void> {
  await db.execute("PRAGMA foreign_keys = ON");
  const currentVersion = await getSchemaVersion(db);
  const hadEntriesFts = await tableExists(db, "entries_fts");

  for (const statement of SCHEMA_STATEMENTS) {
    await db.execute(statement);
  }

  await db.execute({
    sql: `
      INSERT INTO _meta (key, value)
      VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
    args: [SCHEMA_VERSION],
  });

  if (await hasActiveBulkWriteState(db)) {
    await finalizeBulkWrites(db);
    return;
  }

  if (currentVersion !== SCHEMA_VERSION || !hadEntriesFts) {
    await rebuildFts(db);
  }

  await ensureVectorIndex(db);
}

/**
 * Rebuilds the FTS shadow table from the canonical entries table.
 *
 * @param db - libSQL client connected to the target database.
 * @returns Promise that resolves once the rebuild completes.
 */
export async function rebuildFts(db: Client): Promise<void> {
  await db.execute("INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')");
}

/**
 * Drops FTS triggers and the vector index before an ingest bulk-write phase.
 *
 * @param db - libSQL client connected to the target database.
 * @returns Promise that resolves once bulk-write preparation completes.
 */
export async function prepareBulkWrites(db: Client): Promise<void> {
  await runImmediateTransaction(db, async () => {
    await db.execute({
      sql: `
        INSERT INTO _meta (key, value)
        VALUES (?, 'active')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      args: [BULK_WRITE_STATE_META_KEY],
    });
    await db.execute("DROP TRIGGER IF EXISTS entries_ai");
    await db.execute("DROP TRIGGER IF EXISTS entries_ad");
    await db.execute("DROP TRIGGER IF EXISTS entries_au");
    await dropVectorIndex(db);
  });
}

/**
 * Recreates FTS triggers, rebuilds FTS, and recreates the vector index after bulk writes.
 *
 * @param db - libSQL client connected to the target database.
 * @returns Promise that resolves once bulk-write finalization completes.
 */
export async function finalizeBulkWrites(db: Client): Promise<void> {
  await runImmediateTransaction(db, async () => {
    await db.execute(CREATE_ENTRIES_FTS_INSERT_TRIGGER_SQL);
    await db.execute(CREATE_ENTRIES_FTS_DELETE_TRIGGER_SQL);
    await db.execute(CREATE_ENTRIES_FTS_UPDATE_TRIGGER_SQL);
    await rebuildFts(db);
    await ensureVectorIndex(db);
    await db.execute({
      sql: "DELETE FROM _meta WHERE key = ?",
      args: [BULK_WRITE_STATE_META_KEY],
    });
  });
}

async function getSchemaVersion(db: Client): Promise<string | null> {
  try {
    const result = await db.execute("SELECT value FROM _meta WHERE key = 'schema_version' LIMIT 1");
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const value = row.value;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

async function tableExists(db: Client, tableName: string): Promise<boolean> {
  const result = await db.execute({
    sql: `
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
      LIMIT 1
    `,
    args: [tableName],
  });

  return result.rows.length > 0;
}

async function hasActiveBulkWriteState(db: Client): Promise<boolean> {
  try {
    const result = await db.execute({
      sql: "SELECT value FROM _meta WHERE key = ? LIMIT 1",
      args: [BULK_WRITE_STATE_META_KEY],
    });
    const row = result.rows[0];
    return row?.value === "active";
  } catch {
    return false;
  }
}

async function ensureVectorIndex(db: Client): Promise<void> {
  try {
    await db.execute(CREATE_ENTRIES_EMBEDDING_INDEX_SQL);
  } catch (error) {
    if (!isVectorUnavailableError(error)) {
      throw error;
    }
  }
}

async function dropVectorIndex(db: Client): Promise<void> {
  try {
    await db.execute(`DROP INDEX IF EXISTS ${VECTOR_INDEX_NAME}`);
  } catch (error) {
    if (!isVectorUnavailableError(error)) {
      throw error;
    }
  }
}

async function runImmediateTransaction(db: Client, fn: () => Promise<void>): Promise<void> {
  await db.execute("BEGIN IMMEDIATE");
  try {
    await fn();
    await db.execute("COMMIT");
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // Ignore rollback failures.
    }
    throw error;
  }
}

function isVectorUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /libsql_vector_idx|vector32|vector_top_k|vector|no such function|unsupported/i.test(message);
}
