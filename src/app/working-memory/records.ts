import type { AgenrWorkMutationActor, AgenrWorkMutationSource, WorkingScopeKind, WorkingSetStatus } from "./constants.js";
import type { WorkingEventType } from "./events.js";
import type { WorkingSnapshot } from "./snapshot.js";

/**
 * Schema v11 working-set row shape frozen for Phase 1 implementation.
 *
 * Task state lives in `snapshot` only. Top-level scope columns exist for
 * indexing and one-open-set cardinality checks, not as a second source of truth.
 */
export interface WorkingSetRecord {
  /** Primary key. */
  id: string;
  /** Canonical scope key used for one-open-set cardinality. */
  scopeKey: string;
  /** Canonical scope kind. */
  scopeKind: WorkingScopeKind;
  /** Optional display title. */
  title?: string;
  /** Objective mirrored from the snapshot for list and audit surfaces. */
  objective?: string;
  /** Current working-set status. */
  status: WorkingSetStatus;
  /** Summary mirrored from the snapshot for list and audit surfaces. */
  summary?: string;
  /** Canonical snapshot JSON and sole source of task-state truth. */
  snapshot: WorkingSnapshot;
  /** Monotonic snapshot revision. */
  revision: number;
  /** Number of events written for this working set. */
  eventCount: number;
  /** Optional heartbeat timestamp. */
  heartbeatAt?: string;
  /** Optional resume timestamp used by future schedulers. */
  resumeAfter?: string;
  /** Optional staleness timestamp used by future schedulers. */
  staleAfter?: string;
  /** Optional lease owner. */
  leaseOwner?: string;
  /** Optional lease expiry timestamp. */
  leaseExpiresAt?: string;
  /** Optional user id. */
  userId?: string;
  /** Optional project label. */
  project?: string;
  /** Optional host surface. */
  surface?: string;
  /** Optional host session id. */
  sessionId?: string;
  /** Optional host session key. */
  sessionKey?: string;
  /** Optional host-neutral conversation key. */
  conversationKey?: string;
  /** Optional host-neutral runtime thread key. */
  runtimeThreadKey?: string;
  /** Optional compatibility host thread id. */
  hostThreadId?: string;
  /** Optional current working directory. */
  cwd?: string;
  /** Optional Git repository root. */
  gitRoot?: string;
  /** Optional Git branch. */
  gitBranch?: string;
  /** Optional explicit task id. */
  taskId?: string;
  /** Source adapter or runtime that created the set. */
  source?: string;
  /** Creation timestamp. */
  createdAt: string;
  /** Last update timestamp. */
  updatedAt: string;
  /** Last material activity timestamp. */
  lastActiveAt: string;
  /** Close timestamp when closed. */
  closedAt?: string;
  /** Close or abandon reason. */
  closeReason?: string;
  /** Episode emitted from this set when one exists. */
  episodeId?: string;
}

/**
 * Schema v11 working-event row shape frozen for Phase 1 implementation.
 */
export interface WorkingEventRecord {
  /** Primary key. */
  id: string;
  /** Owning working-set id. */
  workingSetId: string;
  /** Monotonic sequence within the working set. */
  sequence: number;
  /** Closed event type union. */
  eventType: WorkingEventType;
  /** JSON-serializable payload. */
  payload: unknown;
  /** Actor that caused the event. */
  actor?: AgenrWorkMutationActor;
  /** Runtime source that emitted the event. */
  source?: AgenrWorkMutationSource;
  /** Optional host event id for idempotency or tracing. */
  hostEventId?: string;
  /** Optional host turn id. */
  turnId?: string;
  /** Creation timestamp. */
  createdAt: string;
}
