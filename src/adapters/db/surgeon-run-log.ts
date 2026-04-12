import { randomUUID } from "node:crypto";

import type { Row } from "@libsql/client";

import type { SurgeonRunAction } from "../../core/surgeon/domain/action-types.js";
import { isSurgeonPassType, type SurgeonPassType } from "../../core/surgeon/domain/pass-types.js";
import type { SurgeonCompletionSummary, SurgeonProposalReviewStatus, SurgeonRunProposal, SurgeonRunStatus } from "../../core/surgeon/types.js";
import { readBoolean, readNumber, readOptionalString, readRequiredString } from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";

const SURGEON_RUN_STATUSES = ["running", "completed", "failed", "aborted", "budget_exhausted", "cost_capped", "no_work", "stalled"] as const;
const SURGEON_PROPOSAL_REVIEW_STATUSES = ["open", "applied", "rejected"] as const;

/**
 * Persisted surgeon run metadata row.
 */
export interface SurgeonRun {
  id: string;
  passType: SurgeonPassType;
  project: string | null;
  startedAt: string;
  completedAt: string | null;
  status: SurgeonRunStatus;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  model: string | null;
  actionsTaken: number;
  actionsSkipped: number;
  entriesRetired: number;
  summaryJson: SurgeonCompletionSummary | null;
  error: string | null;
  dryRun: boolean;
  config: Record<string, unknown> | null;
}

/**
 * Joined backlog row that pairs one proposal with its originating run metadata.
 */
export interface SurgeonProposalBacklogRow {
  proposal: SurgeonRunProposal;
  runPassType: SurgeonPassType;
  runStartedAt: string;
  runStatus: SurgeonRunStatus;
  runDryRun: boolean;
}

/**
 * Proposal payload accepted by persistence helpers, with review metadata
 * defaulting to the open state when omitted by older call sites.
 */
type PersistedSurgeonProposalInput = SurgeonRunProposal | Omit<SurgeonRunProposal, "reviewStatus" | "reviewedAt" | "reviewReason" | "appliedActionCount">;

/**
 * Inserts a new surgeon run row and returns the generated run ID.
 *
 * @param executor - SQL executor used for the insert.
 * @param run - Initial run metadata.
 * @returns Persisted surgeon run identifier.
 */
export async function createSurgeonRun(
  executor: SqlExecutor,
  run: {
    passType: SurgeonPassType;
    project?: string;
    model?: string | null;
    dryRun: boolean;
    config?: Record<string, unknown> | null;
    startedAt?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const startedAt = normalizeTimestamp(run.startedAt) ?? new Date().toISOString();

  await executor.execute({
    sql: `
      INSERT INTO surgeon_runs (
        id,
        pass_type,
        project,
        started_at,
        status,
        model,
        dry_run,
        config_json
      )
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
    `,
    args: [
      id,
      run.passType,
      normalizeOptionalString(run.project),
      startedAt,
      normalizeOptionalString(run.model ?? undefined),
      run.dryRun ? 1 : 0,
      JSON.stringify(run.config ?? null),
    ],
  });

  return id;
}

/**
 * Finalizes a surgeon run with the completed run summary.
 *
 * @param executor - SQL executor used for the update.
 * @param runId - Existing run identifier.
 * @param result - Final run outcome and metrics.
 */
export async function completeSurgeonRun(
  executor: SqlExecutor,
  runId: string,
  result: {
    status: SurgeonRunStatus;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    actionsTaken: number;
    actionsSkipped: number;
    entriesRetired: number;
    summaryJson?: SurgeonCompletionSummary | null;
    error?: string | null;
    completedAt?: string;
  },
): Promise<void> {
  await executor.execute({
    sql: `
      UPDATE surgeon_runs
      SET completed_at = ?,
          status = ?,
          input_tokens = ?,
          output_tokens = ?,
          estimated_cost_usd = ?,
          actions_taken = ?,
          actions_skipped = ?,
          entries_retired = ?,
          summary_json = ?,
          error = ?
      WHERE id = ?
    `,
    args: [
      normalizeTimestamp(result.completedAt) ?? new Date().toISOString(),
      result.status,
      normalizeInteger(result.inputTokens),
      normalizeInteger(result.outputTokens),
      normalizeNumber(result.estimatedCostUsd),
      normalizeInteger(result.actionsTaken),
      normalizeInteger(result.actionsSkipped),
      normalizeInteger(result.entriesRetired),
      JSON.stringify(result.summaryJson ?? null),
      normalizeOptionalString(result.error ?? undefined),
      runId.trim(),
    ],
  });
}

/**
 * Inserts one surgeon action audit row.
 *
 * @param executor - SQL executor used for the insert.
 * @param action - Action payload to persist.
 */
export async function logSurgeonAction(executor: SqlExecutor, action: SurgeonRunAction): Promise<void> {
  const entryIds = normalizeEntryIds(action.entryIds);

  await executor.execute({
    sql: `
      INSERT INTO surgeon_run_actions (
        id,
        run_id,
        action_type,
        entry_id,
        entry_ids,
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
      entryIds[0] ?? null,
      JSON.stringify(entryIds),
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
export async function logSurgeonProposal(executor: SqlExecutor, proposal: PersistedSurgeonProposalInput): Promise<void> {
  const reviewStatus = "reviewStatus" in proposal ? proposal.reviewStatus : "open";
  const reviewedAt = "reviewedAt" in proposal ? proposal.reviewedAt : null;
  const reviewReason = "reviewReason" in proposal ? proposal.reviewReason : null;
  const appliedActionCount = "appliedActionCount" in proposal ? proposal.appliedActionCount : 0;

  await executor.execute({
    sql: `
      INSERT INTO surgeon_run_proposals (
        id,
        run_id,
        group_id,
        issue_kind,
        scope,
        entry_ids,
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
      proposal.groupId.trim(),
      proposal.issueKind,
      proposal.scope,
      JSON.stringify(normalizeEntryIds(proposal.entryIds)),
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

/**
 * Loads recent surgeon runs ordered from newest to oldest.
 *
 * @param executor - SQL executor used for the lookup.
 * @param limit - Maximum number of runs to return.
 * @returns Recent surgeon runs.
 */
export async function getSurgeonRunHistory(executor: SqlExecutor, limit = 10): Promise<SurgeonRun[]> {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  const result = await executor.execute({
    sql: `
      SELECT
        id,
        pass_type,
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
        entries_retired,
        summary_json,
        error,
        dry_run,
        config_json
      FROM surgeon_runs
      ORDER BY started_at DESC
      LIMIT ?
    `,
    args: [safeLimit],
  });

  return result.rows.map((row) => mapRunRow(row));
}

/**
 * Loads the most recent surgeon run when one exists.
 *
 * @param executor - SQL executor used for the lookup.
 * @returns Latest surgeon run, or null when absent.
 */
export async function getLastSurgeonRun(executor: SqlExecutor): Promise<SurgeonRun | null> {
  const [run] = await getSurgeonRunHistory(executor, 1);
  return run ?? null;
}

/**
 * Loads the persisted action audit trail for one run.
 *
 * @param executor - SQL executor used for the lookup.
 * @param runId - Run identifier to inspect.
 * @returns Ordered action list for the run.
 */
export async function getSurgeonRunActions(executor: SqlExecutor, runId: string): Promise<SurgeonRunAction[]> {
  const result = await executor.execute({
    sql: `
      SELECT
        id,
        run_id,
        action_type,
        entry_ids,
        reasoning,
        recall_delta,
        details_json,
        created_at
      FROM surgeon_run_actions
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
export async function getSurgeonRunProposals(executor: SqlExecutor, runId: string): Promise<SurgeonRunProposal[]> {
  const result = await executor.execute({
    sql: `
      SELECT
        id,
        run_id,
        group_id,
        issue_kind,
        scope,
        entry_ids,
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
      FROM surgeon_run_proposals
      WHERE run_id = ?
      ORDER BY created_at ASC
    `,
    args: [runId.trim()],
  });

  return result.rows.map((row) => mapProposalRow(row));
}

/**
 * Loads one persisted proposal by ID.
 *
 * @param executor - SQL executor used for the lookup.
 * @param proposalId - Proposal identifier to inspect.
 * @returns Matching proposal payload, or null when absent.
 */
export async function getSurgeonProposal(executor: SqlExecutor, proposalId: string): Promise<SurgeonRunProposal | null> {
  const result = await executor.execute({
    sql: `
      SELECT
        id,
        run_id,
        group_id,
        issue_kind,
        scope,
        entry_ids,
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
      FROM surgeon_run_proposals
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
export async function listSurgeonProposalBacklog(
  executor: SqlExecutor,
  query: {
    state?: SurgeonProposalReviewStatus | "all";
    issueKind?: string;
    eligibleOnly?: boolean;
    entryId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<SurgeonProposalBacklogRow[]> {
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
  if (query.entryId) {
    clauses.push("EXISTS (SELECT 1 FROM json_each(p.entry_ids) AS je WHERE je.value = ?)");
    args.push(query.entryId.trim());
  }

  const limit = Number.isFinite(query.limit) && (query.limit ?? 0) > 0 ? Math.floor(query.limit!) : 25;
  const offset = Number.isFinite(query.offset) && (query.offset ?? 0) >= 0 ? Math.floor(query.offset!) : 0;
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await executor.execute({
    sql: `
      SELECT
        p.id,
        p.run_id,
        p.group_id,
        p.issue_kind,
        p.scope,
        p.entry_ids,
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
        p.created_at,
        r.pass_type AS run_pass_type,
        r.started_at AS run_started_at,
        r.status AS run_status,
        r.dry_run AS run_dry_run
      FROM surgeon_run_proposals AS p
      JOIN surgeon_runs AS r ON r.id = p.run_id
      ${whereClause}
      ORDER BY
        CASE WHEN p.review_status = 'open' THEN 0 ELSE 1 END ASC,
        CASE WHEN p.review_status = 'open' THEN p.created_at END ASC,
        CASE WHEN p.review_status <> 'open' THEN p.reviewed_at END DESC,
        p.created_at DESC
      LIMIT ?
      OFFSET ?
    `,
    args: [...args, limit, offset],
  });

  return result.rows.map((row) => ({
    proposal: mapProposalRow(row),
    runPassType: parseStoredSurgeonPassType(readOptionalString(row, "run_pass_type")),
    runStartedAt: readRequiredString(row, "run_started_at"),
    runStatus: parseStoredSurgeonRunStatus(readOptionalString(row, "run_status")),
    runDryRun: readBoolean(row, "run_dry_run"),
  }));
}

/**
 * Persists one operator review decision for an existing proposal.
 *
 * @param executor - SQL executor used for the update.
 * @param input - Review outcome plus audit metadata.
 * @returns `true` when the proposal row was updated.
 */
export async function reviewSurgeonProposal(
  executor: SqlExecutor,
  input: {
    proposalId: string;
    status: Exclude<SurgeonProposalReviewStatus, "open">;
    reason: string;
    reviewedAt?: string;
    appliedActionCount?: number;
  },
): Promise<boolean> {
  const result = await executor.execute({
    sql: `
      UPDATE surgeon_run_proposals
      SET review_status = ?,
          reviewed_at = ?,
          review_reason = ?,
          applied_action_count = ?
      WHERE id = ?
        AND review_status = 'open'
    `,
    args: [
      input.status,
      normalizeTimestamp(input.reviewedAt) ?? new Date().toISOString(),
      input.reason.trim(),
      normalizeInteger(input.appliedActionCount ?? 0),
      input.proposalId.trim(),
    ],
  });

  return result.rowsAffected > 0;
}

/**
 * Sums surgeon run cost across the trailing 24-hour window.
 *
 * @param executor - SQL executor used for the lookup.
 * @param now - Reference time for the trailing window.
 * @returns Total estimated surgeon spend in USD.
 */
export async function getDailySurgeonCost(executor: SqlExecutor, now = new Date()): Promise<number> {
  const sinceIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const result = await executor.execute({
    sql: `
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
      FROM surgeon_runs
      WHERE started_at >= ?
    `,
    args: [sinceIso],
  });

  const row = result.rows[0];
  return row ? readNumber(row, "total_cost", 0) : 0;
}

/**
 * Maps a raw surgeon run row into the typed run DTO.
 *
 * @param row - Raw database row.
 * @returns Hydrated surgeon run.
 */
function mapRunRow(row: Row): SurgeonRun {
  const passType = parseStoredSurgeonPassType(readOptionalString(row, "pass_type"));
  const status = parseStoredSurgeonRunStatus(readOptionalString(row, "status"));

  return {
    id: readRequiredString(row, "id"),
    passType,
    project: readOptionalString(row, "project") ?? null,
    startedAt: readRequiredString(row, "started_at"),
    completedAt: readOptionalString(row, "completed_at") ?? null,
    status,
    inputTokens: readNumber(row, "input_tokens", 0),
    outputTokens: readNumber(row, "output_tokens", 0),
    estimatedCostUsd: readNumber(row, "estimated_cost_usd", 0),
    model: readOptionalString(row, "model") ?? null,
    actionsTaken: readNumber(row, "actions_taken", 0),
    actionsSkipped: readNumber(row, "actions_skipped", 0),
    entriesRetired: readNumber(row, "entries_retired", 0),
    summaryJson: parseJsonValue<SurgeonCompletionSummary | null>(readOptionalString(row, "summary_json"), null),
    error: readOptionalString(row, "error") ?? null,
    dryRun: readBoolean(row, "dry_run"),
    config: parseJsonRecord(readOptionalString(row, "config_json")),
  };
}

/**
 * Maps a raw surgeon action row into the typed action DTO.
 *
 * @param row - Raw database row.
 * @returns Hydrated surgeon run action.
 */
function mapActionRow(row: Row): SurgeonRunAction {
  return {
    id: readRequiredString(row, "id"),
    runId: readRequiredString(row, "run_id"),
    actionType: readRequiredString(row, "action_type") as SurgeonRunAction["actionType"],
    entryIds: parseJsonStringArray(readOptionalString(row, "entry_ids")),
    reasoning: readRequiredString(row, "reasoning"),
    recallDelta: parseJsonValue<SurgeonRunAction["recallDelta"]>(readOptionalString(row, "recall_delta"), null),
    details: parseJsonRecord(readOptionalString(row, "details_json")),
    createdAt: readRequiredString(row, "created_at"),
  };
}

/**
 * Maps a raw surgeon proposal row into the typed proposal DTO.
 *
 * @param row - Raw database row.
 * @returns Hydrated surgeon run proposal.
 */
function mapProposalRow(row: Row): SurgeonRunProposal {
  return {
    id: readRequiredString(row, "id"),
    runId: readRequiredString(row, "run_id"),
    groupId: readRequiredString(row, "group_id"),
    issueKind: readRequiredString(row, "issue_kind"),
    scope: readRequiredString(row, "scope") as SurgeonRunProposal["scope"],
    entryIds: parseJsonStringArray(readOptionalString(row, "entry_ids")),
    currentClaimKeys: parseJsonStringArray(readOptionalString(row, "current_claim_keys")),
    proposedClaimKeys: parseJsonStringArray(readOptionalString(row, "proposed_claim_keys")),
    rationale: readRequiredString(row, "rationale"),
    confidence: readNumber(row, "confidence", 0),
    source: readRequiredString(row, "source"),
    eligibleForApply: readBoolean(row, "eligible_for_apply"),
    createdAt: readRequiredString(row, "created_at"),
    reviewStatus: parseStoredSurgeonProposalReviewStatus(readOptionalString(row, "review_status")),
    reviewedAt: readOptionalString(row, "reviewed_at") ?? null,
    reviewReason: readOptionalString(row, "review_reason") ?? null,
    appliedActionCount: readNumber(row, "applied_action_count", 0),
  };
}

/**
 * Parses JSON text with a typed fallback.
 *
 * @param raw - JSON payload from storage.
 * @param fallback - Fallback returned when parsing fails.
 * @returns Parsed value or the fallback.
 */
function parseJsonValue<T>(raw: string | undefined, fallback: T): T {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return (parsed as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Parses a stored JSON object into a plain record when possible.
 *
 * @param raw - JSON object payload from storage.
 * @returns Parsed record or null when absent or invalid.
 */
function parseJsonRecord(raw: string | undefined): Record<string, unknown> | null {
  const parsed = parseJsonValue<unknown>(raw, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return parsed as Record<string, unknown>;
}

/**
 * Parses a stored JSON array and keeps only string members.
 *
 * @param raw - JSON array payload from storage.
 * @returns Filtered string array, or an empty array when invalid.
 */
function parseJsonStringArray(raw: string | undefined): string[] {
  const parsed = parseJsonValue<unknown>(raw, []);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((value): value is string => typeof value === "string");
}

/**
 * Parses one persisted surgeon pass identifier with a safe legacy fallback.
 *
 * @param value - Raw stored pass type.
 * @returns Valid surgeon pass type.
 */
function parseStoredSurgeonPassType(value: string | undefined): SurgeonPassType {
  if (value === undefined) {
    return "retirement";
  }

  if (isSurgeonPassType(value)) {
    return value;
  }

  throw new Error(`Invalid surgeon pass type ${JSON.stringify(value)} in surgeon_runs.pass_type.`);
}

/**
 * Parses one persisted surgeon status code with a safe legacy fallback.
 *
 * @param value - Raw stored status string.
 * @returns Valid surgeon run status.
 */
function parseStoredSurgeonRunStatus(value: string | undefined): SurgeonRunStatus {
  if (value === undefined) {
    return "running";
  }

  if ((SURGEON_RUN_STATUSES as readonly string[]).includes(value)) {
    return value as SurgeonRunStatus;
  }

  throw new Error(`Invalid surgeon run status ${JSON.stringify(value)} in surgeon_runs.status.`);
}

/**
 * Parses one persisted proposal review state with a safe legacy fallback.
 *
 * @param value - Raw stored review-status string.
 * @returns Valid proposal review status.
 */
function parseStoredSurgeonProposalReviewStatus(value: string | undefined): SurgeonProposalReviewStatus {
  if (value === undefined) {
    return "open";
  }

  if ((SURGEON_PROPOSAL_REVIEW_STATUSES as readonly string[]).includes(value)) {
    return value as SurgeonProposalReviewStatus;
  }

  throw new Error(`Invalid surgeon proposal review status ${JSON.stringify(value)} in surgeon_run_proposals.review_status.`);
}

/**
 * Trims, removes blanks, and deduplicates action entry IDs.
 *
 * @param entryIds - Raw action entry identifiers.
 * @returns Stable list of non-empty unique IDs.
 */
function normalizeEntryIds(entryIds: string[]): string[] {
  return Array.from(new Set(entryIds.map((entryId) => entryId.trim()).filter((entryId) => entryId.length > 0)));
}

/**
 * Trims, removes blanks, and deduplicates generic string-array payloads.
 *
 * @param values - Raw string payload.
 * @returns Stable list of non-empty unique strings.
 */
function normalizeStringArray(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

/**
 * Normalizes optional strings into nullable trimmed values.
 *
 * @param value - Raw optional string.
 * @returns Trimmed string or null.
 */
function normalizeOptionalString(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalizes optional timestamps into nullable trimmed values.
 *
 * @param value - Raw optional timestamp.
 * @returns Trimmed timestamp or null.
 */
function normalizeTimestamp(value: string | undefined): string | null {
  return normalizeOptionalString(value);
}

/**
 * Normalizes numeric counters into non-negative integers.
 *
 * @param value - Raw numeric value.
 * @returns Safe non-negative integer.
 */
function normalizeInteger(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

/**
 * Normalizes numeric totals into finite non-negative numbers.
 *
 * @param value - Raw numeric value.
 * @returns Safe non-negative number.
 */
function normalizeNumber(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, value);
}
