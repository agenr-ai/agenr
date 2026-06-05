import type { DreamRunAction } from "../../core/dreaming/domain/action-types.js";
import type { DreamTier } from "../../core/dreaming/types.js";
import type { DreamCompletionSummary, DreamProposalReviewStatus, DreamRunProposal, DreamRunStatus } from "../../core/dreaming/types.js";
import type { Durable, DurableUpdateInput } from "../../core/types.js";

/**
 * Persisted dreaming run metadata returned by history and status queries.
 */
export interface DreamRunRecord {
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
 * Aggregate corpus health summary used by dreaming status tools.
 */
export interface DreamHealthStats {
  total: number;
  byType: Record<string, number>;
  claimKeyLifecycle: {
    trusted: number;
    tentative: number;
    unresolved: number;
    /** Legacy rows with a canonical claim key but no lifecycle status yet. */
    legacy: number;
    noKey: number;
  };
  /** Count of durable unresolved dreaming proposals awaiting review. */
  proposalBacklogCount: number;
  /** Open proposals that are already safe to apply. */
  eligibleProposalBacklogCount: number;
  /** Oldest still-open proposal creation timestamp, when one exists. */
  oldestOpenProposalCreatedAt: string | null;
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
}

/**
 * Query options for the global proposal backlog view.
 */
export interface DreamProposalBacklogQuery {
  state?: DreamProposalReviewStatus | "all";
  issueKind?: string;
  eligibleOnly?: boolean;
  durableId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Global backlog row that joins one proposal to its originating run metadata.
 */
export interface DreamProposalBacklogItem {
  proposal: DreamRunProposal;
  runPassType: DreamTier;
  runStartedAt: string;
  runStatus: DreamRunStatus;
  runDryRun: boolean;
}

/**
 * Milestone 1 dreaming persistence boundary.
 */
export interface DreamPort {
  getDailyCost(now?: Date): Promise<number>;
  createRun(run: {
    tier: DreamTier;
    project?: string;
    model?: string | null;
    dryRun: boolean;
    config?: Record<string, unknown> | null;
    startedAt?: string;
  }): Promise<string>;
  completeRun(
    runId: string,
    result: {
      status: DreamRunStatus;
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
      actionsTaken: number;
      actionsSkipped: number;
      durablesRetired: number;
      summaryJson?: DreamCompletionSummary | null;
      error?: string | null;
      completedAt?: string;
    },
  ): Promise<void>;
  logRunAction(action: DreamRunAction): Promise<void>;
  getLastRun(): Promise<DreamRunRecord | null>;
  getRunHistory(limit?: number): Promise<DreamRunRecord[]>;
  getRunActions(runId: string): Promise<DreamRunAction[]>;
  getRunProposals(runId: string): Promise<DreamRunProposal[]>;
  listProposalBacklog(query?: DreamProposalBacklogQuery): Promise<DreamProposalBacklogItem[]>;
  getHealthStats(now?: Date): Promise<DreamHealthStats>;
  updateDurable(
    durableId: string,
    fields: DurableUpdateInput,
    options?: {
      includeInactive?: boolean;
    },
  ): Promise<boolean>;
  listReconcileDurables(query: {
    project?: string;
    type?: string;
    claimKeyPrefix?: string;
    durableIds?: string[];
    includeInactive?: boolean;
  }): Promise<Durable[]>;
  logRunProposal(proposal: DreamRunProposal): Promise<void>;
  countEpisodesSince(since: string, project?: string): Promise<number>;
  countIngestFilesSince(since: string): Promise<number>;
  countDurablesCreatedSince(since: string, project?: string): Promise<number>;
  updateDreamState(input: { lastSuccessfulRunAt?: string; unsynthesizedImportanceSum?: number; updatedAt: string }): Promise<void>;
}
