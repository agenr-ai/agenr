export /** SQL statement that creates schema v12 session lineage edges. */
const CREATE_SESSION_LINEAGE_EDGES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_lineage_edges (
    id TEXT PRIMARY KEY,
    child_session_key TEXT NOT NULL,
    parent_session_key TEXT,
    parent_source_ref TEXT,
    reason TEXT NOT NULL,
    fork_entry_id TEXT,
    fork_position TEXT,
    observed_at TEXT NOT NULL
  )
`;

export /** SQL statement that creates schema v12 session artifacts. */
const CREATE_SESSION_ARTIFACTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_artifacts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    session_key TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_ref TEXT,
    content_hash TEXT NOT NULL,
    summary TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    UNIQUE(kind, source, source_id)
  )
`;

export /** Index for child-session lineage lookups ordered by observation time. */
const CREATE_SESSION_LINEAGE_EDGES_CHILD_OBSERVED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_session_lineage_edges_child_observed
  ON session_lineage_edges(child_session_key, observed_at)
`;

export /** Index for parent-session lineage lookups ordered by observation time. */
const CREATE_SESSION_LINEAGE_EDGES_PARENT_OBSERVED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_session_lineage_edges_parent_observed
  ON session_lineage_edges(parent_session_key, observed_at)
`;

export /** Index for lineage reason scans ordered by observation time. */
const CREATE_SESSION_LINEAGE_EDGES_REASON_OBSERVED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_session_lineage_edges_reason_observed
  ON session_lineage_edges(reason, observed_at)
`;

export /** Index for session-key artifact lookups ordered by kind and creation time. */
const CREATE_SESSION_ARTIFACTS_SESSION_KIND_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_session_artifacts_session_kind
  ON session_artifacts(session_key, kind, created_at)
`;

export /** Index for artifact source identity lookups. */
const CREATE_SESSION_ARTIFACTS_SOURCE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_session_artifacts_source
  ON session_artifacts(source, source_id)
`;

export /** Index for artifact source-ref continuity lookups ordered by kind and creation time. */
const CREATE_SESSION_ARTIFACTS_SOURCE_REF_KIND_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_session_artifacts_source_ref_kind
  ON session_artifacts(source_ref, kind, created_at)
  WHERE source_ref IS NOT NULL
`;

export /** Index for artifact content-hash dedupe scans. */
const CREATE_SESSION_ARTIFACTS_CONTENT_HASH_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_session_artifacts_content_hash
  ON session_artifacts(content_hash)
`;

export /** Partial index for expiring artifact retention sweeps. */
const CREATE_SESSION_ARTIFACTS_EXPIRES_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_session_artifacts_expires_at
  ON session_artifacts(expires_at)
  WHERE expires_at IS NOT NULL
`;

export /** Schema v12 session-memory DDL applied during init and v11 migrations. */
const SESSION_MEMORY_SCHEMA_STATEMENTS = [
  CREATE_SESSION_LINEAGE_EDGES_TABLE_SQL,
  CREATE_SESSION_ARTIFACTS_TABLE_SQL,
  CREATE_SESSION_LINEAGE_EDGES_CHILD_OBSERVED_INDEX_SQL,
  CREATE_SESSION_LINEAGE_EDGES_PARENT_OBSERVED_INDEX_SQL,
  CREATE_SESSION_LINEAGE_EDGES_REASON_OBSERVED_INDEX_SQL,
  CREATE_SESSION_ARTIFACTS_SESSION_KIND_INDEX_SQL,
  CREATE_SESSION_ARTIFACTS_SOURCE_INDEX_SQL,
  CREATE_SESSION_ARTIFACTS_SOURCE_REF_KIND_INDEX_SQL,
  CREATE_SESSION_ARTIFACTS_CONTENT_HASH_INDEX_SQL,
  CREATE_SESSION_ARTIFACTS_EXPIRES_AT_INDEX_SQL,
] as const;
