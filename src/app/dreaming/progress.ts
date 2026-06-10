import type { DreamTier } from "../../core/dreaming/domain/pass-types.js";
import type { ClaimKeyHealthSnapshot, ReconcileRepairCounts } from "../../core/dreaming/types.js";

/**
 * High-level startup and orchestration phases emitted during one dreaming run.
 */
export type DreamRunProgressPhase =
  | "start"
  | "backup_start"
  | "backup_complete"
  | "load_working_set_start"
  | "load_working_set_complete"
  | "load_pass_context_start"
  | "load_pass_context_complete"
  | "pass_start";

/**
 * Deterministic reconcile stages that can emit bounded progress updates.
 */
export type ReconcileProgressStage =
  | "health"
  | "invalid_noncanonical"
  | "missing"
  | "suspect_canonical"
  | "entity_family_convergence"
  | "claim_key_alias_convergence"
  | "duplicate_slot_collapse"
  | "mixed_key_groups";

/**
 * One startup or orchestration phase update emitted during a dreaming run.
 */
export interface DreamPhaseProgressEvent {
  kind: "phase";
  phase: DreamRunProgressPhase;
  tier: DreamTier;
  apply: boolean;
  workingSetSize?: number;
  eligibleProposalBacklogCount?: number;
  backupPath?: string;
}

/**
 * One bounded progress snapshot emitted during the reconcile pass.
 */
export interface ReconcileProgressEvent {
  kind: "reconcile_progress";
  tier: DreamTier;
  apply: boolean;
  stage: ReconcileProgressStage;
  status: "snapshot" | "started" | "preview_progress" | "progress" | "completed";
  completed: number;
  total: number;
  unitLabel: "durables" | "groups";
  previewQueued?: number;
  previewCompleted?: number;
  previewTotal?: number;
  previewConcurrency?: number;
  processedDurables: number;
  totalDurables: number;
  counts: ReconcileRepairCounts;
  elapsedMs: number;
  health?: ClaimKeyHealthSnapshot;
}

/**
 * One bounded progress snapshot emitted during proposal resolution.
 */
export interface ProposalResolutionProgressEvent {
  kind: "proposal_resolution_progress";
  tier: "proposal_resolution";
  apply: boolean;
  status: "started" | "proposal_processed" | "completed" | "no_work" | "stalled";
  totalProposals: number;
  processedProposals: number;
  appliedCount: number;
  rejectedInactiveCount: number;
  rejectedInvalidCount: number;
  noChangeCount: number;
  targetedEntryCount: number;
  proposalId?: string;
  issueKind?: string;
  outcome?: "applied" | "dry_run" | "rejected_inactive" | "rejected_invalid" | "no_change";
}

/**
 * Structured progress event union emitted by dreaming runtime helpers.
 */
export type DreamProgressEvent = DreamPhaseProgressEvent | ReconcileProgressEvent | ProposalResolutionProgressEvent;

/**
 * Optional callback that receives structured progress events during a run.
 */
export type DreamProgressReporter = (event: DreamProgressEvent) => void;

/**
 * Emits one progress event when a reporter is configured, ignoring reporter failures.
 *
 * @param reporter - Optional progress callback.
 * @param event - Structured progress event payload.
 */
export function emitDreamProgress(reporter: DreamProgressReporter | undefined, event: DreamProgressEvent): void {
  if (!reporter) {
    return;
  }

  try {
    reporter(event);
  } catch {
    // Progress reporting must never fail the run.
  }
}
