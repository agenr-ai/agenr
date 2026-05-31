import type { NormalizedSessionArtifactInput, SessionArtifact, SessionArtifactKind, SessionLineageEdge, SessionLineageReason } from "./types.js";

/** Input used to persist one schema v12 lineage edge. */
export interface UpsertSessionLineageEdgeInput {
  /** Child session key receiving predecessor context. */
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

/** Filter accepted by session-artifact list queries scoped to one session key. */
export interface SessionArtifactListFilter {
  /** Session key that owns the artifacts. */
  sessionKey: string;
  /** Optional artifact kinds to include. */
  kinds?: SessionArtifactKind[];
  /** Maximum number of artifacts to return. */
  limit?: number;
}

/** Filter accepted by session-artifact list queries scoped to one source ref. */
export interface SessionArtifactSourceRefListFilter {
  /** Compact source reference stored on artifact rows. */
  sourceRef: string;
  /** Optional artifact kinds to include. */
  kinds?: SessionArtifactKind[];
  /** Maximum number of artifacts to return. */
  limit?: number;
}

/** Optional facts persisted together from one lifecycle trigger intake. */
export interface RecordTriggerIntakeInput {
  /** Normalized artifact payload when the trigger includes artifact facts. */
  artifact?: NormalizedSessionArtifactInput;
  /** Normalized lineage payload when the trigger includes lineage facts. */
  lineage?: UpsertSessionLineageEdgeInput;
}

/** Persisted facts returned from one lifecycle trigger intake. */
export interface RecordTriggerIntakeResult {
  /** Persisted artifact when one was written. */
  artifact?: SessionArtifact;
  /** Persisted lineage edge when one was written. */
  lineageEdge?: SessionLineageEdge;
}

/** Persistence port for schema v12 session-memory storage. */
export interface SessionMemoryRepository {
  /**
   * Inserts one lineage edge, or returns the existing matching edge.
   *
   * @param input - Normalized lineage edge payload.
   * @returns Persisted lineage edge.
   */
  upsertLineageEdge(input: UpsertSessionLineageEdgeInput): Promise<SessionLineageEdge>;

  /**
   * Inserts or updates one session artifact by `(kind, source, sourceId)`.
   *
   * @param input - Normalized artifact payload.
   * @returns Persisted session artifact.
   */
  upsertSessionArtifact(input: NormalizedSessionArtifactInput): Promise<SessionArtifact>;

  /**
   * Persists one or more trigger facts atomically.
   *
   * @param input - Optional artifact and lineage payloads from one lifecycle event.
   * @returns Persisted facts written during the intake.
   */
  recordTriggerIntake(input: RecordTriggerIntakeInput): Promise<RecordTriggerIntakeResult>;

  /**
   * Lists artifacts for one session key.
   *
   * @param filter - Session key, optional kinds, and bounded limit.
   * @returns Matching artifacts ordered by newest first.
   */
  listSessionArtifacts(filter: SessionArtifactListFilter): Promise<SessionArtifact[]>;

  /**
   * Lists artifacts linked to one source reference.
   *
   * @param filter - Source ref, optional kinds, and bounded limit.
   * @returns Matching artifacts ordered by newest first.
   */
  listSessionArtifactsBySourceRef(filter: SessionArtifactSourceRefListFilter): Promise<SessionArtifact[]>;

  /**
   * Loads the newest lineage edge for one child session.
   *
   * @param childSessionKey - Child session key.
   * @returns Matching lineage edge, or null when none exists.
   */
  getLatestLineageEdgeForChild(childSessionKey: string): Promise<SessionLineageEdge | null>;
}
