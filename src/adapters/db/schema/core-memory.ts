export /** Canonical core-memory tables created during database initialization. */ const CORE_TABLE_NAMES = [
  "durables",
  "durables_fts",
  "ingest_log",
  "episodes",
  "procedures",
  "procedures_fts",
  "recall_events",
  "_meta",
] as const;

/** FTS indexes non-superseded rows; query-time filters exclude stale rows from live recall. */
const FTS_DURABLE_INSERT_WHEN = "new.superseded_by IS NULL";
const FTS_DURABLE_OLD_WHEN = "old.superseded_by IS NULL";
const FTS_PROCEDURE_INSERT_WHEN = FTS_DURABLE_INSERT_WHEN;
const FTS_PROCEDURE_OLD_WHEN = FTS_DURABLE_OLD_WHEN;

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
    -- Neutral placeholder reserved for future quality scoring. It is not an
    -- active production ranking signal while normal ingestion leaves it at 0.5.
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
    user_id TEXT,
    project TEXT,
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
  WHEN ${FTS_DURABLE_INSERT_WHEN} BEGIN
    INSERT INTO durables_fts(rowid, content, subject)
    VALUES (new.rowid, new.content, new.subject);
  END
`;

/** SQL statement that recreates the FTS delete trigger for active durables. */
const CREATE_DURABLES_FTS_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS durables_ad AFTER DELETE ON durables
  WHEN ${FTS_DURABLE_OLD_WHEN} BEGIN
    INSERT INTO durables_fts(durables_fts, rowid, content, subject)
    VALUES ('delete', old.rowid, old.content, old.subject);
  END
`;

/** SQL statement that recreates the FTS update trigger for active durables. */
const CREATE_DURABLES_FTS_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS durables_au AFTER UPDATE ON durables BEGIN
    INSERT INTO durables_fts(durables_fts, rowid, content, subject)
    SELECT 'delete', old.rowid, old.content, old.subject
    WHERE ${FTS_DURABLE_OLD_WHEN};

    INSERT INTO durables_fts(rowid, content, subject)
    SELECT new.rowid, new.content, new.subject
    WHERE ${FTS_DURABLE_INSERT_WHEN};
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
    valid_from TEXT,
    valid_to TEXT,
    supersession_kind TEXT,
    supersession_reason TEXT,
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
    valid_from TEXT,
    valid_to TEXT,
    supersession_kind TEXT,
    supersession_reason TEXT,
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
  WHEN ${FTS_PROCEDURE_INSERT_WHEN} BEGIN
    INSERT INTO procedures_fts(rowid, title, recall_text)
    VALUES (new.rowid, new.title, new.recall_text);
  END
`;

/** SQL statement that recreates the FTS delete trigger for active procedures. */
const CREATE_PROCEDURES_FTS_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS procedures_ad AFTER DELETE ON procedures
  WHEN ${FTS_PROCEDURE_OLD_WHEN} BEGIN
    INSERT INTO procedures_fts(procedures_fts, rowid, title, recall_text)
    VALUES ('delete', old.rowid, old.title, old.recall_text);
  END
`;

/** SQL statement that recreates the FTS update trigger for active procedures. */
const CREATE_PROCEDURES_FTS_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS procedures_au AFTER UPDATE ON procedures BEGIN
    INSERT INTO procedures_fts(procedures_fts, rowid, title, recall_text)
    SELECT 'delete', old.rowid, old.title, old.recall_text
    WHERE ${FTS_PROCEDURE_OLD_WHEN};

    INSERT INTO procedures_fts(rowid, title, recall_text)
    SELECT new.rowid, new.title, new.recall_text
    WHERE ${FTS_PROCEDURE_INSERT_WHEN};
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

const CREATE_EPISODES_VALID_FROM_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_episodes_valid_from
  ON episodes(valid_from)
  WHERE valid_from IS NOT NULL
`;

const CREATE_EPISODES_VALID_TO_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_episodes_valid_to
  ON episodes(valid_to)
  WHERE valid_to IS NOT NULL
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

const CREATE_PROCEDURES_VALID_FROM_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_procedures_valid_from
  ON procedures(valid_from)
  WHERE valid_from IS NOT NULL
`;

const CREATE_PROCEDURES_VALID_TO_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_procedures_valid_to
  ON procedures(valid_to)
  WHERE valid_to IS NOT NULL
`;

const CREATE_PROCEDURES_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_procedures_created_at
  ON procedures(created_at)
`;

const CREATE_PROCEDURES_ACTIVE_KEY_UNIQUE_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_procedures_active_procedure_key
  ON procedures(procedure_key)
  WHERE superseded_by IS NULL
    AND valid_to IS NULL
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
    AND superseded_by IS NULL
`;

const CORE_SCHEMA_STATEMENTS = [
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
  CREATE_META_TABLE_SQL,
  CREATE_DURABLES_CONTENT_HASH_INDEX_SQL,
  CREATE_DURABLES_NORM_CONTENT_HASH_INDEX_SQL,
  CREATE_DURABLES_TYPE_INDEX_SQL,
  CREATE_DURABLES_EXPIRY_INDEX_SQL,
  CREATE_DURABLES_CREATED_AT_INDEX_SQL,
  CREATE_DURABLES_CLAIM_KEY_INDEX_SQL,
  CREATE_DURABLES_VALID_FROM_INDEX_SQL,
  CREATE_DURABLES_VALID_TO_INDEX_SQL,
  CREATE_EPISODES_STARTED_AT_INDEX_SQL,
  CREATE_EPISODES_ENDED_AT_INDEX_SQL,
  CREATE_EPISODES_SOURCE_INDEX_SQL,
  CREATE_EPISODES_SOURCE_ID_INDEX_SQL,
  CREATE_EPISODES_VALID_FROM_INDEX_SQL,
  CREATE_EPISODES_VALID_TO_INDEX_SQL,
  CREATE_EPISODES_SOURCE_SOURCE_ID_UNIQUE_INDEX_SQL,
  CREATE_PROCEDURES_PROCEDURE_KEY_INDEX_SQL,
  CREATE_PROCEDURES_REVISION_HASH_INDEX_SQL,
  CREATE_PROCEDURES_SOURCE_HASH_INDEX_SQL,
  CREATE_PROCEDURES_VALID_FROM_INDEX_SQL,
  CREATE_PROCEDURES_VALID_TO_INDEX_SQL,
  CREATE_PROCEDURES_CREATED_AT_INDEX_SQL,
  CREATE_PROCEDURES_ACTIVE_KEY_UNIQUE_INDEX_SQL,
  CREATE_RECALL_EVENTS_DURABLE_ID_INDEX_SQL,
  CREATE_RECALL_EVENTS_RECALLED_AT_INDEX_SQL,
] as const;

export {
  CORE_SCHEMA_STATEMENTS,
  CREATE_DURABLES_EMBEDDING_INDEX_SQL,
  CREATE_DURABLES_FTS_DELETE_TRIGGER_SQL,
  CREATE_DURABLES_FTS_INSERT_TRIGGER_SQL,
  CREATE_DURABLES_FTS_UPDATE_TRIGGER_SQL,
  CREATE_EPISODES_EMBEDDING_INDEX_SQL,
  CREATE_PROCEDURES_EMBEDDING_INDEX_SQL,
  CREATE_PROCEDURES_FTS_DELETE_TRIGGER_SQL,
  CREATE_PROCEDURES_FTS_INSERT_TRIGGER_SQL,
  CREATE_PROCEDURES_FTS_UPDATE_TRIGGER_SQL,
  DURABLE_VECTOR_INDEX_NAME,
  EPISODE_VECTOR_INDEX_NAME,
  PROCEDURE_VECTOR_INDEX_NAME,
};
