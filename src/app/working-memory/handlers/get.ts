import { createToolSuccessProjection } from "../projection.js";
import { normalizeEventLimit } from "../limits.js";
import type { AgenrWorkParams } from "../mutations.js";
import type { WorkingMemoryRepository } from "../repository.js";
import type { WorkingMemoryResult } from "../results.js";
import { selectWorkingSet } from "../select-working-set.js";

/** Handles the read action. */
export async function handleGet(params: AgenrWorkParams, repository: WorkingMemoryRepository, timestamp: string): Promise<WorkingMemoryResult> {
  const selection = await selectWorkingSet(params, repository);
  if (!selection.ok) {
    return selection;
  }

  const events = params.includeEvents ? await repository.listWorkingEvents(selection.workingSet.id, normalizeEventLimit(params.eventLimit)) : undefined;
  return {
    ok: true,
    action: "get",
    workingSet: selection.workingSet,
    ...(events ? { events } : {}),
    projection: createToolSuccessProjection(selection.workingSet, "get", timestamp),
  };
}
