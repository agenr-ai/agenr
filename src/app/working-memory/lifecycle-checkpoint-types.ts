import type { WorkingMemoryErrorCode } from "./results.js";

/** Result emitted when lifecycle refresh touches an active working set. */
export interface WorkingCheckpointRefreshSuccess {
  /** Success discriminator. */
  ok: true;
  /** Stable action discriminator. */
  action: "working_checkpoint_refreshed";
  /** Working set updated from the lifecycle checkpoint. */
  workingSetId: string;
  /** New working-set revision. */
  revision: number;
}

/** Result emitted when lifecycle refresh cannot or should not update WIP. */
export interface WorkingCheckpointRefreshSkipped {
  /** Failure or skip discriminator. */
  ok: false;
  /** Stable reason for the skipped refresh. */
  reason: "not_applicable" | "missing_scope" | "missing_summary" | "no_active_working_set" | "working_memory_unavailable";
  /** Working-memory error code when the working service rejected the update. */
  code?: WorkingMemoryErrorCode;
  /** Human-readable status for diagnostics. */
  message: string;
}

/** Result returned from lifecycle working-checkpoint refresh. */
export type WorkingCheckpointRefreshResult = WorkingCheckpointRefreshSuccess | WorkingCheckpointRefreshSkipped;

/** Legacy alias retained for session-memory callers. @deprecated Use {@link WorkingCheckpointRefreshResult}. */
export type SessionWorkingCheckpointRefreshResult = WorkingCheckpointRefreshResult;

/** Legacy alias retained for session-memory callers. @deprecated Use {@link WorkingCheckpointRefreshResult}. */
export type SessionCompactionWorkingCheckpointRefreshResult = WorkingCheckpointRefreshResult;
