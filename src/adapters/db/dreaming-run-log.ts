import { randomUUID } from "node:crypto";

import type { DreamRunAction } from "../../core/dreaming/domain/action-types.js";
import { normalizeDreamProposalIssueIdentity } from "../../core/dreaming/domain/proposal-review.js";
import { readRequiredString } from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";
import {
  type DreamProposalBacklogRow,
  type DreamRun,
  type PersistedDreamProposalInput,
  normalizeDurableIds,
  normalizeInteger,
  normalizeNumber,
  normalizeOptionalString,
  normalizeStringArray,
  normalizeTimestamp,
} from "./dreaming-run-shared.js";

export type { DreamProposalBacklogRow, DreamRun, PersistedDreamProposalInput };
export { createDreamRun, completeDreamRun, createProfileSnapshot, getDailyDreamCost, reviewDreamProposal, updateDreamState } from "./dreaming-run-lifecycle.js";
export {
  getActiveProfileSnapshot,
  getDreamProposal,
  getDreamRunActions,
  getDreamRunHistory,
  getDreamRunProposals,
  getLastDreamRun,
  listDreamProposalBacklog,
} from "./dreaming-run-read.js";

/**
 * Inserts one dreaming action audit row.
 *
 * @param executor - SQL executor used for the insert.
 * @param action - Action payload to persist.
 */
export async function logDreamAction(executor: SqlExecutor, action: DreamRunAction): Promise<void> {
  const durableIds = normalizeDurableIds(action.durableIds);
  await assertDurablesExist(executor, durableIds);

  await executor.execute({
    sql: `
      INSERT INTO dream_run_actions (
        id,
        run_id,
        action_type,
        durable_id,
        durable_ids,
        reasoning,
        recall_delta,
        details_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      action.id.trim().length > 0 ? action.id.trim() : randomUUID(),
      action.runId.trim(),
      action.actionType,
      durableIds[0] ?? null,
      JSON.stringify(durableIds),
      action.reasoning,
      JSON.stringify(action.recallDelta ?? null),
      JSON.stringify(action.details ?? null),
      normalizeTimestamp(action.createdAt) ?? new Date().toISOString(),
    ],
  });
}

/**
 * Inserts one structured unresolved proposal row.
 *
 * @param executor - SQL executor used for the insert.
 * @param proposal - Structured unresolved proposal payload.
 */
export async function logDreamProposal(executor: SqlExecutor, proposal: PersistedDreamProposalInput): Promise<void> {
  const reviewStatus = "reviewStatus" in proposal ? proposal.reviewStatus : "open";
  const reviewedAt = "reviewedAt" in proposal ? proposal.reviewedAt : null;
  const reviewReason = "reviewReason" in proposal ? proposal.reviewReason : null;
  const appliedActionCount = "appliedActionCount" in proposal ? proposal.appliedActionCount : 0;
  const logicalIssue = normalizeDreamProposalIssueIdentity({
    groupId: proposal.groupId,
    issueKind: proposal.issueKind,
  });

  if (reviewStatus === "open") {
    const existingOpenProposal = await findOpenProposalIssue(executor, {
      groupId: logicalIssue.groupId,
      issueKind: logicalIssue.issueKind,
    });

    if (existingOpenProposal) {
      await executor.execute({
        sql: `
          UPDATE dream_proposals
          SET run_id = ?,
              scope = ?,
              durable_ids = ?,
              current_claim_keys = ?,
              proposed_claim_keys = ?,
              rationale = ?,
              confidence = ?,
              source = ?,
              eligible_for_apply = ?,
              review_status = 'open',
              reviewed_at = NULL,
              review_reason = NULL,
              applied_action_count = 0
          WHERE id = ?
        `,
        args: [
          proposal.runId.trim(),
          proposal.scope,
          JSON.stringify(normalizeDurableIds(proposal.durableIds)),
          JSON.stringify(normalizeStringArray(proposal.currentClaimKeys)),
          JSON.stringify(normalizeStringArray(proposal.proposedClaimKeys)),
          proposal.rationale,
          normalizeNumber(proposal.confidence),
          proposal.source.trim(),
          proposal.eligibleForApply ? 1 : 0,
          existingOpenProposal.id,
        ],
      });
      return;
    }
  }

  await executor.execute({
    sql: `
      INSERT INTO dream_proposals (
        id,
        run_id,
        group_id,
        issue_kind,
        scope,
        durable_ids,
        current_claim_keys,
        proposed_claim_keys,
        rationale,
        confidence,
        source,
        eligible_for_apply,
        review_status,
        reviewed_at,
        review_reason,
        applied_action_count,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      proposal.id.trim().length > 0 ? proposal.id.trim() : randomUUID(),
      proposal.runId.trim(),
      logicalIssue.groupId,
      logicalIssue.issueKind,
      proposal.scope,
      JSON.stringify(normalizeDurableIds(proposal.durableIds)),
      JSON.stringify(normalizeStringArray(proposal.currentClaimKeys)),
      JSON.stringify(normalizeStringArray(proposal.proposedClaimKeys)),
      proposal.rationale,
      normalizeNumber(proposal.confidence),
      proposal.source.trim(),
      proposal.eligibleForApply ? 1 : 0,
      reviewStatus,
      normalizeTimestamp(reviewedAt ?? undefined),
      normalizeOptionalString(reviewReason ?? undefined),
      normalizeInteger(appliedActionCount ?? 0),
      normalizeTimestamp(proposal.createdAt) ?? new Date().toISOString(),
    ],
  });
}

async function assertDurablesExist(executor: SqlExecutor, durableIds: string[]): Promise<void> {
  if (durableIds.length === 0) {
    return;
  }

  const result = await executor.execute({
    sql: `SELECT id FROM durables WHERE id IN (${durableIds.map(() => "?").join(", ")})`,
    args: durableIds,
  });
  const existingIds = new Set(result.rows.map((row) => String(row.id ?? "")));
  const missingDurableIds = durableIds.filter((durableId) => !existingIds.has(durableId));
  if (missingDurableIds.length > 0) {
    throw new Error(`Cannot persist dreaming action for unknown durable${missingDurableIds.length === 1 ? "" : "s"}: ${missingDurableIds.join(", ")}.`);
  }
}

async function findOpenProposalIssue(
  executor: SqlExecutor,
  input: {
    groupId: string;
    issueKind: string;
  },
): Promise<{ id: string } | null> {
  const result = await executor.execute({
    sql: `
      SELECT id
      FROM dream_proposals
      WHERE group_id = ?
        AND issue_kind = ?
        AND review_status = 'open'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    args: [input.groupId, input.issueKind],
  });

  const row = result.rows[0];
  return row ? { id: readRequiredString(row, "id") } : null;
}
