/** Shared JSON-serializable types for the operator console API. */

import type { DreamProgressEvent } from "../app/dreaming/progress.js";
import type {
  ProcedureSyncExecutionItem,
  ProcedureSyncExecutionResult as AppProcedureSyncExecutionResult,
  ProcedureSyncExecutionTotals,
  ProcedureSyncPlan as AppProcedureSyncPlan,
  ProcedureSyncPlanItem,
  ProcedureSyncPlanTotals,
} from "../app/procedures/sync/types.js";
import type { ProcedureStep } from "../core/types.js";

/** Supported durable kinds accepted by store and supersede endpoints. */
export type DurableKind = "fact" | "decision" | "preference" | "lesson" | "relationship" | "milestone" | "directive";

/** Supported expiry tiers accepted by store and metadata endpoints. */
export type Expiry = "core" | "permanent" | "temporary";

/** Request body for storing or superseding a durable. */
export interface StoreDurableBody {
  type: DurableKind;
  subject: string;
  content: string;
  importance?: number;
  expiry?: Expiry;
  tags?: string[];
  project?: string;
  claimKey?: string;
  validFrom?: string;
  validTo?: string;
}

/** Request body for metadata-only durable updates. */
export interface UpdateDurableMetadataBody {
  importance?: number;
  expiry?: Expiry;
  claimKey?: string;
  validFrom?: string;
  validTo?: string;
  project?: string;
}

/** Request body for metadata-only episode updates. */
export interface UpdateEpisodeMetadataBody {
  sourceRef?: string;
  surface?: string;
  userId?: string;
  project?: string;
  activityLevel?: "substantial" | "minimal" | "none" | "";
  tags?: string[];
  validFrom?: string;
  validTo?: string;
}

/** Standard error envelope returned by the web API on failure. */
export interface ApiErrorBody {
  status: "error";
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
  };
}

/** One registered instance with resolution diagnostics. */
export interface InstanceView {
  record: {
    id: string;
    name: string;
    configPath?: string;
    dbPath?: string;
    proceduresDir?: string;
    createdAt: string;
  };
  dbPath: string | null;
  dbExists: boolean;
  hasProceduresDir: boolean;
  error: string | null;
}

/** Instance registry list response. */
export interface InstancesResponse {
  instances: InstanceView[];
  selectedId: string | null;
}

/** Selected-instance response. */
export interface SelectedInstanceResponse {
  selected: InstanceView | null;
}

/** Aggregate corpus health summary. */
export interface HealthStats {
  total: number;
  byType: Record<string, number>;
  claimKeyLifecycle: { trusted: number; tentative: number; unresolved: number; noKey: number };
  proposalBacklogCount: number;
  eligibleProposalBacklogCount: number;
  oldestOpenProposalCreatedAt: string | null;
  recency: { last7: number; last30: number; d30To90: number; d90Plus: number };
  recall: { never: number; oneToFive: number; fivePlus: number };
  quality: { high: number; medium: number; low: number; average: number };
}

/** Dreaming run status union. */
export type DreamRunStatus = "running" | "completed" | "failed" | "aborted" | "budget_exhausted" | "cost_capped" | "no_work" | "stalled";

/** Persisted dreaming run record. */
export interface DreamRunRecord {
  id: string;
  tier: "light" | "standard" | "deep";
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
  durablesStaled: number;
  error: string | null;
  dryRun: boolean;
}

/** Ops cockpit aggregate snapshot. */
export interface CockpitSnapshot {
  health: HealthStats;
  lastRun: DreamRunRecord | null;
  recentRuns: DreamRunRecord[];
  failedRuns: DreamRunRecord[];
  profile: {
    snapshot: { id: string; asOf: string; createdAt: string; runId: string | null } | null;
    profileDurableCount: number;
    directiveCount: number;
  };
  backlog: { total: number; eligible: number; oldestOpenCreatedAt: string | null };
  recentLightApplyRunsWithoutBackup: number;
}

/** Lifecycle status of a UI-started dreaming job. */
export type DreamJobStatus = "running" | "completed" | "failed" | "aborted";

/** One event in a dreaming job's live stream. */
export interface DreamJobEvent {
  seq: number;
  at: string;
  kind: "progress" | "status";
  progress?: DreamProgressEvent;
  status?: DreamJobStatus;
  message?: string;
}

/** Live dreaming job snapshot. */
export interface DreamJobSnapshot {
  jobId: string;
  instanceId: string;
  tier: "light" | "standard" | "deep";
  apply: boolean;
  project: string | null;
  status: DreamJobStatus;
  startedAt: string;
  completedAt: string | null;
  runId: string | null;
  error: string | null;
  events: DreamJobEvent[];
}

/** Combined run history plus live jobs. */
export interface DreamRunsResponse {
  history: DreamRunRecord[];
  jobs: DreamJobSnapshot[];
}

/** Operator-facing action audit row for one dreaming run. */
export interface DreamRunActionView {
  id: string;
  runId: string;
  actionType: string;
  durableIds: string[];
  reasoning: string;
  details: Record<string, unknown> | null;
  createdAt: string;
  durables: Durable[];
}

/** A durable knowledge record. */
export interface Durable {
  id: string;
  type: string;
  subject: string;
  content: string;
  importance: number;
  expiry: string;
  tags: string[];
  source_file?: string;
  quality_score: number;
  recall_count: number;
  last_recalled_at?: string;
  superseded_by?: string;
  valid_from?: string;
  valid_to?: string;
  claim_key?: string;
  claim_key_status?: string;
  project?: string;
  created_at: string;
  updated_at: string;
}

/** Paginated durable list result. */
export interface DurableListResult {
  durables: Durable[];
  total: number;
  limit: number;
  offset: number;
}

/** Durable trace detail view. */
export interface DurableTrace {
  durable: Durable;
  supersededBy?: Durable;
  supersedes: Durable[];
  claimFamily?: { claimKey: string; slotPolicy: string; slotPolicyReason?: string; durables: Durable[] };
  recall: { totalCount: number; recentEvents: { query?: string; recalledAt: string }[] };
  provenance: {
    sourceFile?: string;
    sourceContext?: string;
    claimKeySource?: string;
    claimSupportLocator?: string;
    claimSupportObservedAt?: string;
    project?: string;
    userId?: string;
  };
  dreamActions: { id: string; runId: string; actionType: string; reasoning: string; createdAt: string }[];
  profileSnapshots: { id: string; asOf: string; runId: string | null; createdAt: string; role: string }[];
  timeline: { at: string; kind: string; label: string; detail?: string; runId?: string; actionType?: string }[];
}

/** Dreaming proposal record. */
export interface DreamProposal {
  id: string;
  runId: string;
  groupId: string;
  issueKind: string;
  scope: "single_durable" | "cluster";
  durableIds: string[];
  currentClaimKeys: string[];
  proposedClaimKeys: string[];
  rationale: string;
  confidence: number;
  source: string;
  eligibleForApply: boolean;
  createdAt: string;
  reviewStatus: "open" | "applied" | "rejected";
  reviewedAt: string | null;
  reviewReason: string | null;
  appliedActionCount: number;
}

/** Global backlog row joining a proposal to its run. */
export interface ProposalBacklogItem {
  proposal: DreamProposal;
  runPassType: "light" | "standard" | "deep";
  runStartedAt: string;
  runStatus: DreamRunStatus;
  runDryRun: boolean;
}

/** Proposal detail with hydrated durables. */
export interface ProposalDetail {
  proposal: DreamProposal;
  activeDurables: Durable[];
  inactiveDurableIds: string[];
}

/** An episode record. */
export interface Episode {
  id: string;
  source: string;
  sourceId?: string;
  sourceRef?: string;
  transcriptHash?: string;
  summaryHash?: string;
  agentId?: string;
  surface?: string;
  summary?: string;
  startedAt: string;
  endedAt?: string;
  project?: string;
  messageCount?: number;
  activityLevel?: string;
  userId?: string;
  tags: string[];
  validFrom?: string;
  validTo?: string;
  supersessionKind?: string;
  supersessionReason?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** Paginated episode list result. */
export interface EpisodeListResult {
  episodes: Episode[];
  total: number;
  limit: number;
  offset: number;
}

/** A procedure revision. */
export interface Procedure {
  id: string;
  procedure_key: string;
  title: string;
  goal: string;
  when_to_use: string[];
  when_not_to_use: string[];
  prerequisites: string[];
  steps: ProcedureStep[];
  verification: string[];
  failure_modes: string[];
  source_file?: string;
  valid_from?: string;
  created_at: string;
  updated_at: string;
}

/** Procedure validation result. */
export interface ProcedureValidation {
  valid: boolean;
  error?: string;
  procedureKey?: string;
  title?: string;
}

/** Git worktree status for the procedures directory. */
export interface GitWorktreeStatus {
  isRepository: boolean;
  isDirty: boolean;
  branch: string | null;
  changedFiles: { status: string; path: string }[];
}

/** Procedure editor workspace listing. */
export interface ProcedureWorkspace {
  directory: string;
  files: { absolutePath: string; relativePath: string }[];
  git: GitWorktreeStatus;
}

/** Procedure document content plus validation. */
export interface ProcedureDocument {
  absolutePath: string;
  relativePath: string;
  content: string;
  validation: ProcedureValidation;
}

/** Procedure sync plan returned by the editor API. */
export type ProcedureSyncPlan = AppProcedureSyncPlan;

/** Procedure sync execution result. */
export type ProcedureSyncExecutionResult = AppProcedureSyncExecutionResult;

export type { ProcedureSyncExecutionItem, ProcedureSyncExecutionTotals, ProcedureSyncPlanItem, ProcedureSyncPlanTotals };

/** Procedure save-and-sync result. */
export interface ProcedureSaveResult {
  validation: ProcedureValidation;
  plan: ProcedureSyncPlan;
  execution: ProcedureSyncExecutionResult | null;
  git: GitWorktreeStatus;
}

/** Memory explorer filter facets. */
export interface MemoryFacets {
  claimKeyPrefixes: string[];
}
