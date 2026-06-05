import type { Client } from "@libsql/client";

import type { SqlExecutor } from "./queries.js";
import { DREAMING_SCHEMA_STATEMENTS } from "./schema/dreaming.js";
import { SESSION_MEMORY_SCHEMA_STATEMENTS } from "./schema/session-memory.js";
import { WORKING_MEMORY_SCHEMA_STATEMENTS } from "./schema/working-memory.js";

/**
 * Logical schema version stored in the metadata table.
 */
const SCHEMA_VERSION = "2";

/**
 * libSQL vector index name for durable embeddings.
 */
const DURABLE_VECTOR_INDEX_NAME = "idx_durables_embedding";

/**
 * libSQL vector index name for episode embeddings.
 */
const EPISODE_VECTOR_INDEX_NAME = "idx_episodes_embedding";

/**
 * libSQL vector index name for procedure embeddings.
 */
const PROCEDURE_VECTOR_INDEX_NAME = "idx_procedures_embedding";

/**
 * Metadata key used to detect interrupted bulk-write phases.
 */
const BULK_WRITE_STATE_META_KEY = "bulk_write_state";

/**
 * Metadata key that records when the last bulk ingest finished.
 */
const LAST_BULK_INGEST_META_KEY = "last_bulk_ingest_at";

/** SQL statement that creates the canonical durables table. */
const CREATE_DURABLES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS durables (
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
    superseded_by TEXT REFERENCES durables(id),
    valid_from TEXT,
    valid_to TEXT,
    directive_polarity TEXT,
    directive_trigger TEXT,
    claim_key TEXT,
    claim_key_raw TEXT,
    claim_key_status TEXT,
    claim_key_source TEXT,
    claim_key_confidence REAL,
    claim_key_rationale TEXT,
    claim_support_source_kind TEXT,
    claim_support_locator TEXT,
    claim_support_observed_at TEXT,
    claim_support_mode TEXT,
    supersession_kind TEXT,
    supersession_reason TEXT,
    cluster_id TEXT,
    user_id TEXT,
    project TEXT,
    retired INTEGER NOT NULL DEFAULT 0,
    retired_at TEXT,
    retired_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

/** SQL statement that creates the FTS shadow table for active durables. */
const CREATE_DURABLES_FTS_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS durables_fts USING fts5(
    content,
    subject,
    content=durables,
    content_rowid=rowid
  )
`;

/** SQL statement that recreates the FTS insert trigger for active durables. */
const CREATE_DURABLES_FTS_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS durables_ai AFTER INSERT ON durables
  WHEN new.retired = 0 AND new.superseded_by IS NULL BEGIN
    INSERT INTO durables_fts(rowid, content, subject)
    VALUES (new.rowid, new.content, new.subject);
  END
`;

/** SQL statement that recreates the FTS delete trigger for active durables. */
const CREATE_DURABLES_FTS_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS durables_ad AFTER DELETE ON durables
  WHEN old.retired = 0 AND old.superseded_by IS NULL BEGIN
    INSERT INTO durables_fts(durables_fts, rowid, content, subject)
    VALUES ('delete', old.rowid, old.content, old.subject);
  END
`;

/** SQL statement that recreates the FTS update trigger for active durables. */
const CREATE_DURABLES_FTS_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS durables_au AFTER UPDATE ON durables BEGIN
    INSERT INTO durables_fts(durables_fts, rowid, content, subject)
    SELECT 'delete', old.rowid, old.content, old.subject
    WHERE old.retired = 0 AND old.superseded_by IS NULL;

    INSERT INTO durables_fts(rowid, content, subject)
    SELECT new.rowid, new.content, new.subject
    WHERE new.retired = 0 AND new.superseded_by IS NULL;
  END
`;

/** SQL statement that records per-file ingest metadata. */
const CREATE_INGEST_LOG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ingest_log (
    file_path TEXT PRIMARY KEY,
    file_hash TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    durable_count INTEGER DEFAULT 0
  )
`;

/** SQL statement that creates the canonical episodes table. */
const CREATE_EPISODES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT,
    source_ref TEXT,
    transcript_hash TEXT,
    summary_hash TEXT,
    agent_id TEXT,
    surface TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    summary TEXT NOT NULL,
    tags TEXT,
    activity_level TEXT,
    user_id TEXT,
    project TEXT,
    gen_model TEXT,
    gen_version TEXT,
    message_count INTEGER,
    embedding F32_BLOB(1024),
    retired INTEGER NOT NULL DEFAULT 0,
    retired_at TEXT,
    retired_reason TEXT,
    superseded_by TEXT REFERENCES episodes(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

/** SQL statement that creates the canonical procedures table. */
const CREATE_PROCEDURES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS procedures (
    id TEXT PRIMARY KEY,
    procedure_key TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    body_json TEXT NOT NULL,
    recall_text TEXT NOT NULL,
    source_file TEXT,
    source_hash TEXT NOT NULL,
    revision_hash TEXT NOT NULL,
    embedding F32_BLOB(1024),
    retired INTEGER NOT NULL DEFAULT 0,
    retired_at TEXT,
    retired_reason TEXT,
    superseded_by TEXT REFERENCES procedures(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

/** SQL statement that creates the FTS shadow table for active procedures. */
const CREATE_PROCEDURES_FTS_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS procedures_fts USING fts5(
    title,
    recall_text,
    content=procedures,
    content_rowid=rowid
  )
`;

/** SQL statement that recreates the FTS insert trigger for active procedures. */
const CREATE_PROCEDURES_FTS_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS procedures_ai AFTER INSERT ON procedures
  WHEN new.retired = 0 AND new.superseded_by IS NULL BEGIN
    INSERT INTO procedures_fts(rowid, title, recall_text)
    VALUES (new.rowid, new.title, new.recall_text);
  END
`;

/** SQL statement that recreates the FTS delete trigger for active procedures. */
const CREATE_PROCEDURES_FTS_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS procedures_ad AFTER DELETE ON procedures
  WHEN old.retired = 0 AND old.superseded_by IS NULL BEGIN
    INSERT INTO procedures_fts(procedures_fts, rowid, title, recall_text)
    VALUES ('delete', old.rowid, old.title, old.recall_text);
  END
`;

/** SQL statement that recreates the FTS update trigger for active procedures. */
const CREATE_PROCEDURES_FTS_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS procedures_au AFTER UPDATE ON procedures BEGIN
    INSERT INTO procedures_fts(procedures_fts, rowid, title, recall_text)
    SELECT 'delete', old.rowid, old.title, old.recall_text
    WHERE old.retired = 0 AND old.superseded_by IS NULL;

    INSERT INTO procedures_fts(rowid, title, recall_text)
    SELECT new.rowid, new.title, new.recall_text
    WHERE new.retired = 0 AND new.superseded_by IS NULL;
  END
`;

/** SQL statement that records each recall event. */
const CREATE_RECALL_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS recall_events (
    id TEXT PRIMARY KEY,
    durable_id TEXT NOT NULL REFERENCES durables(id),
    query TEXT,
    session_key TEXT,
    recalled_at TEXT NOT NULL
  )
`;

/** SQL statement that stores key-value metadata for the database. */
const CREATE_META_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`;

const CREATE_DURABLES_CONTENT_HASH_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_durables_content_hash
  ON durables(content_hash)
`;

const CREATE_DURABLES_NORM_CONTENT_HASH_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_durables_norm_content_hash
  ON durables(norm_content_hash)
`;

const CREATE_DURABLES_TYPE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_durables_type
  ON durables(type)
`;

const CREATE_DURABLES_EXPIRY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_durables_expiry
  ON durables(expiry)
`;

const CREATE_DURABLES_RETIRED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_durables_retired
  ON durables(retired)
`;

const CREATE_DURABLES_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_durables_created_at
  ON durables(created_at)
`;

const CREATE_DURABLES_CLAIM_KEY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_durables_claim_key
  ON durables(claim_key)
  WHERE claim_key IS NOT NULL
`;

const CREATE_DURABLES_VALID_FROM_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_durables_valid_from
  ON durables(valid_from)
  WHERE valid_from IS NOT NULL
`;

const CREATE_DURABLES_VALID_TO_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_durables_valid_to
  ON durables(valid_to)
  WHERE valid_to IS NOT NULL
`;

const CREATE_EPISODES_STARTED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_episodes_started_at
  ON episodes(started_at)
`;

const CREATE_EPISODES_ENDED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_episodes_ended_at
  ON episodes(ended_at)
`;

const CREATE_EPISODES_SOURCE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_episodes_source
  ON episodes(source)
`;

const CREATE_EPISODES_SOURCE_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_episodes_source_id
  ON episodes(source_id)
`;

const CREATE_EPISODES_RETIRED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_episodes_retired
  ON episodes(retired)
`;

const CREATE_EPISODES_SOURCE_SOURCE_ID_UNIQUE_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_source_source_id
  ON episodes(source, source_id)
  WHERE source_id IS NOT NULL
`;

const CREATE_PROCEDURES_PROCEDURE_KEY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_procedures_procedure_key
  ON procedures(procedure_key)
`;

const CREATE_PROCEDURES_REVISION_HASH_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_procedures_revision_hash
  ON procedures(revision_hash)
`;

const CREATE_PROCEDURES_SOURCE_HASH_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_procedures_source_hash
  ON procedures(source_hash)
`;

const CREATE_PROCEDURES_RETIRED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_procedures_retired
  ON procedures(retired)
`;

const CREATE_PROCEDURES_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_procedures_created_at
  ON procedures(created_at)
`;

const CREATE_PROCEDURES_ACTIVE_KEY_UNIQUE_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_procedures_active_procedure_key
  ON procedures(procedure_key)
  WHERE retired = 0
    AND superseded_by IS NULL
`;

const CREATE_RECALL_EVENTS_DURABLE_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_recall_events_durable_id
  ON recall_events(durable_id)
`;

const CREATE_RECALL_EVENTS_RECALLED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_recall_events_recalled_at
  ON recall_events(recalled_at)
`;

/** SQL statement that recreates the libSQL vector index for durable embeddings. */
const CREATE_DURABLES_EMBEDDING_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_durables_embedding ON durables (
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

/** SQL statement that recreates the libSQL vector index for episode embeddings. */
const CREATE_EPISODES_EMBEDDING_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_episodes_embedding ON episodes (
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

/** SQL statement that recreates the libSQL vector index for procedure embeddings. */
const CREATE_PROCEDURES_EMBEDDING_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_procedures_embedding ON procedures (
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
  CREATE_DURABLES_TABLE_SQL,
  CREATE_DURABLES_FTS_TABLE_SQL,
  CREATE_DURABLES_FTS_INSERT_TRIGGER_SQL,
  CREATE_DURABLES_FTS_DELETE_TRIGGER_SQL,
  CREATE_DURABLES_FTS_UPDATE_TRIGGER_SQL,
  CREATE_INGEST_LOG_TABLE_SQL,
  CREATE_EPISODES_TABLE_SQL,
  CREATE_PROCEDURES_TABLE_SQL,
  CREATE_PROCEDURES_FTS_TABLE_SQL,
  CREATE_PROCEDURES_FTS_INSERT_TRIGGER_SQL,
  CREATE_PROCEDURES_FTS_DELETE_TRIGGER_SQL,
  CREATE_PROCEDURES_FTS_UPDATE_TRIGGER_SQL,
  CREATE_RECALL_EVENTS_TABLE_SQL,
  ...DREAMING_SCHEMA_STATEMENTS,
  ...WORKING_MEMORY_SCHEMA_STATEMENTS,
  ...SESSION_MEMORY_SCHEMA_STATEMENTS,
  CREATE_META_TABLE_SQL,
  CREATE_DURABLES_CONTENT_HASH_INDEX_SQL,
  CREATE_DURABLES_NORM_CONTENT_HASH_INDEX_SQL,
  CREATE_DURABLES_TYPE_INDEX_SQL,
  CREATE_DURABLES_EXPIRY_INDEX_SQL,
  CREATE_DURABLES_RETIRED_INDEX_SQL,
  CREATE_DURABLES_CREATED_AT_INDEX_SQL,
  CREATE_DURABLES_CLAIM_KEY_INDEX_SQL,
  CREATE_DURABLES_VALID_FROM_INDEX_SQL,
  CREATE_DURABLES_VALID_TO_INDEX_SQL,
  CREATE_EPISODES_STARTED_AT_INDEX_SQL,
  CREATE_EPISODES_ENDED_AT_INDEX_SQL,
  CREATE_EPISODES_SOURCE_INDEX_SQL,
  CREATE_EPISODES_SOURCE_ID_INDEX_SQL,
  CREATE_EPISODES_RETIRED_INDEX_SQL,
  CREATE_EPISODES_SOURCE_SOURCE_ID_UNIQUE_INDEX_SQL,
  CREATE_PROCEDURES_PROCEDURE_KEY_INDEX_SQL,
  CREATE_PROCEDURES_REVISION_HASH_INDEX_SQL,
  CREATE_PROCEDURES_SOURCE_HASH_INDEX_SQL,
  CREATE_PROCEDURES_RETIRED_INDEX_SQL,
  CREATE_PROCEDURES_CREATED_AT_INDEX_SQL,
  CREATE_PROCEDURES_ACTIVE_KEY_UNIQUE_INDEX_SQL,
  CREATE_RECALL_EVENTS_DURABLE_ID_INDEX_SQL,
  CREATE_RECALL_EVENTS_RECALLED_AT_INDEX_SQL,
] as const;

export {
  BULK_WRITE_STATE_META_KEY,
  CREATE_DURABLES_EMBEDDING_INDEX_SQL,
  CREATE_DURABLES_FTS_DELETE_TRIGGER_SQL,
  CREATE_DURABLES_FTS_INSERT_TRIGGER_SQL,
  CREATE_DURABLES_FTS_UPDATE_TRIGGER_SQL,
  CREATE_EPISODES_EMBEDDING_INDEX_SQL,
  DURABLE_VECTOR_INDEX_NAME,
  EPISODE_VECTOR_INDEX_NAME,
  PROCEDURE_VECTOR_INDEX_NAME,
  SCHEMA_VERSION,
};

/**
 * Creates the agenr database schema for fresh databases.
 *
 * @param db - libSQL client connected to the target database.
 * @returns Promise that resolves once schema initialization is complete.
 * @throws Error When the database uses an unsupported older schema state.
 */
export async function initSchema(db: Client): Promise<void> {
  await db.execute("PRAGMA foreign_keys = ON");
  const currentVersion = await getSchemaVersion(db);
  await assertSupportedSchemaState(db, currentVersion);

  const hadDurablesFts = await tableExists(db, "durables_fts");
  const hadProceduresFts = await tableExists(db, "procedures_fts");

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

  await ensureDreamStateRow(db);

  if (await hasActiveBulkWriteState(db)) {
    await finalizeBulkWrites(db);
    return;
  }

  if (currentVersion !== SCHEMA_VERSION || !hadDurablesFts || !hadProceduresFts) {
    await rebuildFts(db);
  }

  await ensureVectorIndexes(db);
}

/**
 * Rejects persisted databases that are not fresh or already on the current schema.
 *
 * @param db - libSQL client connected to the target database.
 * @param currentVersion - Stored schema version, when present.
 */
async function assertSupportedSchemaState(db: Client, currentVersion: string | null): Promise<void> {
  if (currentVersion && currentVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported agenr database schema version "${currentVersion}". ` +
        `This build only supports schema version ${SCHEMA_VERSION}. ` +
        "Create a fresh database with `agenr db reset` or manually migrate the data into a new database.",
    );
  }

  if (currentVersion !== null) {
    return;
  }

  const existingTables = await listUserTables(db);
  if (existingTables.length === 0) {
    return;
  }

  throw new Error(
    "Unsupported agenr database without schema metadata. " +
      `This build only supports a fresh database or one already initialized at schema version ${SCHEMA_VERSION}. ` +
      "Create a fresh database with `agenr db reset` or manually migrate the data into a new database.",
  );
}

/**
 * Ensures the singleton dream_state row exists.
 *
 * @param db - libSQL client connected to the target database.
 */
async function ensureDreamStateRow(db: Client): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `
      INSERT INTO dream_state (id, unsynthesized_importance_sum, updated_at)
      VALUES ('default', 0, ?)
      ON CONFLICT(id) DO NOTHING
    `,
    args: [now],
  });
}

/**
 * Rebuilds the FTS shadow tables from canonical durable and procedure tables.
 *
 * @param db - libSQL client connected to the target database.
 * @returns Promise that resolves once the rebuild completes.
 */
export async function rebuildFts(db: Client): Promise<void> {
  await db.execute("INSERT INTO durables_fts(durables_fts) VALUES ('rebuild')");
  await db.execute("INSERT INTO procedures_fts(procedures_fts) VALUES ('rebuild')");
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
    await db.execute("DROP TRIGGER IF EXISTS durables_ai");
    await db.execute("DROP TRIGGER IF EXISTS durables_ad");
    await db.execute("DROP TRIGGER IF EXISTS durables_au");
    await db.execute("DROP TRIGGER IF EXISTS procedures_ai");
    await db.execute("DROP TRIGGER IF EXISTS procedures_ad");
    await db.execute("DROP TRIGGER IF EXISTS procedures_au");
    await dropVectorIndexes(db);
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
    await db.execute(CREATE_DURABLES_FTS_INSERT_TRIGGER_SQL);
    await db.execute(CREATE_DURABLES_FTS_DELETE_TRIGGER_SQL);
    await db.execute(CREATE_DURABLES_FTS_UPDATE_TRIGGER_SQL);
    await db.execute(CREATE_PROCEDURES_FTS_INSERT_TRIGGER_SQL);
    await db.execute(CREATE_PROCEDURES_FTS_DELETE_TRIGGER_SQL);
    await db.execute(CREATE_PROCEDURES_FTS_UPDATE_TRIGGER_SQL);
    await rebuildFts(db);
    await ensureVectorIndexes(db);
    await db.execute({
      sql: "DELETE FROM _meta WHERE key = ?",
      args: [BULK_WRITE_STATE_META_KEY],
    });
    await db.execute({
      sql: `
        INSERT INTO _meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      args: [LAST_BULK_INGEST_META_KEY, new Date().toISOString()],
    });
  });
}

/**
 * Reads the last bulk ingest timestamp from metadata, if present.
 *
 * @param db - libSQL client connected to the target database.
 * @returns ISO timestamp string, or null if no bulk ingest has been recorded.
 */
export async function getLastBulkIngestAt(db: Client): Promise<string | null>;
export async function getLastBulkIngestAt(db: SqlExecutor): Promise<string | null>;
export async function getLastBulkIngestAt(db: Client | SqlExecutor): Promise<string | null> {
  try {
    const result = await db.execute({
      sql: "SELECT value FROM _meta WHERE key = ? LIMIT 1",
      args: [LAST_BULK_INGEST_META_KEY],
    });
    const row = result.rows[0];
    return row?.value ? String(row.value) : null;
  } catch {
    return null;
  }
}

/** Reads the stored schema version when the metadata table exists. */
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

/** Checks whether a SQLite table already exists. */
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

/** Lists existing user-defined tables excluding SQLite internals. */
async function listUserTables(db: Client): Promise<string[]> {
  const result = await db.execute({
    sql: `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `,
  });

  return result.rows.flatMap((row) => {
    const name = row.name;
    return typeof name === "string" ? [name] : [];
  });
}

/** Checks whether a prior bulk-write phase was interrupted. */
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

/** Recreates the vector index when the SQLite build supports it. */
async function ensureVectorIndexes(db: Client): Promise<void> {
  try {
    await db.execute(CREATE_DURABLES_EMBEDDING_INDEX_SQL);
    await db.execute(CREATE_EPISODES_EMBEDDING_INDEX_SQL);
    await db.execute(CREATE_PROCEDURES_EMBEDDING_INDEX_SQL);
  } catch (error) {
    if (!isVectorUnavailableError(error)) {
      throw error;
    }
  }
}

/** Drops the vector index when the SQLite build supports it. */
async function dropVectorIndexes(db: Client): Promise<void> {
  try {
    await db.execute(`DROP INDEX IF EXISTS ${DURABLE_VECTOR_INDEX_NAME}`);
    await db.execute(`DROP INDEX IF EXISTS ${EPISODE_VECTOR_INDEX_NAME}`);
    await db.execute(`DROP INDEX IF EXISTS ${PROCEDURE_VECTOR_INDEX_NAME}`);
  } catch (error) {
    if (!isVectorUnavailableError(error)) {
      throw error;
    }
  }
}

/** Runs a callback inside a `BEGIN IMMEDIATE` transaction. */
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

/** Detects vector-extension errors that should be tolerated in SQLite builds without support. */
function isVectorUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /libsql_vector_idx|vector32|vector_top_k|vector|no such function|unsupported/i.test(message);
}
