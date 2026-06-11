/**
 * Reviewable procedure proposals promoted from working-memory candidates.
 *
 * Intentionally absent from any required-initialized-tables list: the table
 * was added after the required-initialized-tables check shipped, so existing
 * databases must be able to gain it in place through CREATE TABLE IF NOT
 * EXISTS instead of being rejected as uninitialized.
 */
const CREATE_PROCEDURE_PROPOSALS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS procedure_proposals (
    id TEXT PRIMARY KEY,
    working_set_id TEXT NOT NULL,
    candidate_fingerprint TEXT NOT NULL,
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    evidence_event_sequences TEXT NOT NULL DEFAULT '[]',
    source_ref TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    review_reason TEXT,
    reviewed_at TEXT,
    applied_procedure_path TEXT,
    created_at TEXT NOT NULL
  )
`;

/** Unique index that makes consolidation re-runs idempotent per candidate. */
const CREATE_PROCEDURE_PROPOSALS_FINGERPRINT_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_procedure_proposals_fingerprint
  ON procedure_proposals(working_set_id, candidate_fingerprint)
`;

/** Index for proposal review-status sweeps. */
const CREATE_PROCEDURE_PROPOSALS_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_procedure_proposals_status
  ON procedure_proposals(status)
`;

/** Index for proposal scans ordered by creation time. */
const CREATE_PROCEDURE_PROPOSALS_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_procedure_proposals_created_at
  ON procedure_proposals(created_at)
`;

/** Ordered procedure-proposal schema statements applied during initialization. */
const PROCEDURE_PROPOSAL_SCHEMA_STATEMENTS = [
  CREATE_PROCEDURE_PROPOSALS_TABLE_SQL,
  CREATE_PROCEDURE_PROPOSALS_FINGERPRINT_INDEX_SQL,
  CREATE_PROCEDURE_PROPOSALS_STATUS_INDEX_SQL,
  CREATE_PROCEDURE_PROPOSALS_CREATED_AT_INDEX_SQL,
] as const;

export { PROCEDURE_PROPOSAL_SCHEMA_STATEMENTS };
