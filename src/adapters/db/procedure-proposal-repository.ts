import { randomUUID } from "node:crypto";

import {
  PROCEDURE_PROPOSAL_STATUSES,
  type CreateProcedureProposalInput,
  type ClaimProcedureProposalApplyInput,
  type CompleteProcedureProposalApplyInput,
  type ProcedureProposalListFilter,
  type ProcedureProposalRecord,
  type ProcedureProposalRepository,
  type ProcedureProposalReviewResult,
  type ProcedureProposalStatus,
  type ReleaseProcedureProposalApplyInput,
  type ReviewProcedureProposalInput,
} from "../../app/procedures/proposals/repository.js";
import { normalizeBoundedLimit } from "../../app/working-memory/limits.js";
import type { SqlDatabase } from "./client.js";
import type { SqlExecutor } from "./queries.js";

const PROPOSAL_SELECT_COLUMNS = `
  id,
  working_set_id,
  candidate_fingerprint,
  subject,
  content,
  evidence_event_sequences,
  source_ref,
  status,
  review_reason,
  reviewed_at,
  applied_procedure_path,
  created_at
`;

/**
 * Creates a libSQL-backed repository for reviewable procedure proposals.
 *
 * @param database - Initialized agenr database.
 * @returns Procedure-proposal repository.
 */
export function createProcedureProposalRepository(database: SqlDatabase): ProcedureProposalRepository {
  return {
    getProposal: (id) => getProposal(database, id),
    listProposals: (filter) => listProposals(database, filter),
    findProposalByFingerprint: (workingSetId, candidateFingerprint) => findProposalByFingerprint(database, workingSetId, candidateFingerprint),
    listOpenProposalWorkingSetIds: (workingSetIds) => listOpenProposalWorkingSetIds(database, workingSetIds),
    createProposal: (input) => createProposal(database, input),
    claimApply: (input) => claimApply(database, input),
    completeApply: (input) => completeApply(database, input),
    releaseApply: (input) => releaseApply(database, input),
    reviewProposal: (input) => reviewProposal(database, input),
  };
}

/** Loads one proposal by primary key. */
async function getProposal(executor: SqlExecutor, id: string): Promise<ProcedureProposalRecord | null> {
  const normalizedId = id.trim();
  if (!normalizedId) {
    return null;
  }

  const result = await executor.execute({
    sql: `
      SELECT ${PROPOSAL_SELECT_COLUMNS}
      FROM procedure_proposals
      WHERE id = ?
      LIMIT 1
    `,
    args: [normalizedId],
  });
  const row = result.rows[0];
  return row ? mapProposalRow(row) : null;
}

/** Lists proposals newest first with optional status filtering. */
async function listProposals(executor: SqlExecutor, filter: ProcedureProposalListFilter): Promise<ProcedureProposalRecord[]> {
  const conditions: string[] = [];
  const args: Array<string | number> = [];
  if (filter.statuses && filter.statuses.length > 0) {
    conditions.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
    args.push(...filter.statuses);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = normalizeBoundedLimit(filter.limit, 20, 100);
  const result = await executor.execute({
    sql: `
      SELECT ${PROPOSAL_SELECT_COLUMNS}
      FROM procedure_proposals
      ${where}
      ORDER BY created_at DESC, id ASC
      LIMIT ?
    `,
    args: [...args, limit],
  });

  return result.rows.map((row) => mapProposalRow(row));
}

/** Finds one proposal by its idempotency key. */
async function findProposalByFingerprint(executor: SqlExecutor, workingSetId: string, candidateFingerprint: string): Promise<ProcedureProposalRecord | null> {
  const result = await executor.execute({
    sql: `
      SELECT ${PROPOSAL_SELECT_COLUMNS}
      FROM procedure_proposals
      WHERE working_set_id = ?
        AND candidate_fingerprint = ?
      LIMIT 1
    `,
    args: [workingSetId, candidateFingerprint],
  });
  const row = result.rows[0];
  return row ? mapProposalRow(row) : null;
}

/** Lists candidate working-set ids that still have open procedure proposals. */
async function listOpenProposalWorkingSetIds(executor: SqlExecutor, workingSetIds: string[]): Promise<Set<string>> {
  const normalizedIds = [...new Set(workingSetIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  if (normalizedIds.length === 0) {
    return new Set();
  }

  const result = await executor.execute({
    sql: `
      SELECT DISTINCT working_set_id
      FROM procedure_proposals
      WHERE status IN ('open', 'applying')
        AND working_set_id IN (${normalizedIds.map(() => "?").join(", ")})
    `,
    args: normalizedIds,
  });

  return new Set(result.rows.flatMap((row) => (typeof row.working_set_id === "string" ? [row.working_set_id] : [])));
}

/** Persists one open proposal. */
async function createProposal(executor: SqlExecutor, input: CreateProcedureProposalInput): Promise<ProcedureProposalRecord> {
  const id = randomUUID();
  await executor.execute({
    sql: `
      INSERT INTO procedure_proposals (
        id,
        working_set_id,
        candidate_fingerprint,
        subject,
        content,
        evidence_event_sequences,
        source_ref,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `,
    args: [
      id,
      input.workingSetId,
      input.candidateFingerprint,
      input.subject,
      input.content,
      JSON.stringify(input.evidenceEventSequences),
      input.sourceRef?.trim() ? input.sourceRef.trim() : null,
      input.now,
    ],
  });

  const created = await getProposal(executor, id);
  if (!created) {
    throw new Error(`Procedure proposal ${id} was not found after insert.`);
  }

  return created;
}

/** Claims one open proposal before external apply side effects run. */
async function claimApply(database: SqlDatabase, input: ClaimProcedureProposalApplyInput): Promise<ProcedureProposalReviewResult> {
  return database.withTransaction(async (transaction) => {
    const executor = transaction as SqlDatabase;
    const current = await getProposal(executor, input.proposalId);
    if (!current) {
      return { kind: "not_found" };
    }

    if (current.status !== "open") {
      return { kind: "already_reviewed", status: current.status };
    }

    await executor.execute({
      sql: `
        UPDATE procedure_proposals
        SET status = 'applying'
        WHERE id = ?
          AND status = 'open'
      `,
      args: [current.id],
    });

    const updated = await getProposal(executor, current.id);
    if (!updated) {
      throw new Error(`Procedure proposal ${current.id} was not found after apply claim.`);
    }

    return { proposal: updated };
  });
}

/** Finalizes one claimed proposal after external apply side effects succeed. */
async function completeApply(database: SqlDatabase, input: CompleteProcedureProposalApplyInput): Promise<ProcedureProposalReviewResult> {
  return database.withTransaction(async (transaction) => {
    const executor = transaction as SqlDatabase;
    const current = await getProposal(executor, input.proposalId);
    if (!current) {
      return { kind: "not_found" };
    }

    if (current.status !== "applying") {
      return { kind: "already_reviewed", status: current.status };
    }

    await executor.execute({
      sql: `
        UPDATE procedure_proposals
        SET status = 'applied',
            review_reason = ?,
            reviewed_at = ?,
            applied_procedure_path = ?
        WHERE id = ?
          AND status = 'applying'
      `,
      args: [input.reason, input.now, input.appliedProcedurePath, current.id],
    });

    const updated = await getProposal(executor, current.id);
    if (!updated) {
      throw new Error(`Procedure proposal ${current.id} was not found after apply finalize.`);
    }

    return { proposal: updated };
  });
}

/** Releases a failed apply claim back to open review. */
async function releaseApply(database: SqlDatabase, input: ReleaseProcedureProposalApplyInput): Promise<void> {
  await database.execute({
    sql: `
      UPDATE procedure_proposals
      SET status = 'open'
      WHERE id = ?
        AND status = 'applying'
    `,
    args: [input.proposalId],
  });
}

/** Settles one open proposal with a terminal review decision. */
async function reviewProposal(database: SqlDatabase, input: ReviewProcedureProposalInput): Promise<ProcedureProposalReviewResult> {
  return database.withTransaction(async (transaction) => {
    const executor = transaction as SqlDatabase;
    const current = await getProposal(executor, input.proposalId);
    if (!current) {
      return { kind: "not_found" };
    }

    if (current.status !== "open") {
      return { kind: "already_reviewed", status: current.status };
    }

    await executor.execute({
      sql: `
        UPDATE procedure_proposals
        SET status = ?,
            review_reason = ?,
            reviewed_at = ?,
            applied_procedure_path = ?
        WHERE id = ?
          AND status = 'open'
      `,
      args: [input.decision, input.reason, input.now, input.appliedProcedurePath ?? null, current.id],
    });

    const updated = await getProposal(executor, current.id);
    if (!updated) {
      throw new Error(`Procedure proposal ${current.id} was not found after review.`);
    }

    return { proposal: updated };
  });
}

/** Maps one SQL row to a proposal record. */
function mapProposalRow(row: Record<string, unknown>): ProcedureProposalRecord {
  return {
    id: requireString(row.id, "id"),
    workingSetId: requireString(row.working_set_id, "working_set_id"),
    candidateFingerprint: requireString(row.candidate_fingerprint, "candidate_fingerprint"),
    subject: requireString(row.subject, "subject"),
    content: requireString(row.content, "content"),
    evidenceEventSequences: parseEvidenceSequences(row.evidence_event_sequences),
    ...(typeof row.source_ref === "string" && row.source_ref ? { sourceRef: row.source_ref } : {}),
    status: parseStatus(row.status),
    ...(typeof row.review_reason === "string" && row.review_reason ? { reviewReason: row.review_reason } : {}),
    ...(typeof row.reviewed_at === "string" && row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(typeof row.applied_procedure_path === "string" && row.applied_procedure_path ? { appliedProcedurePath: row.applied_procedure_path } : {}),
    createdAt: requireString(row.created_at, "created_at"),
  };
}

/** Reads one required string column. */
function requireString(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`Procedure proposal column ${column} must be a string.`);
  }

  return value;
}

/** Parses the persisted status into the closed status union. */
function parseStatus(value: unknown): ProcedureProposalStatus {
  if (typeof value === "string" && PROCEDURE_PROPOSAL_STATUSES.includes(value as ProcedureProposalStatus)) {
    return value as ProcedureProposalStatus;
  }

  throw new Error(`Unsupported procedure proposal status "${String(value)}".`);
}

/** Parses persisted evidence sequences into a number array. */
function parseEvidenceSequences(value: unknown): number[] {
  if (typeof value !== "string" || !value) {
    return [];
  }

  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Procedure proposal evidence_event_sequences must be a JSON array.");
  }

  return parsed.filter((item): item is number => typeof item === "number");
}
