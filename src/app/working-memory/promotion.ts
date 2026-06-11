import { isCloseManagedStatus } from "./constants.js";
import type { WorkingSetRecord } from "./records.js";
import { isWorkingSetWriteFailure, type WorkingMemoryRepository, type WorkingSetWriteFailure } from "./repository.js";
import type { WorkingSnapshot } from "./snapshot.js";

/** Result of flipping pending episodic candidates on one snapshot. */
export interface MarkEpisodicCandidatesPromotedResult {
  /** Snapshot copy with pending episodic candidates marked promoted. */
  snapshot: WorkingSnapshot;
  /** True when at least one candidate status changed. */
  changed: boolean;
}

/**
 * Marks every pending episodic candidate on one snapshot as promoted.
 *
 * Durable candidates and already-resolved episodic candidates are untouched.
 *
 * @param snapshot - Closing snapshot persisted by working-set close.
 * @returns Snapshot copy plus a flag indicating whether anything changed.
 */
export function markEpisodicCandidatesPromoted(snapshot: WorkingSnapshot): MarkEpisodicCandidatesPromotedResult {
  const candidates = snapshot.candidates;
  if (!candidates || candidates.length === 0) {
    return { snapshot, changed: false };
  }

  let changed = false;
  const nextCandidates = candidates.map((candidate) => {
    if (candidate.kind !== "episodic" || candidate.promotionStatus !== "pending") {
      return candidate;
    }

    changed = true;
    return { ...candidate, promotionStatus: "promoted" as const };
  });

  if (!changed) {
    return { snapshot, changed: false };
  }

  return {
    snapshot: { ...snapshot, candidates: nextCandidates },
    changed: true,
  };
}

/** Stable reasons an episodic promotion record can fail. */
export type RecordWorkingSetEpisodicPromotionFailureReason = "not_found" | "not_closed" | "revision_conflict";

/** Result of recording one episodic promotion on a closed working set. */
export type RecordWorkingSetEpisodicPromotionResult =
  | { ok: true; workingSet: WorkingSetRecord; changed: boolean }
  | { ok: false; reason: RecordWorkingSetEpisodicPromotionFailureReason };

/**
 * Records a successful episodic promotion on one close-managed working set.
 *
 * Flips pending episodic candidates to `promoted` and stores the emitted
 * episode id. The episode write itself must already have gone through the
 * episode subsystem; this call only records the outcome. The write is
 * idempotent: when nothing would change, no row update happens.
 *
 * @param repository - Working-memory persistence port.
 * @param input - Closed working-set id, emitted episode id, and timestamp.
 * @returns Updated working set, or a stable failure reason.
 */
export async function recordWorkingSetEpisodicPromotion(
  repository: WorkingMemoryRepository,
  input: { workingSetId: string; episodeId: string; now: string },
): Promise<RecordWorkingSetEpisodicPromotionResult> {
  const workingSet = await repository.getWorkingSet(input.workingSetId);
  if (!workingSet) {
    return { ok: false, reason: "not_found" };
  }

  if (!isCloseManagedStatus(workingSet.status)) {
    return { ok: false, reason: "not_closed" };
  }

  const marked = markEpisodicCandidatesPromoted(workingSet.snapshot);
  if (!marked.changed && workingSet.episodeId === input.episodeId) {
    return { ok: true, workingSet, changed: false };
  }

  const writeResult = await repository.recordEpisodePromotion({
    workingSetId: workingSet.id,
    expectedRevision: workingSet.revision,
    snapshot: marked.snapshot,
    episodeId: input.episodeId,
    now: input.now,
  });
  if (isWorkingSetWriteFailure(writeResult)) {
    return { ok: false, reason: mapWriteFailureReason(writeResult) };
  }

  return { ok: true, workingSet: writeResult.workingSet, changed: true };
}

/** Maps repository write failures to stable promotion failure reasons. */
function mapWriteFailureReason(failure: WorkingSetWriteFailure): RecordWorkingSetEpisodicPromotionFailureReason {
  switch (failure.kind) {
    case "not_found":
      return "not_found";
    case "revision_conflict":
      return "revision_conflict";
    case "terminal_status":
      return "not_closed";
    default: {
      const exhaustive: never = failure;
      throw new Error(`Unhandled working-set write failure: ${JSON.stringify(exhaustive)}`);
    }
  }
}
