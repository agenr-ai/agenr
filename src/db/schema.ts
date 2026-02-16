import type { Client, InValue, Row } from "@libsql/client";

export interface Migration {
  version: number;
  statements: readonly string[];
}

export const CREATE_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
)
`;

export const CREATE_IDX_ENTRIES_EMBEDDING_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entries_embedding ON entries (
    libsql_vector_idx(embedding, 'metric=cosine', 'compress_neighbors=float8', 'max_neighbors=50')
  )
  `;

export const MIGRATION_V1_STATEMENTS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    confidence TEXT NOT NULL,
    expiry TEXT NOT NULL,
    scope TEXT DEFAULT 'private',
    source_file TEXT,
    source_context TEXT,
    embedding F32_BLOB(512),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_recalled_at TEXT,
    recall_count INTEGER DEFAULT 0,
    confirmations INTEGER DEFAULT 0,
    contradictions INTEGER DEFAULT 0,
    superseded_by TEXT,
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
    duration_ms INTEGER NOT NULL
  )
  `,
  CREATE_IDX_ENTRIES_EMBEDDING_SQL,
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
  "CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type)",
  "CREATE INDEX IF NOT EXISTS idx_entries_expiry ON entries(expiry)",
  "CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope)",
  "CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_entries_superseded ON entries(superseded_by)",
  "CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)",
  "CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id)",
  "CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id)",
];

export const MIGRATION_V2_STATEMENTS: readonly string[] = [
  "ALTER TABLE entries ADD COLUMN content_hash TEXT",
  "CREATE INDEX IF NOT EXISTS idx_entries_content_hash ON entries(content_hash)",
  "ALTER TABLE ingest_log ADD COLUMN content_hash TEXT",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_log_file_hash ON ingest_log(file_path, content_hash)",
];

export const MIGRATION_V3_STATEMENTS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS entry_sources (
    merged_entry_id TEXT NOT NULL REFERENCES entries(id),
    source_entry_id TEXT NOT NULL REFERENCES entries(id),
    original_confirmations INTEGER NOT NULL DEFAULT 0,
    original_recall_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (merged_entry_id, source_entry_id)
  )
  `,
  "ALTER TABLE entries ADD COLUMN merged_from INTEGER DEFAULT 0",
  "ALTER TABLE entries ADD COLUMN consolidated_at TEXT",
];

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: MIGRATION_V1_STATEMENTS,
  },
  {
    version: 2,
    statements: MIGRATION_V2_STATEMENTS,
  },
  {
    version: 3,
    statements: MIGRATION_V3_STATEMENTS,
  },
];

function parseVersion(value: InValue | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return Number.NaN;
}

function getVersionFromRow(row: Row): number {
  const value = row.version ?? row.VERSION ?? Object.values(row)[0];
  return parseVersion(value);
}

export async function runMigrations(client: Client): Promise<void> {
  await client.execute(CREATE_MIGRATIONS_TABLE_SQL);

  const appliedResult = await client.execute("SELECT version FROM _migrations");
  const applied = new Set<number>();

  for (const row of appliedResult.rows) {
    const version = getVersionFromRow(row);
    if (Number.isFinite(version)) {
      applied.add(version);
    }
  }

  const pending = [...MIGRATIONS]
    .sort((a, b) => a.version - b.version)
    .filter((migration) => !applied.has(migration.version));

  for (const migration of pending) {
    try {
      await client.execute("BEGIN");
      for (const statement of migration.statements) {
        await client.execute(statement);
      }
      await client.execute({
        sql: "INSERT INTO _migrations (version, applied_at) VALUES (?, ?)",
        args: [migration.version, new Date().toISOString()],
      });
      await client.execute("COMMIT");
    } catch (error) {
      try {
        await client.execute("ROLLBACK");
      } catch {
        // Ignore rollback errors and throw the migration failure.
      }
      throw new Error(
        `Failed to apply migration v${migration.version}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
