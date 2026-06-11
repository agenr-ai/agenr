import type { SessionMemoryTriggerAcceptedResult } from "../session-memory/results.js";
import type { SessionArtifactInput, SessionMemoryTriggerEvent } from "../session-memory/types.js";
import { normalizeOptionalString } from "../session-memory/normalize.js";
import type { WorkingMemoryErrorCode } from "./results.js";
import type { WorkingMemoryService } from "./service.js";
import type { WorkingScope } from "./scope.js";

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
  reason: "not_applicable" | "missing_scope" | "no_active_working_set" | "working_memory_unavailable";
  /** Working-memory error code when the working service rejected the update. */
  code?: WorkingMemoryErrorCode;
  /** Human-readable status for diagnostics. */
  message: string;
}

/** Result returned from lifecycle working-checkpoint refresh. */
export type WorkingCheckpointRefreshResult = WorkingCheckpointRefreshSuccess | WorkingCheckpointRefreshSkipped;

/** Session compact event carrying a compaction checkpoint for working-memory refresh. */
export type CompactionCheckpointRefreshEvent = SessionMemoryTriggerEvent & {
  /** Compaction lifecycle discriminator. */
  type: "session_compact";
  /** Compaction checkpoint artifact from the host lifecycle event. */
  artifact: SessionArtifactInput & { kind: "compaction_checkpoint" };
};

/** Session shutdown event eligible for working-memory checkpoint refresh. */
export type ShutdownCheckpointRefreshEvent = SessionMemoryTriggerEvent & {
  /** Shutdown lifecycle discriminator. */
  type: "session_shutdown";
};

/** Lifecycle facts required to merge one working checkpoint. */
interface WorkingCheckpointRefreshRequest {
  /** Working-memory scope for the lifecycle event. */
  event: CompactionCheckpointRefreshEvent | ShutdownCheckpointRefreshEvent;
  /** Non-empty checkpoint summary to merge. */
  summary: string;
  /** Human-readable update reason stored with the revision. */
  updateReason: string;
  /** Label used when mapping working-memory failures. */
  lifecycleLabel: string;
  /** Label used when no working-memory service is wired. */
  attachLabel: string;
}

/**
 * Attaches working-checkpoint refresh diagnostics to accepted intake results.
 *
 * Artifact intake and working-set refresh are intentionally best-effort and
 * non-atomic: a persisted compaction artifact is not rolled back when refresh fails.
 *
 * @param event - Session lifecycle event already accepted by session-memory intake.
 * @param result - Accepted intake result to enrich when a compaction checkpoint was recorded.
 * @param workingMemory - Optional working-memory service wired by the runtime.
 * @returns The accepted result, optionally enriched with refresh diagnostics.
 */
export async function attachWorkingCheckpointRefresh(
  event: SessionMemoryTriggerEvent,
  result: SessionMemoryTriggerAcceptedResult,
  workingMemory?: WorkingMemoryService,
): Promise<SessionMemoryTriggerAcceptedResult> {
  const refreshRequest = resolveWorkingCheckpointRefreshRequest(event, result);
  if (!refreshRequest) {
    return result;
  }

  const workingCheckpointRefresh = workingMemory
    ? await mergeWorkingCheckpoint(refreshRequest, workingMemory)
    : skippedRefreshWithoutWorkingMemory(refreshRequest.attachLabel);

  return {
    ...result,
    workingCheckpointRefresh,
  };
}

/** Merges one lifecycle checkpoint into the active working set when scope is available. */
async function mergeWorkingCheckpoint(request: WorkingCheckpointRefreshRequest, workingMemory: WorkingMemoryService): Promise<WorkingCheckpointRefreshResult> {
  const scope = resolveWorkingRefreshScope(request.event);
  if (!scope) {
    return {
      ok: false,
      reason: "missing_scope",
      message: `${request.lifecycleLabel} requires working-scope facts.`,
    };
  }

  const result = await workingMemory.run({
    action: "update",
    target: "session",
    scope,
    operation: {
      type: "merge_checkpoint",
      checkpoint: {
        summary: request.summary,
        recordedAt: request.event.observedAt,
      },
    },
    updateReason: request.updateReason,
    actor: "runtime",
    source: "lifecycle_hook",
  });

  if (!result.ok) {
    return mapWorkingMemoryRefreshFailure(result.code, result.message, request.lifecycleLabel);
  }

  if (result.action !== "update") {
    return {
      ok: false,
      reason: "working_memory_unavailable",
      message: `Expected working-memory update result, received ${result.action}.`,
    };
  }

  return {
    ok: true,
    action: "working_checkpoint_refreshed",
    workingSetId: result.workingSet.id,
    revision: result.workingSet.revision,
  };
}

/** Resolves one lifecycle checkpoint refresh request from intake results. */
function resolveWorkingCheckpointRefreshRequest(
  event: SessionMemoryTriggerEvent,
  result: SessionMemoryTriggerAcceptedResult,
): WorkingCheckpointRefreshRequest | undefined {
  const compactionEvent = resolveCompactionCheckpointRefreshEvent(event, result);
  if (compactionEvent) {
    const summary = normalizeOptionalString(compactionEvent.artifact.summary);
    if (!summary) {
      return undefined;
    }

    const sourceId = normalizeOptionalString(compactionEvent.artifact.sourceId) ?? "unknown";
    return {
      event: compactionEvent,
      summary,
      updateReason: `Refreshed working checkpoint from session compaction ${sourceId}.`,
      lifecycleLabel: "compaction checkpoint refresh",
      attachLabel: "Compaction checkpoint refresh",
    };
  }

  const shutdownEvent = resolveShutdownCheckpointRefreshEvent(event, result);
  if (!shutdownEvent) {
    return undefined;
  }

  const reason = normalizeShutdownReason(shutdownEvent.shutdownReason);
  return {
    event: shutdownEvent,
    summary: `Session shutdown (${reason}) recorded. Resume from the latest working-set snapshot; no implicit close was performed.`,
    updateReason: `Recorded working checkpoint from session shutdown (${reason}).`,
    lifecycleLabel: "shutdown checkpoint refresh",
    attachLabel: "Shutdown checkpoint refresh",
  };
}

/** Resolves a validated compaction refresh event when intake recorded a checkpoint artifact. */
function resolveCompactionCheckpointRefreshEvent(
  event: SessionMemoryTriggerEvent,
  result: SessionMemoryTriggerAcceptedResult,
): CompactionCheckpointRefreshEvent | undefined {
  if (event.type !== "session_compact" || result.artifact?.kind !== "compaction_checkpoint") {
    return undefined;
  }

  const artifact = event.artifact;
  if (!isCompactionCheckpointArtifact(artifact)) {
    return undefined;
  }

  return {
    ...event,
    type: "session_compact",
    artifact,
  };
}

/** Resolves a shutdown refresh event when lifecycle intake accepted shutdown handling. */
function resolveShutdownCheckpointRefreshEvent(
  event: SessionMemoryTriggerEvent,
  result: SessionMemoryTriggerAcceptedResult,
): ShutdownCheckpointRefreshEvent | undefined {
  if (event.type !== "session_shutdown" || result.accepted !== true) {
    return undefined;
  }

  return {
    ...event,
    type: "session_shutdown",
  };
}

/** Narrows artifact input to a compaction checkpoint payload. */
function isCompactionCheckpointArtifact(artifact: SessionArtifactInput | undefined): artifact is SessionArtifactInput & { kind: "compaction_checkpoint" } {
  return artifact?.kind === "compaction_checkpoint";
}

/** Resolves the working-memory scope used for a lifecycle refresh. */
function resolveWorkingRefreshScope(event: CompactionCheckpointRefreshEvent | ShutdownCheckpointRefreshEvent): Partial<WorkingScope> | undefined {
  if (event.workingScope && Object.keys(event.workingScope).length > 0) {
    return event.workingScope;
  }

  return undefined;
}

/** Maps working-memory service failures into lifecycle refresh diagnostics. */
function mapWorkingMemoryRefreshFailure(code: WorkingMemoryErrorCode, message: string, lifecycleLabel: string): WorkingCheckpointRefreshSkipped {
  if (code === "feature_disabled") {
    return {
      ok: false,
      reason: "not_applicable",
      message: `Working memory is disabled; ${lifecycleLabel} was skipped.`,
    };
  }

  if (code === "missing_active_set") {
    return {
      ok: false,
      reason: "no_active_working_set",
      code,
      message,
    };
  }

  return {
    ok: false,
    reason: "working_memory_unavailable",
    code,
    message,
  };
}

/** Reads a compact shutdown reason from the normalized event field. */
function normalizeShutdownReason(shutdownReason: string | undefined): string {
  const trimmed = shutdownReason?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "unknown";
}

/** Explains when refresh was skipped because no working-memory service was wired. */
function skippedRefreshWithoutWorkingMemory(label: string): WorkingCheckpointRefreshSkipped {
  return {
    ok: false,
    reason: "not_applicable",
    message: `${label} requires a working-memory service, but none was wired into the runtime.`,
  };
}
