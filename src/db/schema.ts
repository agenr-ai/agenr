import type { Client } from "@libsql/client";
import { APP_VERSION } from "../version.js";

export const CREATE_IDX_ENTRIES_EMBEDDING_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entries_embedding ON entries (
    libsql_vector_idx(embedding, 'metric=cosine', 'compress_neighbors=float8', 'max_neighbors=50')
  )
`;

const CREATE_ENTRIES_FTS_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    content, subject, content=entries, content_rowid=rowid
  )
`;

const CREATE_ENTRIES_FTS_TRIGGER_AI_SQL = `
  CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, content, subject) VALUES (new.rowid, new.content, new.subject);
  END
`;

const CREATE_ENTRIES_FTS_TRIGGER_AD_SQL = `
  CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, content, subject) VALUES ('delete', old.rowid, old.content, old.subject);
  END
`;

const CREATE_ENTRIES_FTS_TRIGGER_AU_SQL = `
  CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, content, subject) VALUES ('delete', old.rowid, old.content, old.subject);
    INSERT INTO entries_fts(rowid, content, subject) VALUES (new.rowid, new.content, new.subject);
  END
`;

const REBUILD_ENTRIES_FTS_SQL = "INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')";
const LEGACY_IMPORTANCE_BACKFILL_META_KEY = "legacy_importance_backfill_from_confidence_v1";
export const BULK_INGEST_META_KEY = "bulk_ingest_state";

type ColumnMigration = { table: string; column: string; sql: string; isIndex?: boolean };

const CREATE_TABLE_AND_TRIGGER_STATEMENTS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    subject TEXT NOT NULL,
    canonical_key TEXT,
    content TEXT NOT NULL,
    importance INTEGER NOT NULL,
    expiry TEXT NOT NULL,
    scope TEXT DEFAULT 'private',
    platform TEXT DEFAULT NULL,
    project TEXT DEFAULT NULL,
    source_file TEXT,
    source_context TEXT,
    embedding F32_BLOB(1024),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_recalled_at TEXT,
    recall_count INTEGER DEFAULT 0,
    confirmations INTEGER DEFAULT 0,
    contradictions INTEGER DEFAULT 0,
    superseded_by TEXT,
    content_hash TEXT,
    norm_content_hash TEXT,
    minhash_sig BLOB,
    merged_from INTEGER DEFAULT 0,
    consolidated_at TEXT,
    retired INTEGER NOT NULL DEFAULT 0,
    retired_at TEXT,
    retired_reason TEXT,
    suppressed_contexts TEXT,
    FOREIGN KEY (superseded_by) REFERENCES entries(id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS tags (
    entry_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES entries(id) ON DELETE CASCADE
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS ingest_log (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    entries_added INTEGER NOT NULL,
    entries_updated INTEGER NOT NULL,
    entries_skipped INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    content_hash TEXT,
    entries_superseded INTEGER NOT NULL DEFAULT 0,
    dedup_llm_calls INTEGER NOT NULL DEFAULT 0
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS entry_sources (
    merged_entry_id TEXT NOT NULL REFERENCES entries(id),
    source_entry_id TEXT NOT NULL REFERENCES entries(id),
    original_confirmations INTEGER NOT NULL DEFAULT 0,
    original_recall_count INTEGER NOT NULL DEFAULT 0,
    original_created_at TEXT,
    PRIMARY KEY (merged_entry_id, source_entry_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS signal_watermarks (
    consumer_id TEXT PRIMARY KEY,
    last_received_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )
  `,
  CREATE_ENTRIES_FTS_TABLE_SQL,
  CREATE_ENTRIES_FTS_TRIGGER_AI_SQL,
  CREATE_ENTRIES_FTS_TRIGGER_AD_SQL,
  CREATE_ENTRIES_FTS_TRIGGER_AU_SQL,
];

// Columns added after the initial schema shipped must be added via ALTER TABLE.
// CREATE TABLE IF NOT EXISTS does not backfill columns for existing databases.
const COLUMN_MIGRATIONS: readonly ColumnMigration[] = [
  {
    table: "entries",
    column: "importance",
    sql: "ALTER TABLE entries ADD COLUMN importance INTEGER NOT NULL DEFAULT 5",
  },
  {
    table: "entries",
    column: "canonical_key",
    sql: "ALTER TABLE entries ADD COLUMN canonical_key TEXT",
  },
  {
    table: "entries",
    column: "scope",
    sql: "ALTER TABLE entries ADD COLUMN scope TEXT DEFAULT 'private'",
  },
  {
    table: "entries",
    column: "content_hash",
    sql: "ALTER TABLE entries ADD COLUMN content_hash TEXT",
  },
  {
    table: "entries",
    column: "norm_content_hash",
    sql: "ALTER TABLE entries ADD COLUMN norm_content_hash TEXT",
  },
  {
    table: "entries",
    column: "idx_entries_norm_content_hash",
    sql: "CREATE INDEX IF NOT EXISTS idx_entries_norm_content_hash ON entries(norm_content_hash)",
    isIndex: true,
  },
  {
    table: "entries",
    column: "minhash_sig",
    sql: "ALTER TABLE entries ADD COLUMN minhash_sig BLOB",
  },
  {
    table: "entries",
    column: "merged_from",
    sql: "ALTER TABLE entries ADD COLUMN merged_from INTEGER DEFAULT 0",
  },
  {
    table: "entries",
    column: "consolidated_at",
    sql: "ALTER TABLE entries ADD COLUMN consolidated_at TEXT",
  },
  {
    table: "entries",
    column: "platform",
    sql: "ALTER TABLE entries ADD COLUMN platform TEXT DEFAULT NULL",
  },
  {
    table: "entries",
    column: "project",
    sql: "ALTER TABLE entries ADD COLUMN project TEXT DEFAULT NULL",
  },
  {
    table: "entries",
    column: "retired",
    sql: "ALTER TABLE entries ADD COLUMN retired INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "entries",
    column: "idx_entries_retired",
    sql: "CREATE INDEX IF NOT EXISTS idx_entries_retired ON entries (retired) WHERE retired = 0",
    isIndex: true,
  },
  {
    table: "entries",
    column: "retired_at",
    sql: "ALTER TABLE entries ADD COLUMN retired_at TEXT",
  },
  {
    table: "entries",
    column: "retired_reason",
    sql: "ALTER TABLE entries ADD COLUMN retired_reason TEXT",
  },
  {
    table: "entries",
    column: "suppressed_contexts",
    sql: "ALTER TABLE entries ADD COLUMN suppressed_contexts TEXT",
  },
  {
    table: "ingest_log",
    column: "content_hash",
    sql: "ALTER TABLE ingest_log ADD COLUMN content_hash TEXT",
  },
  {
    table: "ingest_log",
    column: "entries_superseded",
    sql: "ALTER TABLE ingest_log ADD COLUMN entries_superseded INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "ingest_log",
    column: "dedup_llm_calls",
    sql: "ALTER TABLE ingest_log ADD COLUMN dedup_llm_calls INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "entry_sources",
    column: "original_created_at",
    sql: "ALTER TABLE entry_sources ADD COLUMN original_created_at TEXT",
  },
  {
    table: "entries",
    column: "recall_intervals",
    sql: "ALTER TABLE entries ADD COLUMN recall_intervals TEXT DEFAULT NULL",
  },
];

const CREATE_INDEX_STATEMENTS: readonly string[] = [
  CREATE_IDX_ENTRIES_EMBEDDING_SQL,
  "CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type)",
  "CREATE INDEX IF NOT EXISTS idx_entries_type_canonical_key ON entries(type, canonical_key)",
  "CREATE INDEX IF NOT EXISTS idx_entries_expiry ON entries(expiry)",
  "CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope)",
  "CREATE INDEX IF NOT EXISTS idx_entries_platform ON entries(platform)",
  "CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project)",
  "CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_entries_superseded ON entries(superseded_by)",
  "CREATE INDEX IF NOT EXISTS idx_entries_content_hash ON entries(content_hash)",
  "CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)",
  "CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id)",
  "CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_log_file_hash ON ingest_log(file_path, content_hash)",
];

export async function dropFtsTriggersAndIndex(db: Client): Promise<void> {
  await db.execute("BEGIN IMMEDIATE");
  try {
    await db.execute("DROP TRIGGER IF EXISTS entries_ai");
    await db.execute("DROP TRIGGER IF EXISTS entries_ad");
    await db.execute("DROP TRIGGER IF EXISTS entries_au");
    await db.execute("DROP INDEX IF EXISTS idx_entries_embedding");
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

export async function rebuildFtsAndTriggers(db: Client): Promise<void> {
  await db.execute("BEGIN");
  try {
    await db.execute(REBUILD_ENTRIES_FTS_SQL);
    await db.execute(CREATE_ENTRIES_FTS_TRIGGER_AI_SQL);
    await db.execute(CREATE_ENTRIES_FTS_TRIGGER_AD_SQL);
    await db.execute(CREATE_ENTRIES_FTS_TRIGGER_AU_SQL);
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

export async function rebuildVectorIndex(db: Client): Promise<void> {
  try {
    await db.execute("REINDEX idx_entries_embedding");
    return;
  } catch {
    // REINDEX not supported/failing for this connection. Fall back to drop+create.
  }

  await db.execute("BEGIN IMMEDIATE");
  try {
    await db.execute("DROP INDEX IF EXISTS idx_entries_embedding");
    await db.execute(CREATE_IDX_ENTRIES_EMBEDDING_SQL);
    await db.execute("COMMIT");
  } catch (fallbackError) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // Ignore rollback failures.
    }
    throw fallbackError;
  }
}

export async function setBulkIngestMeta(db: Client, phase: string): Promise<void> {
  await db.execute({
    sql: `
      INSERT OR REPLACE INTO _meta (key, value, updated_at)
      VALUES (?, json_object('phase', ?, 'started_at', datetime('now')), datetime('now'))
    `,
    args: [BULK_INGEST_META_KEY, phase],
  });
}

export async function clearBulkIngestMeta(db: Client): Promise<void> {
  await db.execute({ sql: "DELETE FROM _meta WHERE key = ?", args: [BULK_INGEST_META_KEY] });
}

export async function getBulkIngestMeta(db: Client): Promise<{ phase: string; started_at: string } | null> {
  const result = await db.execute({ sql: "SELECT value FROM _meta WHERE key = ?", args: [BULK_INGEST_META_KEY] });
  if (result.rows.length === 0) {
    return null;
  }

  try {
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const raw = row?.value ?? (row ? Object.values(row)[0] : undefined);
    return JSON.parse(String(raw)) as { phase: string; started_at: string };
  } catch {
    return null;
  }
}

export async function initSchema(client: Client): Promise<void> {
  for (const statement of CREATE_TABLE_AND_TRIGGER_STATEMENTS) {
    await client.execute(statement);
  }

  // Detect legacy schema early so the pre-migration FTS rebuild can be skipped when
  // the legacy backfill (which drops and recreates FTS anyway) is about to run.
  let willRunLegacyBackfill = false;
  try {
    const earlyEntriesInfo = await client.execute("PRAGMA table_info(entries)");
    const earlyColumns = new Set(earlyEntriesInfo.rows.map((row) => String((row as { name?: unknown }).name)));
    if (earlyColumns.has("confidence")) {
      const sentinel = await client.execute({
        sql: "SELECT 1 AS found FROM _meta WHERE key = ? LIMIT 1",
        args: [LEGACY_IMPORTANCE_BACKFILL_META_KEY],
      });
      const alreadyBackfilled = sentinel.rows.length > 0;
      willRunLegacyBackfill = !alreadyBackfilled;
    }
  } catch {
    // Best-effort. If PRAGMA fails, fall back to the safe default (run the rebuild when needed).
  }

  // If the FTS table was created after entries already existed (legacy DBs),
  // UPDATE triggers that issue FTS delete operations can error unless the index is rebuilt first.
  try {
    const entriesCountResult = await client.execute("SELECT COUNT(*) AS count FROM entries");
    const entriesCount = Number((entriesCountResult.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
    const ftsCountResult = await client.execute("SELECT COUNT(*) AS count FROM entries_fts");
    const ftsCount = Number((ftsCountResult.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
    if (entriesCount > 0 && ftsCount === 0 && !willRunLegacyBackfill) {
      await client.execute(REBUILD_ENTRIES_FTS_SQL);
    }
  } catch {
    // Best-effort. If FTS is unavailable/corrupted, commands should still be able to run.
  }

  // Apply column migrations before creating any indexes that reference those columns.
  for (const migration of COLUMN_MIGRATIONS) {
    if (migration.isIndex) {
      const existingIndex = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
        args: [migration.column],
      });
      if (existingIndex.rows.length > 0) {
        continue;
      }
      await client.execute(migration.sql);
      continue;
    }
    const info = await client.execute(`PRAGMA table_info(${migration.table})`);
    const hasColumn = info.rows.some((row) => String((row as { name?: unknown }).name) === migration.column);
    if (!hasColumn) {
      await client.execute(migration.sql);
    }
  }

  // Legacy DB compatibility: pre-importance schemas stored confidence as low/medium/high text.
  // If both columns exist, backfill importance from confidence for rows still at the default.
  const entriesInfo = await client.execute("PRAGMA table_info(entries)");
  const entryColumns = new Set(entriesInfo.rows.map((row) => String((row as { name?: unknown }).name)));
  const backfillSentinel = await client.execute({
    sql: "SELECT 1 AS found FROM _meta WHERE key = ? LIMIT 1",
    args: [LEGACY_IMPORTANCE_BACKFILL_META_KEY],
  });
  const legacyBackfillDone = backfillSentinel.rows.length > 0;
  if (entryColumns.has("confidence") && entryColumns.has("importance") && !legacyBackfillDone) {
    // Backfill can fire FTS triggers. On legacy schemas where FTS was created after rows existed,
    // the delete+insert trigger sequence can error. Use a rebuild-safe path.
    try {
      await client.execute("DROP TRIGGER IF EXISTS entries_ai");
      await client.execute("DROP TRIGGER IF EXISTS entries_ad");
      await client.execute("DROP TRIGGER IF EXISTS entries_au");
      await client.execute("DROP TABLE IF EXISTS entries_fts");
    } catch {
      // best-effort
    }

    await client.execute(`
      UPDATE entries
      SET importance = CASE lower(trim(confidence))
        WHEN 'low' THEN 3
        WHEN 'medium' THEN 6
        WHEN 'high' THEN 8
        ELSE
          CASE
            WHEN CAST(confidence AS INTEGER) BETWEEN 1 AND 10 THEN CAST(confidence AS INTEGER)
            ELSE 5
          END
      END
      WHERE importance = 5
    `);

    try {
      await client.execute(CREATE_ENTRIES_FTS_TABLE_SQL);
      await client.execute(CREATE_ENTRIES_FTS_TRIGGER_AI_SQL);
      await client.execute(CREATE_ENTRIES_FTS_TRIGGER_AD_SQL);
      await client.execute(CREATE_ENTRIES_FTS_TRIGGER_AU_SQL);
      await client.execute(REBUILD_ENTRIES_FTS_SQL);
    } catch {
      // best-effort
    }

    // Ensure the expensive drop/recreate path only runs once per database.
    try {
      await client.execute({
        sql: `
          INSERT INTO _meta (key, value, updated_at)
          VALUES (?, datetime('now'), datetime('now'))
          ON CONFLICT(key) DO NOTHING
        `,
        args: [LEGACY_IMPORTANCE_BACKFILL_META_KEY],
      });
    } catch {
      // best-effort
    }
  }

  for (const statement of CREATE_INDEX_STATEMENTS) {
    await client.execute(statement);
  }

  // Version stamp for schema-aware migrations.
  await client.execute({
    sql: `
      INSERT INTO _meta (key, value, updated_at)
      VALUES ('db_created_at', datetime('now'), datetime('now'))
      ON CONFLICT(key) DO NOTHING
    `,
    args: [],
  });

  await client.execute({
    sql: `
      INSERT INTO _meta (key, value, updated_at)
      VALUES ('schema_version', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
    args: [APP_VERSION],
  });
}

export async function resetDb(db: Client): Promise<void> {
  const foreignKeysResult = await db.execute("PRAGMA foreign_keys");
  const foreignKeysRow = foreignKeysResult.rows[0] as Record<string, unknown> | undefined;
  const previousForeignKeys =
    Number(foreignKeysRow?.foreign_keys ?? (foreignKeysRow ? Object.values(foreignKeysRow)[0] : 1)) === 0
      ? 0
      : 1;

  await db.execute("PRAGMA foreign_keys=OFF");
  try {
    const schemaObjects = await db.execute(`
      SELECT type, name
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY
        CASE type
          WHEN 'trigger' THEN 1
          WHEN 'index' THEN 2
          WHEN 'table' THEN 3
          ELSE 4
        END,
        name
    `);

    for (const row of schemaObjects.rows) {
      const type = String((row as { type?: unknown }).type ?? "");
      const name = String((row as { name?: unknown }).name ?? "");
      if (!type || !name) {
        continue;
      }
      const safeName = name.replace(/"/g, "\"\"");

      if (type === "trigger") {
        await db.execute(`DROP TRIGGER IF EXISTS "${safeName}"`);
        continue;
      }
      if (type === "index") {
        await db.execute(`DROP INDEX IF EXISTS "${safeName}"`);
        continue;
      }
      if (type === "table") {
        await db.execute(`DROP TABLE IF EXISTS "${safeName}"`);
      }
    }

    await initSchema(db);
  } finally {
    await db.execute(`PRAGMA foreign_keys=${previousForeignKeys === 0 ? "OFF" : "ON"}`);
  }
}
