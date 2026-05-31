import { buildWorkingCloseSnapshot, resolveCloseTerminalStatus } from "../close-service.js";
import { CLOSE_EVENT_HISTORY_LIMIT } from "../limits.js";
import type { AgenrWorkParams } from "../mutations.js";
import { isWorkingSetWriteFailure, type WorkingMemoryRepository, type WorkingSetWriteResult } from "../repository.js";
import { createFailure, writeFailureToResult, type WorkingMemoryResult } from "../results.js";
import { selectWorkingSet } from "../select-working-set.js";
import { isCloseManagedStatus, isTrustedHostMutationSource } from "../constants.js";
import type { WorkingCandidate } from "../snapshot.js";
import { normalizeRequiredString, resolveExpectedRevision } from "../validation.js";

/** Handles deterministic close. */
export async function handleClose(params: AgenrWorkParams, repository: WorkingMemoryRepository, timestamp: string): Promise<WorkingMemoryResult> {
  if (!isTrustedHostMutationSource(params.source)) {
    return createFailure(
      "close_not_allowed",
      "agenr_work close is reserved for /goal clear. Record progress with merge_checkpoint and leave the working set open.",
    );
  }

  const closeReason = normalizeRequiredString(params.closeReason, "agenr_work close requires closeReason.");
  if (!closeReason.ok) {
    return closeReason;
  }

  const selection = await selectWorkingSet(params, repository);
  if (!selection.ok) {
    return selection;
  }

  const expectedRevision = resolveExpectedRevision(selection.workingSet.revision, params.expectedRevision, params.source);
  if (!expectedRevision.ok) {
    return expectedRevision;
  }

  if (isCloseManagedStatus(selection.workingSet.status)) {
    return createFailure("terminal_status", `Working set ${selection.workingSet.id} is already ${selection.workingSet.status}.`, {
      workingSetId: selection.workingSet.id,
      status: selection.workingSet.status,
    });
  }

  const events = await repository.listWorkingEvents(selection.workingSet.id, CLOSE_EVENT_HISTORY_LIMIT);
  const terminalStatus = resolveCloseTerminalStatus(params.closeMode);
  const closePayload = buildWorkingCloseSnapshot({
    workingSetId: selection.workingSet.id,
    snapshot: selection.workingSet.snapshot,
    currentRevision: selection.workingSet.revision,
    closeReason: closeReason.value,
    createEpisode: params.createEpisode,
    eventSequences: events.map((event) => event.sequence),
    now: timestamp,
  });
  const writeResult = await repository.updateWorkingSet({
    workingSetId: selection.workingSet.id,
    expectedRevision: expectedRevision.value,
    eventType: terminalStatus,
    payload: {
      closeReason: closeReason.value,
      closeMode: params.closeMode ?? "close",
      candidates: closePayload.candidates,
      sourceRef: `working_set:${selection.workingSet.id}#rev:${selection.workingSet.revision}`,
    },
    status: terminalStatus,
    snapshot: closePayload.snapshot,
    title: selection.workingSet.title,
    objective: selection.workingSet.snapshot.objective,
    closedAt: timestamp,
    closeReason: closeReason.value,
    actor: params.actor,
    source: params.source,
    now: timestamp,
  });

  return toCloseResult(selection.workingSet.id, writeResult, closePayload.candidates);
}

/** Maps repository close responses to service results. */
function toCloseResult(workingSetId: string, writeResult: WorkingSetWriteResult, candidates: WorkingCandidate[]): WorkingMemoryResult {
  if (isWorkingSetWriteFailure(writeResult)) {
    return writeFailureToResult(workingSetId, writeResult);
  }

  return {
    ok: true,
    action: "close",
    workingSet: writeResult.workingSet,
    event: writeResult.event,
    candidates,
  };
}
