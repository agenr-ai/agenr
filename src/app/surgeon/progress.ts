import type { ImplementedSurgeonPass } from "../../core/surgeon/domain/run-presets.js";
import type { ClaimKeyHealthSnapshot, ClaimKeyQualityRepairCounts } from "../../core/surgeon/types.js";

/**
 * High-level startup and orchestration phases emitted during one surgeon run.
 */
export type SurgeonRunProgressPhase =
  | "start"
  | "backup_start"
  | "backup_complete"
  | "load_working_set_start"
  | "load_working_set_complete"
  | "load_pass_context_start"
  | "load_pass_context_complete"
  | "pass_start";

/**
 * Deterministic claim-key-quality stages that can emit bounded progress updates.
 */
export type ClaimKeyQualityProgressStage = "health" | "invalid_noncanonical" | "missing" | "suspect_canonical" | "mixed_key_groups";

/**
 * One startup or orchestration phase update emitted during a surgeon run.
 */
export interface SurgeonPhaseProgressEvent {
  kind: "phase";
  phase: SurgeonRunProgressPhase;
  passType: ImplementedSurgeonPass;
  apply: boolean;
  workingSetSize?: number;
  backupPath?: string;
}

/**
 * One bounded progress snapshot emitted during the claim-key-quality pass.
 */
export interface ClaimKeyQualityProgressEvent {
  kind: "claim_key_quality_progress";
  passType: "claim_key_quality";
  apply: boolean;
  stage: ClaimKeyQualityProgressStage;
  status: "snapshot" | "started" | "preview_progress" | "progress" | "completed";
  completed: number;
  total: number;
  unitLabel: "entries" | "groups";
  previewQueued?: number;
  previewCompleted?: number;
  previewTotal?: number;
  previewConcurrency?: number;
  processedEntries: number;
  totalEntries: number;
  counts: ClaimKeyQualityRepairCounts;
  elapsedMs: number;
  health?: ClaimKeyHealthSnapshot;
}

/**
 * Structured progress event union emitted by surgeon runtime helpers.
 */
export type SurgeonProgressEvent = SurgeonPhaseProgressEvent | ClaimKeyQualityProgressEvent;

/**
 * Optional callback that receives structured progress events during a run.
 */
export type SurgeonProgressReporter = (event: SurgeonProgressEvent) => void;

/**
 * Emits one progress event when a reporter is configured, ignoring reporter failures.
 *
 * @param reporter - Optional progress callback.
 * @param event - Structured progress event payload.
 */
export function emitSurgeonProgress(reporter: SurgeonProgressReporter | undefined, event: SurgeonProgressEvent): void {
  if (!reporter) {
    return;
  }

  try {
    reporter(event);
  } catch {
    // Progress reporting must never fail the run.
  }
}
