import type { WorkingContextProjection } from "./projection.js";
import type { WorkingEventRecord, WorkingSetRecord } from "./records.js";
import type { WorkingSetWriteFailure } from "./repository.js";
import type { WorkingCandidate } from "./snapshot.js";

/**
 * Stable error codes returned by the working-memory service.
 */
export type WorkingMemoryErrorCode =
  | "feature_disabled"
  | "misconfigured"
  | "invalid_request"
  | "missing_scope"
  | "missing_active_set"
  | "ambiguous_scope"
  | "active_set_exists"
  | "close_not_allowed"
  | "not_found"
  | "revision_conflict"
  | "terminal_status";

/** Failed working-memory service result. */
export interface WorkingMemoryFailure {
  /** Failure discriminator. */
  ok: false;
  /** Stable failure code. */
  code: WorkingMemoryErrorCode;
  /** Human-readable failure message. */
  message: string;
  /** Optional machine-readable details. */
  details?: Record<string, unknown>;
}

/** Successful working-memory get result. */
export interface WorkingMemoryGetSuccess {
  /** Success discriminator. */
  ok: true;
  /** Action discriminator. */
  action: "get";
  /** Selected working set. */
  workingSet: WorkingSetRecord;
  /** Optional bounded event tail. */
  events?: WorkingEventRecord[];
  /** Full transient projection for the selected set. */
  projection: WorkingContextProjection;
}

/** Successful working-memory list result. */
export interface WorkingMemoryListSuccess {
  /** Success discriminator. */
  ok: true;
  /** Action discriminator. */
  action: "list";
  /** Matching working sets. */
  workingSets: WorkingSetRecord[];
}

/** Successful working-memory create result. */
export interface WorkingMemoryCreateSuccess {
  /** Success discriminator. */
  ok: true;
  /** Action discriminator. */
  action: "create";
  /** Newly created working set. */
  workingSet: WorkingSetRecord;
  /** Event committed for the creation. */
  event: WorkingEventRecord;
  /** Full transient projection after creation. */
  projection: WorkingContextProjection;
}

/** Successful working-memory update result. */
export interface WorkingMemoryUpdateSuccess {
  /** Success discriminator. */
  ok: true;
  /** Action discriminator. */
  action: "update";
  /** Updated working set. */
  workingSet: WorkingSetRecord;
  /** Event committed for semantic mutations; omitted for trusted usage patches. */
  event?: WorkingEventRecord;
  /** Full transient projection after the mutation. */
  projection: WorkingContextProjection;
}

/** Successful working-memory close result. */
export interface WorkingMemoryCloseSuccess {
  /** Success discriminator. */
  ok: true;
  /** Action discriminator. */
  action: "close";
  /** Closed working set. */
  workingSet: WorkingSetRecord;
  /** Terminal event committed for the close. */
  event: WorkingEventRecord;
  /** Candidates retained or emitted for later review. */
  candidates: WorkingCandidate[];
}

/** Successful prepare-before-external-mutation result. */
export interface WorkingMemoryPrepareExternalMutationSuccess {
  /** Success discriminator. */
  ok: true;
  /** Action discriminator. */
  action: "prepare_external_goal_mutation";
  /** Whether an active working set was found and prepared. */
  prepared: boolean;
  /** Active working set after preparation when one matched. */
  workingSet?: WorkingSetRecord;
  /** Events committed during preparation. */
  events: WorkingEventRecord[];
}

/** Result returned by `agenr_work` actions. */
export type WorkingMemoryResult =
  | WorkingMemoryFailure
  | WorkingMemoryGetSuccess
  | WorkingMemoryListSuccess
  | WorkingMemoryCreateSuccess
  | WorkingMemoryUpdateSuccess
  | WorkingMemoryCloseSuccess
  | WorkingMemoryPrepareExternalMutationSuccess;

/** Creates a stable failure result. */
export function createFailure(code: WorkingMemoryErrorCode, message: string, details?: Record<string, unknown>): WorkingMemoryFailure {
  return {
    ok: false,
    code,
    message,
    ...(details ? { details } : {}),
  };
}

/** Maps repository write failures to service failures. */
export function writeFailureToResult(workingSetId: string | undefined, failure: WorkingSetWriteFailure): WorkingMemoryFailure {
  switch (failure.kind) {
    case "not_found":
      return createFailure("not_found", "Working set was not found.", workingSetId ? { workingSetId } : undefined);
    case "revision_conflict":
      return createFailure("revision_conflict", "Working-set revision conflict.", {
        actualRevision: failure.actualRevision,
        ...(workingSetId ? { workingSetId } : {}),
      });
    case "terminal_status":
      return createFailure("terminal_status", `Working set is already ${failure.status}.`, {
        status: failure.status,
        ...(workingSetId ? { workingSetId } : {}),
      });
  }
}
