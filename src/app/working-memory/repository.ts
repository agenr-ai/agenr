import type { AgenrWorkMutationActor, AgenrWorkMutationSource, WorkingScopeKind, WorkingSetStatus } from "./constants.js";
import type { ResolvedWorkingScope } from "./scope.js";
import type { WorkingSnapshot } from "./snapshot.js";
import type { WorkingEventRecord, WorkingEventType, WorkingSetRecord } from "./records.js";

/** Filter accepted by working-set list queries. */
export interface WorkingSetListFilter {
  /** Optional raw scope facts used to narrow the list to one resolved scope. */
  scope?: ResolvedWorkingScope;
  /** Optional scope kinds to include. */
  scopeKinds?: WorkingScopeKind[];
  /** Optional explicit statuses to include. */
  statuses?: WorkingSetStatus[];
  /** Maximum number of rows to return. */
  limit?: number;
}

/** Successful create response from the repository. */
export interface WorkingSetCreateSuccess {
  /** Newly persisted working set. */
  workingSet: WorkingSetRecord;
  /** Created lifecycle event. */
  event: WorkingEventRecord;
}

/** Failure returned when one open set already exists for the scope. */
export interface WorkingSetCreateFailure {
  /** Failure discriminator. */
  kind: "active_set_exists";
  /** Canonical scope key that already has an open set. */
  scopeKey: string;
}

/** Result returned when a repository creates one working set. */
export type WorkingSetCreateResult = WorkingSetCreateSuccess | WorkingSetCreateFailure;

/** Result returned when a repository mutates one working set. */
export interface WorkingSetMutationResult {
  /** Updated working set after the event is committed. */
  workingSet: WorkingSetRecord;
  /** Event written for the mutation. */
  event: WorkingEventRecord;
}

/** Input used to persist a newly created working set. */
export interface CreateWorkingSetInput {
  /** Resolved canonical scope for the set. */
  scope: ResolvedWorkingScope;
  /** Initial display title. */
  title?: string;
  /** Initial objective mirrored for list surfaces. */
  objective?: string;
  /** Initial status. */
  status: WorkingSetStatus;
  /** Initial snapshot. */
  snapshot: WorkingSnapshot;
  /** Actor that initiated creation. */
  actor?: AgenrWorkMutationActor;
  /** Source surface that initiated creation. */
  source?: AgenrWorkMutationSource;
  /** Adapter or runtime source label stored on the row. */
  sourceLabel?: string;
  /** Stable host session id when available. */
  sessionId?: string;
  /** Timestamp to use for row and event creation. */
  now: string;
}

/** Input used to persist an update event and snapshot revision. */
export interface UpdateWorkingSetInput {
  /** Working-set id to mutate. */
  workingSetId: string;
  /** Revision observed by the caller. */
  expectedRevision: number;
  /** Event type to append. */
  eventType: WorkingEventType;
  /** JSON-serializable event payload. */
  payload: unknown;
  /** Next status for the working set. */
  status: WorkingSetStatus;
  /** Next snapshot payload. */
  snapshot: WorkingSnapshot;
  /** Optional display title update. */
  title?: string;
  /** Optional objective mirror update. */
  objective?: string;
  /** Close timestamp for terminal updates. */
  closedAt?: string;
  /** Close or abandon reason for terminal updates. */
  closeReason?: string;
  /** Episode id emitted from the set when one exists. */
  episodeId?: string;
  /** Actor that initiated the mutation. */
  actor?: AgenrWorkMutationActor;
  /** Source surface that initiated the mutation. */
  source?: AgenrWorkMutationSource;
  /** Timestamp to use for row and event updates. */
  now: string;
}

/** Failure returned when a revision-guarded repository mutation cannot apply. */
export type WorkingSetWriteFailure =
  | { kind: "not_found" }
  | { kind: "revision_conflict"; actualRevision: number }
  | { kind: "terminal_status"; status: WorkingSetStatus };

/** Repository response for revision-guarded updates. */
export type WorkingSetWriteResult = WorkingSetMutationResult | WorkingSetWriteFailure;

/** Input used to persist a trusted usage patch without advancing revision. */
export interface PatchWorkingSetUsageInput {
  /** Working-set id to mutate. */
  workingSetId: string;
  /** Revision observed by the caller; must match the stored row without incrementing. */
  expectedRevision: number;
  /** Next status for the working set. */
  status: WorkingSetStatus;
  /** Next snapshot payload. */
  snapshot: WorkingSnapshot;
  /** Optional display title update. */
  title?: string;
  /** Optional objective mirror update. */
  objective?: string;
  /** Optional event to append when this usage patch causes a status transition. */
  auditEvent?: PatchWorkingSetUsageAuditEvent;
  /** Timestamp to use for row updates. */
  now: string;
}

/** Optional audit event emitted by trusted usage accounting. */
export interface PatchWorkingSetUsageAuditEvent {
  /** Event type to append. */
  eventType: WorkingEventType;
  /** JSON-serializable event payload. */
  payload: unknown;
  /** Actor that initiated the mutation. */
  actor?: AgenrWorkMutationActor;
  /** Source surface that emitted the mutation. */
  source?: AgenrWorkMutationSource;
}

/** Successful usage patch response from the repository. */
export interface WorkingSetUsagePatchResult {
  /** Updated working set after the patch is committed. */
  workingSet: WorkingSetRecord;
  /** Audit event written when a usage patch caused a semantic status transition. */
  event?: WorkingEventRecord;
}

/** Repository response for trusted usage patches. */
export type WorkingSetUsagePatchWriteResult = WorkingSetUsagePatchResult | WorkingSetWriteFailure;

/** Input used to atomically apply a trusted usage patch followed by a semantic update. */
export interface PatchWorkingSetUsageAndUpdateInput {
  /** Usage patch that must commit in the same transaction as the semantic update. */
  usagePatch: PatchWorkingSetUsageInput;
  /** Semantic update that follows the usage patch on the same observed revision. */
  update: UpdateWorkingSetInput;
}

/** Successful atomic usage-patch plus semantic-update response. */
export interface WorkingSetUsagePatchAndUpdateResult {
  /** Updated working set after both writes commit. */
  workingSet: WorkingSetRecord;
  /** Events written by the usage patch and semantic update, in commit order. */
  events: WorkingEventRecord[];
}

/** Repository response for an atomic usage-patch plus semantic-update write. */
export type WorkingSetUsagePatchAndUpdateWriteResult = WorkingSetUsagePatchAndUpdateResult | WorkingSetWriteFailure;

/** Input used to record one emitted episode on a close-managed working set. */
export interface RecordWorkingSetEpisodePromotionInput {
  /** Working-set id to annotate. */
  workingSetId: string;
  /** Revision observed by the caller; must match the stored row without incrementing. */
  expectedRevision: number;
  /** Next snapshot payload with promotion statuses already flipped. */
  snapshot: WorkingSnapshot;
  /** Episode id emitted from the set. */
  episodeId: string;
  /** Timestamp to use for row updates. */
  now: string;
}

/** Successful episode-promotion bookkeeping response. */
export interface WorkingSetEpisodePromotionResult {
  /** Updated working set after the bookkeeping write commits. */
  workingSet: WorkingSetRecord;
}

/** Repository response for episode-promotion bookkeeping writes. */
export type WorkingSetEpisodePromotionWriteResult = WorkingSetEpisodePromotionResult | WorkingSetWriteFailure;

/** Input used to record one candidate consolidation pass on a closed working set. */
export interface RecordWorkingSetCandidateConsolidationInput {
  /** Working-set id to annotate. */
  workingSetId: string;
  /** Revision observed by the caller; must match the stored row without incrementing. */
  expectedRevision: number;
  /** Next snapshot payload with candidate promotion statuses already flipped. */
  snapshot: WorkingSnapshot;
  /** Audit event appended to the ledger for the consolidation pass. */
  auditEvent: {
    /** JSON-serializable per-candidate outcome payload. */
    payload: unknown;
    /** Actor that ran the consolidation. */
    actor?: AgenrWorkMutationActor;
    /** Source surface that ran the consolidation. */
    source?: AgenrWorkMutationSource;
  };
  /** Timestamp to use for row and event updates. */
  now: string;
}

/** Successful candidate-consolidation bookkeeping response. */
export interface WorkingSetCandidateConsolidationResult {
  /** Updated working set after the bookkeeping write commits. */
  workingSet: WorkingSetRecord;
  /** Appended consolidation audit event. */
  event: WorkingEventRecord;
}

/** Repository response for candidate-consolidation bookkeeping writes. */
export type WorkingSetCandidateConsolidationWriteResult = WorkingSetCandidateConsolidationResult | WorkingSetWriteFailure;

/** Returns true when a repository create result is a failure. */
export function isWorkingSetCreateFailure(result: WorkingSetCreateResult): result is WorkingSetCreateFailure {
  return "kind" in result;
}

/** Returns true when a repository write result is a failure. */
export function isWorkingSetWriteFailure(
  result: WorkingSetWriteResult | WorkingSetUsagePatchWriteResult | WorkingSetEpisodePromotionWriteResult | WorkingSetCandidateConsolidationWriteResult,
): result is WorkingSetWriteFailure {
  return "kind" in result;
}

/** Persistence port for working-memory storage. */
export interface WorkingMemoryRepository {
  /**
   * Loads one working set by id.
   *
   * @param id - Working-set identifier.
   * @returns Stored set, or null when it does not exist.
   */
  getWorkingSet(id: string): Promise<WorkingSetRecord | null>;

  /**
   * Finds current working sets for one resolved scope, including completed
   * goals that still occupy the scope until explicit user clear.
   *
   * @param scope - Canonical scope selected by the app service.
   * @returns Matching current working sets ordered by recency.
   */
  findCurrentWorkingSets(scope: ResolvedWorkingScope): Promise<WorkingSetRecord[]>;

  /**
   * Lists working sets for inspection or tool output.
   *
   * @param filter - Optional scope, status, and limit filters.
   * @returns Matching working sets ordered by recency.
   */
  listWorkingSets(filter: WorkingSetListFilter): Promise<WorkingSetRecord[]>;

  /**
   * Lists recent events for one working set.
   *
   * @param workingSetId - Working set to inspect.
   * @param limit - Maximum number of events to return.
   * @returns Events ordered by sequence ascending.
   */
  listWorkingEvents(workingSetId: string, limit?: number): Promise<WorkingEventRecord[]>;

  /**
   * Creates one working set and its initial event atomically.
   *
   * @param input - Initial working-set state.
   * @returns Persisted working set plus created event.
   */
  createWorkingSet(input: CreateWorkingSetInput): Promise<WorkingSetCreateResult>;

  /**
   * Applies one revision-guarded working-set mutation atomically.
   *
   * @param input - Update event, expected revision, and next snapshot.
   * @returns Updated row and event, or a stable write failure.
   */
  updateWorkingSet(input: UpdateWorkingSetInput): Promise<WorkingSetWriteResult>;

  /**
   * Applies one trusted usage patch without advancing revision.
   *
   * @param input - Next snapshot and status guarded by expectedRevision compare-and-swap.
   * @returns Updated row, optional audit event, or a stable write failure.
   */
  patchWorkingSetUsage(input: PatchWorkingSetUsageInput): Promise<WorkingSetUsagePatchWriteResult>;

  /**
   * Applies a trusted usage patch and following semantic update atomically.
   *
   * @param input - Usage patch plus semantic update to commit in one transaction.
   * @returns Final row, committed events, or a stable write failure with no partial write.
   */
  patchWorkingSetUsageAndUpdate(input: PatchWorkingSetUsageAndUpdateInput): Promise<WorkingSetUsagePatchAndUpdateWriteResult>;

  /**
   * Records one emitted episode on a close-managed working set without
   * advancing revision. Used after candidate promotion succeeds in the
   * owning subsystem.
   *
   * @param input - Flipped snapshot, episode id, and expected revision.
   * @returns Updated row, or a stable write failure.
   */
  recordEpisodePromotion(input: RecordWorkingSetEpisodePromotionInput): Promise<WorkingSetEpisodePromotionWriteResult>;

  /**
   * Records one candidate consolidation pass on a close-managed working set
   * without advancing revision. Flips candidate promotion statuses in the
   * snapshot and appends one `consolidated` audit event to the ledger.
   *
   * @param input - Flipped snapshot, audit payload, and expected revision.
   * @returns Updated row plus appended event, or a stable write failure.
   */
  recordCandidateConsolidation(input: RecordWorkingSetCandidateConsolidationInput): Promise<WorkingSetCandidateConsolidationWriteResult>;
}
