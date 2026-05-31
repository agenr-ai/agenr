export /** SQL statement that creates schema v11 working sets. */
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
    checkpoint_json TEXT,
    budget_json TEXT,
    continuation_policy TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    event_count INTEGER NOT NULL DEFAULT 0,
    heartbeat_at TEXT,
    resume_after TEXT,
    stale_after TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    user_id TEXT,
    project TEXT,
    surface TEXT,
    session_id TEXT,
    session_key TEXT,
    conversation_key TEXT,
    runtime_thread_key TEXT,
    host_thread_id TEXT,
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

export /** Index for git-branch scoped working-set lookups. */
const CREATE_WORKING_SETS_GIT_BRANCH_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_working_sets_git_branch_status
  ON working_sets(git_root, git_branch, status)
`;

export /** Index for session-key scoped working-set lookups. */
const CREATE_WORKING_SETS_SESSION_KEY_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_working_sets_session_key_status
  ON working_sets(session_key, status)
`;

export /** Index for conversation-key scoped working-set lookups. */
const CREATE_WORKING_SETS_CONVERSATION_KEY_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_working_sets_conversation_key_status
  ON working_sets(conversation_key, status)
`;

export /** Index for runtime-thread scoped working-set lookups. */
const CREATE_WORKING_SETS_RUNTIME_THREAD_KEY_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_working_sets_runtime_thread_key_status
  ON working_sets(runtime_thread_key, status)
`;

export /** Index for resume scheduling sweeps. */
const CREATE_WORKING_SETS_STATUS_RESUME_AFTER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_working_sets_status_resume_after
  ON working_sets(status, resume_after)
`;

export /** Index for lease-expiry sweeps. */
const CREATE_WORKING_SETS_LEASE_EXPIRES_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_working_sets_lease_expires_at
  ON working_sets(lease_expires_at)
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

export /** Schema v11 working-memory DDL applied during init and v10 migrations. */
const WORKING_MEMORY_SCHEMA_STATEMENTS = [
  CREATE_WORKING_SETS_TABLE_SQL,
  CREATE_WORKING_EVENTS_TABLE_SQL,
  CREATE_WORKING_SETS_STATUS_LAST_ACTIVE_INDEX_SQL,
  CREATE_WORKING_SETS_SCOPE_STATUS_INDEX_SQL,
  CREATE_WORKING_SETS_GIT_BRANCH_STATUS_INDEX_SQL,
  CREATE_WORKING_SETS_SESSION_KEY_STATUS_INDEX_SQL,
  CREATE_WORKING_SETS_CONVERSATION_KEY_STATUS_INDEX_SQL,
  CREATE_WORKING_SETS_RUNTIME_THREAD_KEY_STATUS_INDEX_SQL,
  CREATE_WORKING_SETS_STATUS_RESUME_AFTER_INDEX_SQL,
  CREATE_WORKING_SETS_LEASE_EXPIRES_AT_INDEX_SQL,
  CREATE_WORKING_EVENTS_WORKING_SET_CREATED_AT_INDEX_SQL,
  CREATE_WORKING_SETS_ONE_OPEN_PER_SCOPE_INDEX_SQL,
] as const;
