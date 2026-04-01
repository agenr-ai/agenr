import type { SurgeonRunAction } from "../../core/surgeon/domain/action-types.js";
import type { SurgeonPassType } from "../../core/surgeon/domain/pass-types.js";
import type { SurgeonCompletionSummary, SurgeonRunStatus } from "../../core/surgeon/types.js";
import type { Entry } from "../../core/types.js";

/**
 * Persisted surgeon run metadata returned by history and status queries.
 */
export interface SurgeonRunRecord {
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
 * Aggregate corpus health summary used by surgeon startup and status tools.
 */
export interface SurgeonHealthStats {
  total: number;
  byType: Record<string, number>;
  recency: {
    last7: number;
    last30: number;
    d30To90: number;
    d90Plus: number;
  };
  recall: {
    never: number;
    oneToFive: number;
    fivePlus: number;
  };
  quality: {
    high: number;
    medium: number;
    low: number;
    average: number;
  };
  retirementCandidateCount: number;
  recentlyEvaluatedCount: number;
}

/**
 * Query options for listing retirement candidates.
 */
export interface SurgeonCandidateQuery {
  scope?: "actionable" | "all";
  type?: string;
  importanceMax?: number;
  minAgeDays?: number;
  limit?: number;
  offset?: number;
  protectRecalledDays: number;
  protectMinImportance: number;
  skipRecentlyEvaluatedDays?: number;
  runId?: string;
  project?: string;
  now?: Date;
}

/**
 * Lightweight candidate summary returned to the surgeon candidate tool.
 */
export interface SurgeonCandidateSummary {
  id: string;
  subject: string;
  type: string;
  importance: number;
  qualityScore: number;
  expiry: string;
  createdAt: string;
  updatedAt: string;
  recallCount: number;
  lastRecalledAt: string | null;
  tags: string[];
}

/**
 * Query options for listing supersession candidate clusters.
 */
export interface SurgeonSupersessionCandidateQuery {
  scope: "claim_key" | "subject" | "all";
  type?: string;
  limit?: number;
  offset?: number;
}

/**
 * One entry returned inside a supersession candidate cluster.
 */
export interface SurgeonSupersessionClusterEntry {
  id: string;
  subject: string;
  type: string;
  importance: number;
  expiry: string;
  createdAt: string;
  content: string;
  claimKey: string | null;
  tags: string[];
}

/**
 * Group of active entries that may represent the same knowledge slot.
 */
export interface SurgeonSupersessionCluster {
  groupKey: string;
  groupedBy: "claim_key" | "subject";
  entries: SurgeonSupersessionClusterEntry[];
}

/**
 * Minimal entry summary used in surgeon inspection responses.
 */
export interface SurgeonEntrySummary {
  id: string;
  subject: string;
  type: string;
  importance: number;
  expiry: string;
  createdAt: string;
  retired: boolean;
}

/**
 * Detailed surgeon inspection payload for one entry.
 */
export interface SurgeonEntryInspection {
  entry: Entry;
  tags: string[];
  related: {
    sameSubject: SurgeonEntrySummary[];
    sameCluster: SurgeonEntrySummary[];
    supersedesCount: number;
    supersedesSample: SurgeonEntrySummary[];
  };
}

/**
 * Single persistence boundary for surgeon workflows and status surfaces.
 */
export interface SurgeonPort {
  /**
   * Sums persisted run cost across the trailing 24-hour window.
   *
   * @param now - Reference time for the trailing window.
   * @returns Total estimated surgeon spend in USD.
   */
  getDailyCost(now?: Date): Promise<number>;

  /**
   * Creates a new persisted surgeon run.
   *
   * @param run - Initial run metadata.
   * @returns Generated run identifier.
   */
  createRun(run: {
    passType: SurgeonPassType;
    project?: string;
    model?: string | null;
    dryRun: boolean;
    config?: Record<string, unknown> | null;
    startedAt?: string;
  }): Promise<string>;

  /**
   * Finalizes one persisted surgeon run.
   *
   * @param runId - Existing run identifier.
   * @param result - Final run outcome and metrics.
   * @returns Promise that resolves after the update is persisted.
   */
  completeRun(
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
  ): Promise<void>;

  /**
   * Persists one surgeon action audit row.
   *
   * @param action - Action payload to persist.
   * @returns Promise that resolves after the action is stored.
   */
  logRunAction(action: SurgeonRunAction): Promise<void>;

  /**
   * Loads the most recent persisted surgeon run.
   *
   * @returns Latest run, or `null` when none exist.
   */
  getLastRun(): Promise<SurgeonRunRecord | null>;

  /**
   * Loads recent persisted surgeon runs.
   *
   * @param limit - Maximum number of rows to return.
   * @returns Recent runs ordered newest first.
   */
  getRunHistory(limit?: number): Promise<SurgeonRunRecord[]>;

  /**
   * Loads the action audit trail for one run.
   *
   * @param runId - Run identifier to inspect.
   * @returns Ordered surgeon actions for the run.
   */
  getRunActions(runId: string): Promise<SurgeonRunAction[]>;

  /**
   * Loads aggregate corpus health stats for the current protection settings.
   *
   * @param options - Retirement protection configuration and optional clock.
   * @returns Aggregate health summary for the active corpus.
   */
  getHealthStats(options: {
    protectRecalledDays: number;
    protectMinImportance: number;
    skipRecentlyEvaluatedDays?: number;
    now?: Date;
  }): Promise<SurgeonHealthStats>;

  /**
   * Counts actionable retirement candidates.
   *
   * @param options - Retirement protection configuration and optional clock.
   * @returns Candidate totals with the recent-evaluation subset.
   */
  countRetirementCandidates(options: {
    protectRecalledDays: number;
    protectMinImportance: number;
    skipRecentlyEvaluatedDays?: number;
    now?: Date;
  }): Promise<{ total: number; recentlyEvaluated: number }>;

  /**
   * Lists retirement candidates for the requested scope and filters.
   *
   * @param query - Candidate filtering and pagination options.
   * @returns Prioritized candidate summaries.
   */
  listRetirementCandidates(query: SurgeonCandidateQuery): Promise<SurgeonCandidateSummary[]>;

  /**
   * Lists supersession candidate clusters using the requested grouping strategy.
   *
   * Scope controls grouping behavior:
   * - `claim_key` groups entries sharing the same non-null claim key
   * - `subject` groups entries sharing the same normalized subject and type
   * - `all` returns both group families
   *
   * Only groups with two or more active entries are returned.
   *
   * @param query - Cluster grouping, filtering, and pagination options.
   * @returns Candidate clusters ordered oldest-first within each cluster.
   */
  listSupersessionCandidates(query: SurgeonSupersessionCandidateQuery): Promise<SurgeonSupersessionCluster[]>;

  /**
   * Loads detailed inspection context for one entry.
   *
   * @param entryId - Canonical entry identifier.
   * @returns Detailed inspection payload, or `null` when missing.
   */
  inspectEntry(entryId: string): Promise<SurgeonEntryInspection | null>;

  /**
   * Loads a single active entry by ID.
   *
   * @param entryId - Entry identifier to resolve.
   * @returns Active entry, or `null` when missing.
   */
  getEntry(entryId: string): Promise<Entry | null>;

  /**
   * Retires one active entry.
   *
   * @param entryId - Entry identifier to retire.
   * @param reason - Optional retirement reason.
   * @returns `true` when the entry was retired.
   */
  retireEntry(entryId: string, reason?: string): Promise<boolean>;

  /**
   * Links one active entry to the newer entry that supersedes it.
   *
   * @param oldEntryId - Historical entry being superseded.
   * @param newEntryId - Active entry that replaces the old entry.
   * @param kind - Optional explicit supersession kind.
   * @param reason - Optional explanation recorded on the old entry.
   * @returns `true` when the supersession link was persisted.
   */
  supersedeEntry(oldEntryId: string, newEntryId: string, kind?: string, reason?: string): Promise<boolean>;

  /**
   * Updates one active entry's mutable fields.
   *
   * @param entryId - Entry identifier to update.
   * @param fields - Mutable fields to change.
   * @returns `true` when the entry was updated.
   */
  updateEntry(
    entryId: string,
    fields: {
      importance?: number;
      expiry?: string;
      claim_key?: string;
      valid_from?: string;
      valid_to?: string;
    },
  ): Promise<boolean>;

  /**
   * Loads the timestamp of the last bulk ingest, when present.
   *
   * @returns ISO timestamp, or `null` when absent.
   */
  getLastBulkIngestAt(): Promise<string | null>;
}
