import type { DreamProposalReviewStatus, DreamRunProposal } from "../../core/dreaming/types.js";
import type { DreamRunAction } from "../../core/dreaming/domain/action-types.js";
import { readBoolean, readOptionalString, readRequiredString } from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";
import {
  type DreamProposalBacklogRow,
  type DreamRun,
  mapActionRow,
  mapProposalRow,
  mapRunRow,
  parseStoredDreamRunStatus,
  parseStoredDreamTier,
} from "./dreaming-run-shared.js";

/**
 * Loads recent dreaming runs ordered from newest to oldest.
 *
 * @param executor - SQL executor used for the lookup.
 * @param limit - Maximum number of runs to return.
 * @returns Recent dreaming runs.
 */
export async function getDreamRunHistory(executor: SqlExecutor, limit = 10): Promise<DreamRun[]> {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  const result = await executor.execute({
    sql: `
      SELECT
        id,
        tier,
        project,
        started_at,
        completed_at,
        status,
        input_tokens,
        output_tokens,
        estimated_cost_usd,
        model,
        actions_taken,
        actions_skipped,
        durables_retired,
        summary_json,
        error,
        dry_run,
        config_json
      FROM dream_runs
      ORDER BY started_at DESC
      LIMIT ?
    `,
    args: [safeLimit],
  });

  return result.rows.map((row) => mapRunRow(row));
}

/**
 * Loads the most recent dreaming run when one exists.
 *
 * @param executor - SQL executor used for the lookup.
 * @returns Latest dreaming run, or null when absent.
 */
export async function getLastDreamRun(executor: SqlExecutor): Promise<DreamRun | null> {
  const [run] = await getDreamRunHistory(executor, 1);
  return run ?? null;
}

/**
 * Loads the persisted action audit trail for one run.
 *
 * @param executor - SQL executor used for the lookup.
 * @param runId - Run identifier to inspect.
 * @returns Ordered action list for the run.
 */
export async function getDreamRunActions(executor: SqlExecutor, runId: string): Promise<DreamRunAction[]> {
  const result = await executor.execute({
    sql: `
      SELECT
        id,
        run_id,
        action_type,
        durable_ids,
        reasoning,
        recall_delta,
        details_json,
        created_at
      FROM dream_run_actions
      WHERE run_id = ?
      ORDER BY created_at ASC
    `,
    args: [runId.trim()],
  });

  return result.rows.map((row) => mapActionRow(row));
}

/**
 * Loads the persisted unresolved proposal trail for one run.
 *
 * @param executor - SQL executor used for the lookup.
 * @param runId - Run identifier to inspect.
 * @returns Ordered proposal list for the run.
 */
export async function getDreamRunProposals(executor: SqlExecutor, runId: string): Promise<DreamRunProposal[]> {
  const result = await executor.execute({
    sql: `
      SELECT
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
      FROM dream_proposals
      WHERE run_id = ?
      ORDER BY created_at ASC
    `,
    args: [runId.trim()],
  });

  return result.rows.map((row) => mapProposalRow(row));
}

/**
 * Loads one dreaming proposal by its stable identifier.
 *
 * @param executor - SQL executor used for the lookup.
 * @param proposalId - Proposal identifier to resolve.
 * @returns Proposal payload, or null when missing.
 */
export async function getDreamProposal(executor: SqlExecutor, proposalId: string): Promise<DreamRunProposal | null> {
  const result = await executor.execute({
    sql: `
      SELECT
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
      FROM dream_proposals
      WHERE id = ?
      LIMIT 1
    `,
    args: [proposalId.trim()],
  });

  const row = result.rows[0];
  return row ? mapProposalRow(row) : null;
}

/**
 * Lists proposal backlog rows across runs using review-state filters.
 *
 * @param executor - SQL executor used for the lookup.
 * @param query - Optional review-state and pagination filters.
 * @returns Joined backlog rows ordered for operator review.
 */
export async function listDreamProposalBacklog(
  executor: SqlExecutor,
  query: {
    state?: DreamProposalReviewStatus | "all";
    issueKind?: string;
    eligibleOnly?: boolean;
    durableId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<DreamProposalBacklogRow[]> {
  const clauses: string[] = [];
  const args: Array<string | number> = [];
  if (query.state && query.state !== "all") {
    clauses.push("p.review_status = ?");
    args.push(query.state);
  }
  if (query.issueKind) {
    clauses.push("p.issue_kind = ?");
    args.push(query.issueKind.trim());
  }
  if (query.eligibleOnly) {
    clauses.push("p.eligible_for_apply = 1");
  }
  if (query.durableId) {
    clauses.push("EXISTS (SELECT 1 FROM json_each(p.durable_ids) AS je WHERE je.value = ?)");
    args.push(query.durableId.trim());
  }

  const limit = Number.isFinite(query.limit) && (query.limit ?? 0) > 0 ? Math.floor(query.limit!) : 25;
  const offset = Number.isFinite(query.offset) && (query.offset ?? 0) >= 0 ? Math.floor(query.offset!) : 0;
  const dedupeClause = "(p.review_status <> 'open' OR p.open_issue_rank = 1)";
  const whereClause = [dedupeClause, ...clauses].join(" AND ");
  const result = await executor.execute({
    sql: `
      WITH ranked_proposals AS (
        SELECT
          proposal.*,
          CASE
            WHEN proposal.review_status = 'open' THEN MIN(proposal.created_at) OVER (PARTITION BY proposal.group_id, proposal.issue_kind)
            ELSE proposal.created_at
          END AS logical_created_at,
          CASE
            WHEN proposal.review_status = 'open'
              THEN ROW_NUMBER() OVER (PARTITION BY proposal.group_id, proposal.issue_kind ORDER BY proposal.created_at DESC, proposal.id DESC)
            ELSE 1
          END AS open_issue_rank
        FROM dream_proposals AS proposal
      )
      SELECT
        p.id,
        p.run_id,
        p.group_id,
        p.issue_kind,
        p.scope,
        p.durable_ids,
        p.current_claim_keys,
        p.proposed_claim_keys,
        p.rationale,
        p.confidence,
        p.source,
        p.eligible_for_apply,
        p.review_status,
        p.reviewed_at,
        p.review_reason,
        p.applied_action_count,
        p.logical_created_at AS created_at,
        r.tier AS run_tier,
        r.started_at AS run_started_at,
        r.status AS run_status,
        r.dry_run AS run_dry_run
      FROM ranked_proposals AS p
      JOIN dream_runs AS r ON r.id = p.run_id
      WHERE ${whereClause}
      ORDER BY
        CASE WHEN p.review_status = 'open' THEN 0 ELSE 1 END ASC,
        CASE WHEN p.review_status = 'open' THEN p.logical_created_at END ASC,
        CASE WHEN p.review_status <> 'open' THEN p.reviewed_at END DESC,
        p.logical_created_at DESC
      LIMIT ?
      OFFSET ?
    `,
    args: [...args, limit, offset],
  });

  return result.rows.map((row) => ({
    proposal: mapProposalRow(row),
    runPassType: parseStoredDreamTier(readOptionalString(row, "run_tier")),
    runStartedAt: readRequiredString(row, "run_started_at"),
    runStatus: parseStoredDreamRunStatus(readOptionalString(row, "run_status")),
    runDryRun: readBoolean(row, "run_dry_run"),
  }));
}
