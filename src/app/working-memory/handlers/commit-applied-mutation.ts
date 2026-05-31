import type { AgenrWorkMutationActor, AgenrWorkMutationSource } from "../constants.js";
import type { AppliedWorkingOperation } from "../apply-operation.js";
import type { WorkingEventType } from "../events.js";
import type { WorkingMemoryRepository, WorkingSetWriteResult } from "../repository.js";

/** Input used to persist one applied working-set mutation. */
export interface CommitAppliedWorkingSetMutationInput {
  /** Working-set id to mutate. */
  workingSetId: string;
  /** Revision observed by the caller. */
  expectedRevision: number;
  /** Event type to append. */
  eventType: WorkingEventType;
  /** JSON-serializable event payload. */
  payload: unknown;
  /** Applied snapshot and row mirrors. */
  applied: AppliedWorkingOperation;
  /** Actor that initiated the mutation. */
  actor?: AgenrWorkMutationActor;
  /** Source surface that emitted the mutation. */
  source?: AgenrWorkMutationSource;
  /** Timestamp to use for row and event creation. */
  now: string;
}

/**
 * Persists one applied working-set mutation through the repository port.
 *
 * @param repository - Working-memory persistence port.
 * @param input - Applied mutation facts and audit metadata.
 * @returns Repository write result.
 */
export async function commitAppliedWorkingSetMutation(
  repository: WorkingMemoryRepository,
  input: CommitAppliedWorkingSetMutationInput,
): Promise<WorkingSetWriteResult> {
  return repository.updateWorkingSet({
    workingSetId: input.workingSetId,
    expectedRevision: input.expectedRevision,
    eventType: input.eventType,
    payload: input.payload,
    status: input.applied.status,
    snapshot: input.applied.snapshot,
    title: input.applied.title,
    objective: input.applied.objective,
    heartbeatAt: input.applied.heartbeatAt,
    leaseOwner: input.applied.leaseOwner,
    leaseExpiresAt: input.applied.leaseExpiresAt,
    actor: input.actor,
    source: input.source,
    now: input.now,
  });
}
