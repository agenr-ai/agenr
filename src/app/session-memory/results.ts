import type { WorkingCheckpointRefreshResult } from "../working-memory/lifecycle-checkpoint-types.js";
import type { SessionArtifact, SessionLineageEdge } from "./types.js";

/**
 * Stable reasons returned when session-memory intake cannot run.
 */
export type SessionMemoryTriggerFailureReason = "feature_disabled" | "misconfigured" | "invalid_event";

/**
 * Successful session-memory intake action.
 */
export type SessionMemoryTriggerAction = "lineage_recorded" | "artifact_recorded" | "recorded" | "checkpoint_relevant" | "no_lineage";

/** Result returned when session-memory intake accepts an event. */
export interface SessionMemoryTriggerAcceptedResult {
  /** Whether the event was accepted for persistence or lifecycle handling. */
  accepted: true;
  /** Stable action performed by the intake service. */
  action: SessionMemoryTriggerAction;
  /** Human-readable status message. */
  message: string;
  /** Persisted lineage edge when one was recorded. */
  lineageEdge?: SessionLineageEdge;
  /** Persisted artifact when one was recorded. */
  artifact?: SessionArtifact;
  /** Working-set checkpoint refresh result for compaction lifecycle events. */
  workingCheckpointRefresh?: WorkingCheckpointRefreshResult;
}

/** Result returned when session-memory intake rejects an event. */
export interface SessionMemoryTriggerRejectedResult {
  /** Whether the event was accepted for persistence or lifecycle handling. */
  accepted: false;
  /** Stable reason no behavior ran. */
  reason: SessionMemoryTriggerFailureReason;
  /** Human-readable status message. */
  message: string;
}

/** Result returned by the session-memory trigger router. */
export type SessionMemoryTriggerResult = SessionMemoryTriggerAcceptedResult | SessionMemoryTriggerRejectedResult;
