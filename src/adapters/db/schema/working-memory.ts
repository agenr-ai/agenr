export /** SQL statement that creates lean working sets for fresh database setup. */
const CREATE_WORKING_SETS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS working_sets (
    id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    title TEXT,
    objective TEXT,
    status TEXT NOT NULL,
    summary TEXT,
    snapshot_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    project TEXT,
    session_id TEXT,
    conversation_key TEXT,
    cwd TEXT,
    git_root TEXT,
    git_branch TEXT,
    task_id TEXT,
    source TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    closed_at TEXT,
    close_reason TEXT,
    episode_id TEXT
  )
`;

export /** SQL statement that creates schema v11 working events. */
const CREATE_WORKING_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS working_events (
    id TEXT PRIMARY KEY,
    working_set_id TEXT NOT NULL REFERENCES working_sets(id),
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    actor TEXT,
    source TEXT,
    host_event_id TEXT,
    turn_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(working_set_id, sequence)
  )
`;

export /** Index for working-set status sweeps ordered by last activity. */
const CREATE_WORKING_SETS_STATUS_LAST_ACTIVE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_working_sets_status_last_active
  ON working_sets(status, last_active_at)
`;

export /** Index for scope-scoped working-set lookups. */
const CREATE_WORKING_SETS_SCOPE_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_working_sets_scope_status
  ON working_sets(scope_key, status)
`;

export /** Index for working-event history ordered by creation time. */
const CREATE_WORKING_EVENTS_WORKING_SET_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_working_events_working_set_created_at
  ON working_events(working_set_id, created_at)
`;

export /** Partial unique index enforcing one open working set per scope. */
const CREATE_WORKING_SETS_ONE_OPEN_PER_SCOPE_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS working_sets_one_open_per_scope
  ON working_sets(scope_key)
  WHERE status NOT IN ('closed', 'abandoned')
`;

export /** Lean working-memory DDL applied during init. */
const WORKING_MEMORY_SCHEMA_STATEMENTS = [
  CREATE_WORKING_SETS_TABLE_SQL,
  CREATE_WORKING_EVENTS_TABLE_SQL,
  CREATE_WORKING_SETS_STATUS_LAST_ACTIVE_INDEX_SQL,
  CREATE_WORKING_SETS_SCOPE_STATUS_INDEX_SQL,
  CREATE_WORKING_EVENTS_WORKING_SET_CREATED_AT_INDEX_SQL,
  CREATE_WORKING_SETS_ONE_OPEN_PER_SCOPE_INDEX_SQL,
] as const;
