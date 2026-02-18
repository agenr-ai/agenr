import type { Client } from "@libsql/client";
import { APP_VERSION } from "../version.js";

export const CREATE_IDX_ENTRIES_EMBEDDING_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entries_embedding ON entries (
    libsql_vector_idx(embedding, 'metric=cosine', 'compress_neighbors=float8', 'max_neighbors=50')
  )
`;

type ColumnMigration = { table: string; column: string; sql: string };

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
    merged_from INTEGER DEFAULT 0,
    consolidated_at TEXT,
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
  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    content, subject, content=entries, content_rowid=rowid
  )
  `,
  `
  CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, content, subject) VALUES (new.rowid, new.content, new.subject);
  END
  `,
  `
  CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, content, subject) VALUES ('delete', old.rowid, old.content, old.subject);
  END
  `,
  `
  CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, content, subject) VALUES ('delete', old.rowid, old.content, old.subject);
    INSERT INTO entries_fts(rowid, content, subject) VALUES (new.rowid, new.content, new.subject);
  END
  `,
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

// Columns added after the initial schema shipped must be added via ALTER TABLE.
// CREATE TABLE IF NOT EXISTS does not backfill columns for existing databases.
const COLUMN_MIGRATIONS: readonly ColumnMigration[] = [
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
];

export async function initSchema(client: Client): Promise<void> {
  for (const statement of CREATE_TABLE_AND_TRIGGER_STATEMENTS) {
    await client.execute(statement);
  }

  // Apply column migrations before creating any indexes that reference those columns.
  for (const migration of COLUMN_MIGRATIONS) {
    const info = await client.execute(`PRAGMA table_info(${migration.table})`);
    const hasColumn = info.rows.some((row) => String((row as { name?: unknown }).name) === migration.column);
    if (!hasColumn) {
      await client.execute(migration.sql);
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
