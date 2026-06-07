import type { WorkingScope } from "../working-memory/scope.js";

/**
 * Phase 2 session-memory contracts.
 */

/**
 * Artifact kinds accepted by schema v12.
 */
const SESSION_ARTIFACT_KINDS = ["compaction_checkpoint", "branch_abandonment", "session_episode"] as const;

/**
 * Host transition reasons that create session-lineage edges.
 */
const SESSION_LINEAGE_REASONS = ["fork", "clone", "resume", "subagent_spawn"] as const;

/**
 * Host transition reasons accepted at session start.
 */
const SESSION_START_TRANSITION_REASONS = ["new", "unknown", ...SESSION_LINEAGE_REASONS] as const;

/**
 * Lifecycle trigger names that can matter to session-memory routing.
 */
const SESSION_MEMORY_TRIGGER_TYPES = [
  "session_start",
  "session_before_fork",
  "session_before_compact",
  "session_compact",
  "session_before_tree",
  "session_tree",
  "session_shutdown",
] as const;

export { SESSION_ARTIFACT_KINDS, SESSION_LINEAGE_REASONS, SESSION_MEMORY_TRIGGER_TYPES, SESSION_START_TRANSITION_REASONS };

/**
 * Union of schema v12 session-artifact kinds.
 */
export type SessionArtifactKind = (typeof SESSION_ARTIFACT_KINDS)[number];

/**
 * Union of host transition reasons that create lineage edges.
 */
export type SessionLineageReason = (typeof SESSION_LINEAGE_REASONS)[number];

/**
 * Union of accepted session-start transition reasons.
 */
export type SessionStartTransitionReason = (typeof SESSION_START_TRANSITION_REASONS)[number];

/**
 * Union of lifecycle triggers accepted by the session-memory router.
 */
export type SessionMemoryTriggerType = (typeof SESSION_MEMORY_TRIGGER_TYPES)[number];

/**
 * Schema v12 lineage edge row shape frozen for the session-tree phase.
 */
export interface SessionLineageEdge {
  /** Primary key. */
  id: string;
  /** Child session key. */
  childSessionKey: string;
  /** Parent session key when known. */
  parentSessionKey?: string;
  /** Parent source reference when a parent key is unavailable. */
  parentSourceRef?: string;
  /** Host-supplied transition reason. */
  reason: SessionLineageReason;
  /** Host entry id at fork time when known. */
  forkEntryId?: string;
  /** Host fork position when known. */
  forkPosition?: string;
  /** ISO timestamp when the edge was observed. */
  observedAt: string;
}

/**
 * Parent session facts carried by host lifecycle events.
 */
export interface SessionPredecessorRef {
  /** Parent session key when the host can resolve it. */
  sessionKey?: string;
  /** Compact parent source reference when no stable key exists. */
  sourceRef?: string;
  /** Host entry id at fork time when known. */
  forkEntryId?: string;
  /** Host fork position when known. */
  forkPosition?: string;
}

/**
 * Schema v12 session-artifact row shape frozen for the session-tree phase.
 */
export interface SessionArtifact {
  /** Primary key. */
  id: string;
  /** Artifact kind. */
  kind: SessionArtifactKind;
  /** Host session key. */
  sessionKey: string;
  /** Source adapter or runtime. */
  source: string;
  /** Source-local id. */
  sourceId: string;
  /** Optional compact source reference. */
  sourceRef?: string;
  /** Hash of artifact content. */
  contentHash: string;
  /** Artifact summary. */
  summary: string;
  /** Optional typed metadata. */
  metadata?: unknown;
  /** Creation timestamp. */
  createdAt: string;
  /** Expiry timestamp when retention is bounded. */
  expiresAt?: string;
}

/**
 * Session artifact payload accepted by lifecycle intake.
 */
export interface SessionArtifactInput {
  /** Artifact kind. */
  kind: SessionArtifactKind;
  /** Optional explicit session key. Defaults to the trigger session key. */
  sessionKey?: string;
  /** Source adapter or runtime. */
  source: string;
  /** Source-local id. */
  sourceId: string;
  /** Optional compact source reference. */
  sourceRef?: string;
  /** Artifact summary stored in schema v12. */
  summary: string;
  /** Optional caller-supplied content hash. */
  contentHash?: string;
  /** Optional typed metadata. */
  metadata?: unknown;
  /** Expiry timestamp when retention is bounded. */
  expiresAt?: string;
}

/**
 * Normalized session artifact payload ready for repository persistence.
 */
export type NormalizedSessionArtifactInput = SessionArtifactInput &
  Required<Pick<SessionArtifactInput, "sessionKey" | "source" | "sourceId" | "summary" | "contentHash">>;

/**
 * Metadata for pointer-only `session_episode` artifacts.
 */
export interface SessionEpisodeArtifactMetadata {
  /** Episode row id. */
  episodeId: string;
  /** Source reference for the episode. */
  sourceRef: string;
  /** Hash of the episode content. */
  contentHash: string;
  /** One-line episode summary for artifact lists. */
  summaryOneLiner: string;
}

/**
 * Host lifecycle event routed into future session-memory services.
 */
export interface SessionMemoryTriggerEvent {
  /** Trigger discriminator. */
  type: SessionMemoryTriggerType;
  /** Host session key when known. */
  sessionKey?: string;
  /** Explicit child session key when different from `sessionKey`. */
  childSessionKey?: string;
  /** Host transition reason when this event represents session movement. */
  transitionReason?: SessionStartTransitionReason;
  /** Parent session facts for lineage persistence. */
  predecessor?: SessionPredecessorRef;
  /** Optional session artifact to persist for this trigger. */
  artifact?: SessionArtifactInput;
  /** Optional working-memory scope facts for lifecycle checkpoint refreshes. */
  workingScope?: Partial<WorkingScope>;
  /** Normalized shutdown reason when `type` is `session_shutdown`. */
  shutdownReason?: string;
  /** Optional raw host payload retained for adapter-specific parsing. */
  payload?: unknown;
  /** ISO timestamp when the trigger was observed. */
  observedAt: string;
}
