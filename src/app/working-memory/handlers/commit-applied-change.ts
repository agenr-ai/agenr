import type { AgenrWorkMutationActor, AgenrWorkMutationSource, WorkingSetStatus } from "../constants.js";
import type { AppliedWorkingOperation } from "../apply-operation.js";
import type { AgenrWorkUpdateOperation } from "../mutations.js";
import type { WorkingEventRecord, WorkingSetRecord } from "../records.js";
import {
  isWorkingSetWriteFailure,
  type PatchWorkingSetUsageInput,
  type UpdateWorkingSetInput,
  type WorkingMemoryRepository,
  type WorkingSetWriteFailure,
} from "../repository.js";

/** Input used to persist one applied working-set change. */
export interface CommitAppliedWorkingSetChangeInput {
  /** Working-set id to mutate. */
  workingSetId: string;
  /** Revision observed by the caller. */
  expectedRevision: number;
  /** Typed operation that produced the applied snapshot. */
  operation: AgenrWorkUpdateOperation;
  /** Status observed before applying the operation. */
  previousStatus: WorkingSetStatus;
  /** Audit reason stored with semantic mutations. */
  updateReason: string;
  /** Applied snapshot and row mirrors. */
  applied: AppliedWorkingOperation;
  /** Actor that initiated the mutation. */
  actor?: AgenrWorkMutationActor;
  /** Source surface that emitted the mutation. */
  source?: AgenrWorkMutationSource;
  /** Timestamp to use for row and event updates. */
  now: string;
}

/** Successful usage patch commit. */
export interface AppliedWorkingSetUsagePatchCommit {
  /** Commit discriminator. */
  type: "usage_patch";
  /** Updated working set after the patch is committed. */
  workingSet: WorkingSetRecord;
  /** Audit event written when the usage patch caused a status transition. */
  event?: WorkingEventRecord;
}

/** Successful semantic mutation commit. */
export interface AppliedWorkingSetSemanticCommit {
  /** Commit discriminator. */
  type: "semantic";
  /** Updated working set after the event is committed. */
  workingSet: WorkingSetRecord;
  /** Event written for the mutation. */
  event: WorkingEventRecord;
}

/** Successful commit response for one applied working-set change. */
export type AppliedWorkingSetCommitResult = AppliedWorkingSetUsagePatchCommit | AppliedWorkingSetSemanticCommit;

/** Repository commit response for one applied working-set change. */
export type CommitAppliedWorkingSetChangeResult = AppliedWorkingSetCommitResult | WorkingSetWriteFailure;

/** Repository inputs derived from one applied working-set change. */
export interface AppliedWorkingSetRepositoryInputs {
  /** Usage-patch input when the operation is trusted usage accounting. */
  usagePatch?: PatchWorkingSetUsageInput;
  /** Semantic-update input when the operation advances revision and writes an event. */
  semanticUpdate?: UpdateWorkingSetInput;
}

/** Returns true when a commit result is a repository write failure. */
export function isAppliedWorkingSetCommitFailure(result: CommitAppliedWorkingSetChangeResult): result is WorkingSetWriteFailure {
  return "kind" in result;
}

/**
 * Persists one applied working-set change, routing usage patches without revision bumps.
 *
 * @param repository - Working-memory persistence port.
 * @param input - Applied operation facts and audit metadata.
 * @returns Updated row, optional event, or a stable write failure.
 */
export async function commitAppliedWorkingSetChange(
  repository: WorkingMemoryRepository,
  input: CommitAppliedWorkingSetChangeInput,
): Promise<CommitAppliedWorkingSetChangeResult> {
  const repositoryInputs = buildCommitAppliedWorkingSetChangeInput(input);
  if (repositoryInputs.usagePatch) {
    const writeResult = await repository.patchWorkingSetUsage(repositoryInputs.usagePatch);
    if (isWorkingSetWriteFailure(writeResult)) {
      return writeResult;
    }

    return {
      type: "usage_patch",
      workingSet: writeResult.workingSet,
      ...(writeResult.event ? { event: writeResult.event } : {}),
    };
  }

  if (!repositoryInputs.semanticUpdate) {
    throw new Error(`Unsupported working-set commit operation: ${input.operation.type}`);
  }

  const writeResult = await repository.updateWorkingSet(repositoryInputs.semanticUpdate);
  if (isWorkingSetWriteFailure(writeResult)) {
    return writeResult;
  }

  return {
    type: "semantic",
    workingSet: writeResult.workingSet,
    event: writeResult.event,
  };
}

/**
 * Builds repository-specific inputs for one applied working-set change.
 *
 * @param input - Applied operation facts and audit metadata.
 * @returns Exactly one repository input for the operation kind.
 */
export function buildCommitAppliedWorkingSetChangeInput(input: CommitAppliedWorkingSetChangeInput): AppliedWorkingSetRepositoryInputs {
  if (input.operation.type === "account_usage") {
    return {
      usagePatch: {
        workingSetId: input.workingSetId,
        expectedRevision: input.expectedRevision,
        status: input.applied.status,
        snapshot: input.applied.snapshot,
        title: input.applied.title,
        objective: input.applied.objective,
        auditEvent:
          input.previousStatus !== "budget_limited" && input.applied.status === "budget_limited"
            ? {
                eventType: "account_usage",
                payload: {
                  operation: input.operation,
                  updateReason: input.updateReason,
                  statusTransition: {
                    from: input.previousStatus,
                    to: "budget_limited",
                  },
                },
                actor: input.actor,
                source: input.source,
              }
            : undefined,
        now: input.now,
      },
    };
  }

  return {
    semanticUpdate: {
      workingSetId: input.workingSetId,
      expectedRevision: input.expectedRevision,
      eventType: input.operation.type,
      payload: {
        operation: input.operation,
        updateReason: input.updateReason,
      },
      status: input.applied.status,
      snapshot: input.applied.snapshot,
      title: input.applied.title,
      objective: input.applied.objective,
      actor: input.actor,
      source: input.source,
      now: input.now,
    },
  };
}
