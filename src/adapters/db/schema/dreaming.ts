export /** Canonical dreaming tables created during database initialization. */ const DREAMING_TABLE_NAMES = [
  "dream_runs",
  "dream_run_actions",
  "dream_proposals",
  "dream_state",
  "profile_snapshots",
] as const;

/** Creates the core dreaming run, action, proposal, and progress tables. */
const CREATE_DREAM_RUNS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS dream_runs (
    id TEXT PRIMARY KEY,
    tier TEXT NOT NULL DEFAULT 'standard',
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
    durables_staled INTEGER DEFAULT 0,
    summary TEXT,
    summary_json TEXT,
    error TEXT,
    dry_run INTEGER NOT NULL DEFAULT 1,
    config_json TEXT
  )
`;

/** SQL statement that stores the per-action audit trail for dreaming runs. */
const CREATE_DREAM_RUN_ACTIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS dream_run_actions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES dream_runs(id),
    action_type TEXT NOT NULL,
    durable_id TEXT,
    durable_ids TEXT NOT NULL DEFAULT '[]',
    reasoning TEXT NOT NULL DEFAULT '',
    evidence_refs_json TEXT,
    details_json TEXT,
    created_at TEXT NOT NULL
  )
`;

/** Index for dream action lookups by run id. */
const CREATE_DREAM_RUN_ACTIONS_RUN_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_dream_run_actions_run_id
  ON dream_run_actions(run_id)
`;

/** Index for dream action lookups by durable id. */
const CREATE_DREAM_RUN_ACTIONS_DURABLE_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_dream_run_actions_durable_id
  ON dream_run_actions(durable_id)
`;

/** Index for dream action scans ordered by creation time. */
const CREATE_DREAM_RUN_ACTIONS_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_dream_run_actions_created_at
  ON dream_run_actions(created_at)
`;

/** SQL statement that stores structured unresolved proposals for dreaming runs. */
const CREATE_DREAM_PROPOSALS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS dream_proposals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES dream_runs(id),
    group_id TEXT NOT NULL,
    issue_kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    durable_ids TEXT NOT NULL DEFAULT '[]',
    current_claim_keys TEXT NOT NULL DEFAULT '[]',
    proposed_claim_keys TEXT NOT NULL DEFAULT '[]',
    rationale TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT '',
    eligible_for_apply INTEGER NOT NULL DEFAULT 0,
    review_status TEXT NOT NULL DEFAULT 'open',
    reviewed_at TEXT,
    review_reason TEXT,
    applied_action_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )
`;

/** Index for dream proposal lookups by run id. */
const CREATE_DREAM_PROPOSALS_RUN_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_dream_proposals_run_id
  ON dream_proposals(run_id)
`;

/** Index for dream proposal lookups by group id. */
const CREATE_DREAM_PROPOSALS_GROUP_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_dream_proposals_group_id
  ON dream_proposals(group_id)
`;

/** Index for dream proposal scans ordered by creation time. */
const CREATE_DREAM_PROPOSALS_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_dream_proposals_created_at
  ON dream_proposals(created_at)
`;

/** Index for dream proposal review-status sweeps. */
const CREATE_DREAM_PROPOSALS_REVIEW_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_dream_proposals_review_status
  ON dream_proposals(review_status)
`;

/** Index for open dream proposal issue scans. */
const CREATE_DREAM_PROPOSALS_OPEN_ISSUE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_dream_proposals_open_issue
  ON dream_proposals(review_status, group_id, issue_kind)
`;

/**
 * Tracks episodes already mined by an applied extract pass so dreaming never
 * re-mines the same session evidence.
 *
 * Intentionally absent from DREAMING_TABLE_NAMES: it was added after the
 * required-initialized-tables check shipped, so existing databases must be
 * able to gain it in place through CREATE TABLE IF NOT EXISTS instead of
 * being rejected as uninitialized.
 */
const CREATE_DREAM_SYNTHESIZED_EPISODES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS dream_synthesized_episodes (
    episode_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    synthesized_at TEXT NOT NULL
  )
`;

/** Index for synthesized-episode lookups by run id. */
const CREATE_DREAM_SYNTHESIZED_EPISODES_RUN_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_dream_synthesized_episodes_run_id
  ON dream_synthesized_episodes(run_id)
`;

/** Creates the persisted dreaming state table. */
const CREATE_DREAM_STATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS dream_state (
    id TEXT PRIMARY KEY DEFAULT 'default',
    last_successful_run_at TEXT,
    last_scan_cursor_json TEXT,
    active_profile_snapshot_id TEXT,
    unsynthesized_importance_sum REAL NOT NULL DEFAULT 0,
    run_lock_holder TEXT,
    run_lock_heartbeat_at TEXT,
    updated_at TEXT NOT NULL
  )
`;

/** Creates the profile snapshot table used by projected memory views. */
const CREATE_PROFILE_SNAPSHOTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS profile_snapshots (
    id TEXT PRIMARY KEY,
    durable_ids TEXT NOT NULL DEFAULT '[]',
    directive_ids TEXT,
    as_of TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    run_id TEXT REFERENCES dream_runs(id),
    created_at TEXT NOT NULL
  )
`;

/** Index for profile snapshot lookups by creation time. */
const CREATE_PROFILE_SNAPSHOTS_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_profile_snapshots_created_at
  ON profile_snapshots(created_at)
`;

/** Schema statements required for core dreaming run persistence. */
const DREAMING_CORE_SCHEMA_STATEMENTS = [
  CREATE_DREAM_RUNS_TABLE_SQL,
  CREATE_DREAM_RUN_ACTIONS_TABLE_SQL,
  CREATE_DREAM_RUN_ACTIONS_RUN_ID_INDEX_SQL,
  CREATE_DREAM_RUN_ACTIONS_DURABLE_ID_INDEX_SQL,
  CREATE_DREAM_RUN_ACTIONS_CREATED_AT_INDEX_SQL,
] as const;

/** Schema statements required for extended dreaming state persistence. */
const DREAMING_EXTENDED_SCHEMA_STATEMENTS = [
  CREATE_DREAM_PROPOSALS_TABLE_SQL,
  CREATE_DREAM_PROPOSALS_RUN_ID_INDEX_SQL,
  CREATE_DREAM_PROPOSALS_GROUP_ID_INDEX_SQL,
  CREATE_DREAM_PROPOSALS_CREATED_AT_INDEX_SQL,
  CREATE_DREAM_PROPOSALS_REVIEW_STATUS_INDEX_SQL,
  CREATE_DREAM_PROPOSALS_OPEN_ISSUE_INDEX_SQL,
  CREATE_DREAM_SYNTHESIZED_EPISODES_TABLE_SQL,
  CREATE_DREAM_SYNTHESIZED_EPISODES_RUN_ID_INDEX_SQL,
  CREATE_DREAM_STATE_TABLE_SQL,
  CREATE_PROFILE_SNAPSHOTS_TABLE_SQL,
  CREATE_PROFILE_SNAPSHOTS_CREATED_AT_INDEX_SQL,
] as const;

/** Ordered dreaming schema statements applied during database initialization. */
const DREAMING_SCHEMA_STATEMENTS = [...DREAMING_CORE_SCHEMA_STATEMENTS, ...DREAMING_EXTENDED_SCHEMA_STATEMENTS] as const;

export {
  CREATE_DREAM_RUNS_TABLE_SQL,
  CREATE_DREAM_STATE_TABLE_SQL,
  CREATE_PROFILE_SNAPSHOTS_TABLE_SQL,
  DREAMING_CORE_SCHEMA_STATEMENTS,
  DREAMING_EXTENDED_SCHEMA_STATEMENTS,
  DREAMING_SCHEMA_STATEMENTS,
};
