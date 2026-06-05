import type { Row } from "@libsql/client";

import type { DreamRunAction } from "../../core/dreaming/domain/action-types.js";
import { isDreamTier, type DreamTier } from "../../core/dreaming/domain/pass-types.js";
import type { DreamCompletionSummary, DreamProposalReviewStatus, DreamRunProposal, DreamRunStatus } from "../../core/dreaming/types.js";
import { readBoolean, readNumber, readOptionalString, readRequiredString } from "./row-mapping.js";

export const DREAM_RUN_STATUSES = ["running", "completed", "failed", "aborted", "budget_exhausted", "cost_capped", "no_work", "stalled"] as const;
export const DREAM_PROPOSAL_REVIEW_STATUSES = ["open", "applied", "rejected"] as const;

/**
 * Persisted dreaming run metadata row.
 */
export interface DreamRun {
  id: string;
  tier: DreamTier;
  project: string | null;
  startedAt: string;
  completedAt: string | null;
  status: DreamRunStatus;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  model: string | null;
  actionsTaken: number;
  actionsSkipped: number;
  durablesRetired: number;
  summaryJson: DreamCompletionSummary | null;
  error: string | null;
  dryRun: boolean;
  config: Record<string, unknown> | null;
}

/**
 * Joined backlog row that pairs one proposal with its originating run metadata.
 */
export interface DreamProposalBacklogRow {
  proposal: DreamRunProposal;
  runPassType: DreamTier;
  runStartedAt: string;
  runStatus: DreamRunStatus;
  runDryRun: boolean;
}

/**
 * Proposal payload accepted by persistence helpers, with review metadata
 * defaulting to the open state when omitted by older call sites.
 */
export type PersistedDreamProposalInput = DreamRunProposal | Omit<DreamRunProposal, "reviewStatus" | "reviewedAt" | "reviewReason" | "appliedActionCount">;

/**
 * Maps a raw dreaming run row into the typed run DTO.
 *
 * @param row - Raw database row.
 * @returns Hydrated dreaming run.
 */
export function mapRunRow(row: Row): DreamRun {
  const tier = parseStoredDreamTier(readOptionalString(row, "tier"));
  const status = parseStoredDreamRunStatus(readOptionalString(row, "status"));

  return {
    id: readRequiredString(row, "id"),
    tier,
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
    durablesRetired: readNumber(row, "durables_retired", 0),
    summaryJson: parseJsonValue<DreamCompletionSummary | null>(readOptionalString(row, "summary_json"), null),
    error: readOptionalString(row, "error") ?? null,
    dryRun: readBoolean(row, "dry_run"),
    config: parseJsonRecord(readOptionalString(row, "config_json")),
  };
}

/**
 * Maps a raw dreaming action row into the typed action DTO.
 *
 * @param row - Raw database row.
 * @returns Hydrated dreaming run action.
 */
export function mapActionRow(row: Row): DreamRunAction {
  return {
    id: readRequiredString(row, "id"),
    runId: readRequiredString(row, "run_id"),
    actionType: readRequiredString(row, "action_type") as DreamRunAction["actionType"],
    durableIds: parseJsonStringArray(readOptionalString(row, "durable_ids")),
    reasoning: readRequiredString(row, "reasoning"),
    recallDelta: parseJsonValue<DreamRunAction["recallDelta"]>(readOptionalString(row, "recall_delta"), null),
    details: parseJsonRecord(readOptionalString(row, "details_json")),
    createdAt: readRequiredString(row, "created_at"),
  };
}

/**
 * Maps a raw dreaming proposal row into the typed proposal DTO.
 *
 * @param row - Raw database row.
 * @returns Hydrated dreaming run proposal.
 */
export function mapProposalRow(row: Row): DreamRunProposal {
  return {
    id: readRequiredString(row, "id"),
    runId: readRequiredString(row, "run_id"),
    groupId: readRequiredString(row, "group_id"),
    issueKind: readRequiredString(row, "issue_kind"),
    scope: readRequiredString(row, "scope") as DreamRunProposal["scope"],
    durableIds: parseJsonStringArray(readOptionalString(row, "durable_ids")),
    currentClaimKeys: parseJsonStringArray(readOptionalString(row, "current_claim_keys")),
    proposedClaimKeys: parseJsonStringArray(readOptionalString(row, "proposed_claim_keys")),
    rationale: readRequiredString(row, "rationale"),
    confidence: readNumber(row, "confidence", 0),
    source: readRequiredString(row, "source"),
    eligibleForApply: readBoolean(row, "eligible_for_apply"),
    createdAt: readRequiredString(row, "created_at"),
    reviewStatus: parseStoredDreamProposalReviewStatus(readOptionalString(row, "review_status")),
    reviewedAt: readOptionalString(row, "reviewed_at") ?? null,
    reviewReason: readOptionalString(row, "review_reason") ?? null,
    appliedActionCount: readNumber(row, "applied_action_count", 0),
  };
}

export function parseStoredDreamTier(value: string | undefined): DreamTier {
  if (value === undefined) {
    return "standard";
  }

  if (isDreamTier(value)) {
    return value;
  }

  throw new Error(`Invalid dreaming pass type ${JSON.stringify(value)} in dream_runs.tier.`);
}

export function parseStoredDreamRunStatus(value: string | undefined): DreamRunStatus {
  if (value === undefined) {
    return "running";
  }

  if ((DREAM_RUN_STATUSES as readonly string[]).includes(value)) {
    return value as DreamRunStatus;
  }

  throw new Error(`Invalid dreaming run status ${JSON.stringify(value)} in dream_runs.status.`);
}

export function parseStoredDreamProposalReviewStatus(value: string | undefined): DreamProposalReviewStatus {
  if (value === undefined) {
    return "open";
  }

  if ((DREAM_PROPOSAL_REVIEW_STATUSES as readonly string[]).includes(value)) {
    return value as DreamProposalReviewStatus;
  }

  throw new Error(`Invalid dreaming proposal review status ${JSON.stringify(value)} in dream_proposals.review_status.`);
}

export function normalizeDurableIds(durableIds: string[]): string[] {
  return Array.from(new Set(durableIds.map((durableId) => durableId.trim()).filter((durableId) => durableId.length > 0)));
}

export function normalizeStringArray(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

export function normalizeOptionalString(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeTimestamp(value: string | undefined): string | null {
  return normalizeOptionalString(value);
}

export function normalizeInteger(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

export function normalizeNumber(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, value);
}

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

function parseJsonRecord(raw: string | undefined): Record<string, unknown> | null {
  const parsed = parseJsonValue<unknown>(raw, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return parsed as Record<string, unknown>;
}

export function parseJsonStringArray(raw: string | undefined): string[] {
  const parsed = parseJsonValue<unknown>(raw, []);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((value): value is string => typeof value === "string");
}
