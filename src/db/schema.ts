import type { Client } from "@libsql/client";

export const CREATE_IDX_ENTRIES_EMBEDDING_SQL = `
  CREATE INDEX IF NOT EXISTS idx_entries_embedding ON entries (
    libsql_vector_idx(embedding, 'metric=cosine', 'compress_neighbors=float8', 'max_neighbors=50')
  )
`;

const SCHEMA_STATEMENTS: readonly string[] = [
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
  "CREATE INDEX IF NOT EXISTS idx_entries_type_canonical_key ON entries(type, canonical_key)",
  "CREATE INDEX IF NOT EXISTS idx_entries_expiry ON entries(expiry)",
  "CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope)",
  "CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_entries_superseded ON entries(superseded_by)",
  "CREATE INDEX IF NOT EXISTS idx_entries_content_hash ON entries(content_hash)",
  "CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)",
  "CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id)",
  "CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_log_file_hash ON ingest_log(file_path, content_hash)",
];

export async function initSchema(client: Client): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await client.execute(statement);
  }
}
