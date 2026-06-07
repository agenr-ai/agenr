import { createToolSuccessProjection } from "../projection.js";
import { normalizeEventLimit } from "../limits.js";
import type { WorkingMemoryHandlerContext } from "../handler-context.js";
import type { AgenrWorkParams } from "../mutations.js";
import type { WorkingMemoryResult } from "../results.js";
import { selectWorkingSet } from "../select-working-set.js";

/** Handles the read action. */
export async function handleGet(params: AgenrWorkParams, ctx: WorkingMemoryHandlerContext): Promise<WorkingMemoryResult> {
  const selection = await selectWorkingSet(params, ctx.repository, { policy: ctx.policy });
  if (!selection.ok) {
    return selection;
  }

  const events = params.includeEvents ? await ctx.repository.listWorkingEvents(selection.workingSet.id, normalizeEventLimit(params.eventLimit)) : undefined;
  return {
    ok: true,
    action: "get",
    workingSet: selection.workingSet,
    ...(events ? { events } : {}),
    projection: createToolSuccessProjection(selection.workingSet, "get", ctx.timestamp),
  };
}
