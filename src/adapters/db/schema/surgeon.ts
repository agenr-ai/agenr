export /** SQL statement that stores surgeon maintenance run metadata. */
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

export /** SQL statement that stores the per-action audit trail for surgeon runs. */
const CREATE_SURGEON_RUN_ACTIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS surgeon_run_actions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES surgeon_runs(id),
    action_type TEXT NOT NULL,
    entry_id TEXT,
    entry_ids TEXT NOT NULL DEFAULT '[]',
    reasoning TEXT NOT NULL DEFAULT '',
    recall_delta TEXT,
    details_json TEXT,
    created_at TEXT NOT NULL
  )
`;

export /** Index for surgeon action lookups by run id. */
const CREATE_SURGEON_RUN_ACTIONS_RUN_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_surgeon_run_actions_run_id
  ON surgeon_run_actions(run_id)
`;

export /** Index for surgeon action lookups by entry id. */
const CREATE_SURGEON_RUN_ACTIONS_ENTRY_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_surgeon_run_actions_entry_id
  ON surgeon_run_actions(entry_id)
`;

export /** Index for surgeon action scans ordered by creation time. */
const CREATE_SURGEON_RUN_ACTIONS_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_surgeon_run_actions_created_at
  ON surgeon_run_actions(created_at)
`;

export /** SQL statement that stores structured unresolved proposals for surgeon runs. */
const CREATE_SURGEON_RUN_PROPOSALS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS surgeon_run_proposals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES surgeon_runs(id),
    group_id TEXT NOT NULL,
    issue_kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    entry_ids TEXT NOT NULL DEFAULT '[]',
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

export /** Index for surgeon proposal lookups by run id. */
const CREATE_SURGEON_RUN_PROPOSALS_RUN_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_surgeon_run_proposals_run_id
  ON surgeon_run_proposals(run_id)
`;

export /** Index for surgeon proposal lookups by group id. */
const CREATE_SURGEON_RUN_PROPOSALS_GROUP_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_surgeon_run_proposals_group_id
  ON surgeon_run_proposals(group_id)
`;

export /** Index for surgeon proposal scans ordered by creation time. */
const CREATE_SURGEON_RUN_PROPOSALS_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_surgeon_run_proposals_created_at
  ON surgeon_run_proposals(created_at)
`;

export /** Index for surgeon proposal review-status sweeps. */
const CREATE_SURGEON_RUN_PROPOSALS_REVIEW_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_surgeon_run_proposals_review_status
  ON surgeon_run_proposals(review_status)
`;

export /** Index for open surgeon proposal issue scans. */
const CREATE_SURGEON_RUN_PROPOSALS_OPEN_ISSUE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_surgeon_run_proposals_open_issue
  ON surgeon_run_proposals(review_status, group_id, issue_kind)
`;

export /** Surgeon run and action DDL applied during init. */
const SURGEON_CORE_SCHEMA_STATEMENTS = [
  CREATE_SURGEON_RUNS_TABLE_SQL,
  CREATE_SURGEON_RUN_ACTIONS_TABLE_SQL,
  CREATE_SURGEON_RUN_ACTIONS_RUN_ID_INDEX_SQL,
  CREATE_SURGEON_RUN_ACTIONS_ENTRY_ID_INDEX_SQL,
  CREATE_SURGEON_RUN_ACTIONS_CREATED_AT_INDEX_SQL,
] as const;

export /** Initial surgeon proposal DDL applied during v6 and v8 migrations. */
const SURGEON_PROPOSAL_INITIAL_SCHEMA_STATEMENTS = [
  CREATE_SURGEON_RUN_PROPOSALS_TABLE_SQL,
  CREATE_SURGEON_RUN_PROPOSALS_RUN_ID_INDEX_SQL,
  CREATE_SURGEON_RUN_PROPOSALS_GROUP_ID_INDEX_SQL,
  CREATE_SURGEON_RUN_PROPOSALS_CREATED_AT_INDEX_SQL,
] as const;

export /** Surgeon proposal DDL applied during init. */
const SURGEON_PROPOSAL_SCHEMA_STATEMENTS = [
  ...SURGEON_PROPOSAL_INITIAL_SCHEMA_STATEMENTS,
  CREATE_SURGEON_RUN_PROPOSALS_REVIEW_STATUS_INDEX_SQL,
  CREATE_SURGEON_RUN_PROPOSALS_OPEN_ISSUE_INDEX_SQL,
] as const;

export /** Full surgeon DDL applied during init. */
const SURGEON_SCHEMA_STATEMENTS = [...SURGEON_CORE_SCHEMA_STATEMENTS, ...SURGEON_PROPOSAL_SCHEMA_STATEMENTS] as const;
