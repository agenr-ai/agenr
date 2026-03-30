import type { Client } from "@libsql/client";

/**
 * Logical schema version stored in the metadata table.
 */
const SCHEMA_VERSION = "4";

/**
 * libSQL vector index name for entry embeddings.
 */
const VECTOR_INDEX_NAME = "idx_entries_embedding";

/**
 * Metadata key used to detect interrupted bulk-write phases.
 */
const BULK_WRITE_STATE_META_KEY = "bulk_write_state";

/** SQL statement that creates the canonical entries table. */
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
    user_id TEXT,
    project TEXT,
    retired INTEGER NOT NULL DEFAULT 0,
    retired_at TEXT,
    retired_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

/** SQL statement that creates the FTS shadow table for active entries. */
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
const CREATE_ENTRIES_FTS_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries
  WHEN new.retired = 0 AND new.superseded_by IS NULL BEGIN
    INSERT INTO entries_fts(rowid, content, subject)
    VALUES (new.rowid, new.content, new.subject);
  END
`;

/**
 * SQL statement that recreates the FTS delete trigger for active entries.
 */
const CREATE_ENTRIES_FTS_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries
  WHEN old.retired = 0 AND old.superseded_by IS NULL BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, content, subject)
    VALUES ('delete', old.rowid, old.content, old.subject);
  END
`;

/**
 * SQL statement that recreates the FTS update trigger for active entries.
 */
const CREATE_ENTRIES_FTS_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, content, subject)
    SELECT 'delete', old.rowid, old.content, old.subject
    WHERE old.retired = 0 AND old.superseded_by IS NULL;

    INSERT INTO entries_fts(rowid, content, subject)
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
    entry_count INTEGER DEFAULT 0
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

/** SQL statement that creates the task-management table separated from semantic entries. */
const CREATE_TASKS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    priority INTEGER NOT NULL DEFAULT 5,
    tags TEXT,
    source_context TEXT,
    project TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    due_at TEXT
  )
`;

/** SQL statement that records each recall event. */
const CREATE_RECALL_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS recall_events (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES entries(id),
    query TEXT,
    session_key TEXT,
    recalled_at TEXT NOT NULL
  )
`;

/** SQL statement that stores surgeon maintenance run metadata. */
const CREATE_SURGEON_RUNS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS surgeon_runs (
    id TEXT PRIMARY KEY,
    pass_type TEXT NOT NULL DEFAULT 'retirement',
    project TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    estimated_cost_usd REAL DEFAULT 0,
    model TEXT,
    actions_taken INTEGER DEFAULT 0,
    actions_skipped INTEGER DEFAULT 0,
    entries_retired INTEGER DEFAULT 0,
    summary TEXT,
    summary_json TEXT,
    error TEXT,
    dry_run INTEGER NOT NULL DEFAULT 1,
    config_json TEXT
  )
`;

/** SQL statement that stores the per-action audit trail for surgeon runs. */
const CREATE_SURGEON_RUN_ACTIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS surgeon_run_actions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES surgeon_runs(id),
    action_type TEXT NOT NULL,
    entry_id TEXT,
    entry_ids TEXT NOT NULL DEFAULT '[]',
    reasoning TEXT NOT NULL DEFAULT '',
    recall_delta TEXT,
    created_at TEXT NOT NULL
  )
`;

const CREATE_SURGEON_RUN_ACTIONS_RUN_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_surgeon_run_actions_run_id
  ON surgeon_run_actions(run_id)
`;

const CREATE_SURGEON_RUN_ACTIONS_ENTRY_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_surgeon_run_actions_entry_id
  ON surgeon_run_actions(entry_id)
`;

const CREATE_SURGEON_RUN_ACTIONS_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_surgeon_run_actions_created_at
  ON surgeon_run_actions(created_at)
`;

/** SQL statement that stores key-value metadata for the database. */
const CREATE_META_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`;

/** SQL statement that indexes exact content hashes. */
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

const CREATE_TASKS_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks(status)
`;

const CREATE_TASKS_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_tasks_created_at
  ON tasks(created_at)
`;

const CREATE_TASKS_PROJECT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_tasks_project
  ON tasks(project)
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
const CREATE_ENTRIES_EMBEDDING_INDEX_SQL = `
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
  CREATE_EPISODES_TABLE_SQL,
  CREATE_TASKS_TABLE_SQL,
  CREATE_RECALL_EVENTS_TABLE_SQL,
  CREATE_SURGEON_RUNS_TABLE_SQL,
  CREATE_META_TABLE_SQL,
  CREATE_ENTRIES_CONTENT_HASH_INDEX_SQL,
  CREATE_ENTRIES_NORM_CONTENT_HASH_INDEX_SQL,
  CREATE_ENTRIES_TYPE_INDEX_SQL,
  CREATE_ENTRIES_EXPIRY_INDEX_SQL,
  CREATE_ENTRIES_RETIRED_INDEX_SQL,
  CREATE_ENTRIES_CREATED_AT_INDEX_SQL,
  CREATE_EPISODES_STARTED_AT_INDEX_SQL,
  CREATE_EPISODES_ENDED_AT_INDEX_SQL,
  CREATE_EPISODES_SOURCE_INDEX_SQL,
  CREATE_EPISODES_SOURCE_ID_INDEX_SQL,
  CREATE_EPISODES_RETIRED_INDEX_SQL,
  CREATE_EPISODES_SOURCE_SOURCE_ID_UNIQUE_INDEX_SQL,
  CREATE_TASKS_STATUS_INDEX_SQL,
  CREATE_TASKS_CREATED_AT_INDEX_SQL,
  CREATE_TASKS_PROJECT_INDEX_SQL,
  CREATE_RECALL_EVENTS_ENTRY_ID_INDEX_SQL,
  CREATE_RECALL_EVENTS_RECALLED_AT_INDEX_SQL,
] as const;

export {
  BULK_WRITE_STATE_META_KEY,
  CREATE_ENTRIES_EMBEDDING_INDEX_SQL,
  CREATE_ENTRIES_FTS_DELETE_TRIGGER_SQL,
  CREATE_ENTRIES_FTS_INSERT_TRIGGER_SQL,
  CREATE_ENTRIES_FTS_UPDATE_TRIGGER_SQL,
  SCHEMA_VERSION,
  VECTOR_INDEX_NAME,
};

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

  await ensureSurgeonSchema(db);

  if (currentVersion === "2") {
    await migrateSchemaV2ToV3(db);
  }

  if (currentVersion === "3") {
    await migrateSchemaV3ToV4(db);
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
 * Ensures surgeon tables have all required columns and indexes.
 * Handles migration from the original minimal surgeon_runs schema.
 *
 * @param db - libSQL client connected to the target database.
 * @returns Promise that resolves once surgeon schema reconciliation completes.
 */
async function ensureSurgeonSchema(db: Client): Promise<void> {
  const columns = await db.execute("PRAGMA table_info('surgeon_runs')");
  const existingColumns = new Set(
    columns.rows
      .map((row) => {
        const name = (row as Record<string, unknown>).name;
        return typeof name === "string" ? name : "";
      })
      .filter((name) => name.length > 0),
  );

  const migrations: Array<{ column: string; sql: string }> = [
    {
      column: "pass_type",
      sql: "ALTER TABLE surgeon_runs ADD COLUMN pass_type TEXT NOT NULL DEFAULT 'retirement'",
    },
    { column: "project", sql: "ALTER TABLE surgeon_runs ADD COLUMN project TEXT" },
    {
      column: "status",
      sql: "ALTER TABLE surgeon_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'",
    },
    { column: "input_tokens", sql: "ALTER TABLE surgeon_runs ADD COLUMN input_tokens INTEGER DEFAULT 0" },
    { column: "output_tokens", sql: "ALTER TABLE surgeon_runs ADD COLUMN output_tokens INTEGER DEFAULT 0" },
    { column: "estimated_cost_usd", sql: "ALTER TABLE surgeon_runs ADD COLUMN estimated_cost_usd REAL DEFAULT 0" },
    { column: "model", sql: "ALTER TABLE surgeon_runs ADD COLUMN model TEXT" },
    { column: "actions_skipped", sql: "ALTER TABLE surgeon_runs ADD COLUMN actions_skipped INTEGER DEFAULT 0" },
    { column: "entries_retired", sql: "ALTER TABLE surgeon_runs ADD COLUMN entries_retired INTEGER DEFAULT 0" },
    { column: "summary_json", sql: "ALTER TABLE surgeon_runs ADD COLUMN summary_json TEXT" },
    { column: "error", sql: "ALTER TABLE surgeon_runs ADD COLUMN error TEXT" },
    { column: "dry_run", sql: "ALTER TABLE surgeon_runs ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 1" },
    { column: "config_json", sql: "ALTER TABLE surgeon_runs ADD COLUMN config_json TEXT" },
  ];

  for (const migration of migrations) {
    if (!existingColumns.has(migration.column)) {
      await db.execute(migration.sql);
    }
  }

  await db.execute(CREATE_SURGEON_RUN_ACTIONS_TABLE_SQL);
  await db.execute(CREATE_SURGEON_RUN_ACTIONS_RUN_ID_INDEX_SQL);
  await db.execute(CREATE_SURGEON_RUN_ACTIONS_ENTRY_ID_INDEX_SQL);
  await db.execute(CREATE_SURGEON_RUN_ACTIONS_CREATED_AT_INDEX_SQL);
}

/**
 * Applies the ordered v2 to v3 schema migration for semantic-memory cleanup.
 *
 * @param db - libSQL client connected to the target database.
 * @returns Promise that resolves once the migration steps complete.
 */
async function migrateSchemaV2ToV3(db: Client): Promise<void> {
  await runImmediateTransaction(db, async () => {
    await db.execute("DROP TRIGGER IF EXISTS entries_ai");
    await db.execute("DROP TRIGGER IF EXISTS entries_ad");
    await db.execute("DROP TRIGGER IF EXISTS entries_au");
    await db.execute("UPDATE entries SET type = 'milestone' WHERE type = 'event'");
    await db.execute(`
      INSERT INTO tasks (id, subject, content, status, priority, tags, source_context, created_at, updated_at)
      SELECT id, subject, content, 'open', importance, tags, source_context, created_at, updated_at
      FROM entries
      WHERE type = 'todo' AND retired = 0
    `);
    await db.execute("DELETE FROM entries WHERE type = 'todo'");
    await db.execute("DELETE FROM entries WHERE type = 'reflection'");

    if (!(await columnExists(db, "entries", "user_id"))) {
      await db.execute("ALTER TABLE entries ADD COLUMN user_id TEXT");
    }

    if (!(await columnExists(db, "entries", "project"))) {
      await db.execute("ALTER TABLE entries ADD COLUMN project TEXT");
    }

    await db.execute(CREATE_ENTRIES_FTS_INSERT_TRIGGER_SQL);
    await db.execute(CREATE_ENTRIES_FTS_DELETE_TRIGGER_SQL);
    await db.execute(CREATE_ENTRIES_FTS_UPDATE_TRIGGER_SQL);
  });
}

/**
 * Applies the ordered v3 to v4 schema migration for episodic-memory foundations.
 *
 * @param db - libSQL client connected to the target database.
 * @returns Promise that resolves once the migration steps complete.
 */
async function migrateSchemaV3ToV4(db: Client): Promise<void> {
  for (const statement of [
    CREATE_EPISODES_TABLE_SQL,
    CREATE_EPISODES_STARTED_AT_INDEX_SQL,
    CREATE_EPISODES_ENDED_AT_INDEX_SQL,
    CREATE_EPISODES_SOURCE_INDEX_SQL,
    CREATE_EPISODES_SOURCE_ID_INDEX_SQL,
    CREATE_EPISODES_RETIRED_INDEX_SQL,
    CREATE_EPISODES_SOURCE_SOURCE_ID_UNIQUE_INDEX_SQL,
  ]) {
    await db.execute(statement);
  }
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

/** Checks whether a SQLite table already contains a named column. */
async function columnExists(db: Client, tableName: string, columnName: string): Promise<boolean> {
  const result = await db.execute(`PRAGMA table_info('${tableName.replaceAll("'", "''")}')`);

  return result.rows.some((row) => {
    const name = (row as Record<string, unknown>).name;
    return name === columnName;
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
async function ensureVectorIndex(db: Client): Promise<void> {
  try {
    await db.execute(CREATE_ENTRIES_EMBEDDING_INDEX_SQL);
  } catch (error) {
    if (!isVectorUnavailableError(error)) {
      throw error;
    }
  }
}

/** Drops the vector index when the SQLite build supports it. */
async function dropVectorIndex(db: Client): Promise<void> {
  try {
    await db.execute(`DROP INDEX IF EXISTS ${VECTOR_INDEX_NAME}`);
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
