import type { WorkingMemoryResult } from "../../app/working-memory/results.js";
import type { WorkingSetRecord } from "../../app/working-memory/records.js";

/**
 * Builds structured tool details for agenr_work get responses and related host surfaces.
 *
 * @param workingSet - Loaded working set.
 * @param eventCount - Optional recent event count included in the response.
 * @returns Structured details payload.
 */
export function buildWorkingSetGetDetails(workingSet: WorkingSetRecord, eventCount = 0): Record<string, unknown> {
  return {
    status: "ok",
    action: "get",
    workingSetId: workingSet.id,
    revision: workingSet.revision,
    goalStatus: workingSet.status,
    objective: workingSet.snapshot.objective ?? workingSet.objective ?? null,
    checkpoint: workingSet.snapshot.checkpoint ?? null,
    continuation: workingSet.snapshot.continuation ?? null,
    budgets: workingSet.snapshot.budgets ?? null,
    eventCount,
  };
}

/** Builds structured tool details for one working-memory service result. */
export function buildWorkingMemoryDetails(result: WorkingMemoryResult): Record<string, unknown> {
  if (!result.ok) {
    return {
      status: "failed",
      code: result.code,
      ...(result.details ? { details: result.details } : {}),
    };
  }

  switch (result.action) {
    case "get":
      return buildWorkingSetGetDetails(result.workingSet, result.events?.length ?? 0);
    case "list":
      return {
        status: "ok",
        action: "list",
        count: result.workingSets.length,
        workingSetIds: result.workingSets.map((set) => set.id),
      };
    case "create":
      return {
        status: "ok",
        action: "create",
        workingSetId: result.workingSet.id,
        revision: result.workingSet.revision,
      };
    case "update":
      return {
        status: "ok",
        action: "update",
        workingSetId: result.workingSet.id,
        revision: result.workingSet.revision,
      };
    case "close":
      return {
        status: "ok",
        action: "close",
        workingSetId: result.workingSet.id,
        revision: result.workingSet.revision,
        candidateCount: result.candidates.length,
      };
    case "prepare_external_goal_mutation":
      return {
        status: "ok",
        action: "prepare_external_goal_mutation",
        prepared: result.prepared,
        workingSetId: result.workingSet?.id ?? null,
        revision: result.workingSet?.revision ?? null,
        eventCount: result.events.length,
      };
  }
}

/** Formats a working-memory service result for host adapters. */
export function formatWorkingMemoryResultText(result: WorkingMemoryResult): string {
  if (!result.ok) {
    return `agenr_work failed: ${result.message}`;
  }

  switch (result.action) {
    case "get":
      return result.projection.content;
    case "list":
      if (result.workingSets.length === 0) {
        return "No working sets matched.";
      }

      return result.workingSets.map((set) => `${set.id} rev ${set.revision} ${set.status}: ${set.snapshot.objective ?? set.title ?? set.scopeKey}`).join("\n");
    case "create":
      return `Created working set ${result.workingSet.id} at revision ${result.workingSet.revision}.`;
    case "update":
      return `Updated working set ${result.workingSet.id} at revision ${result.workingSet.revision}.`;
    case "close":
      return `Closed working set ${result.workingSet.id} at revision ${result.workingSet.revision}. Candidates: ${result.candidates.length}.`;
    case "prepare_external_goal_mutation":
      if (!result.prepared || !result.workingSet) {
        return "No active working set required external mutation preparation.";
      }

      return `Prepared working set ${result.workingSet.id} at revision ${result.workingSet.revision}. Events: ${result.events.length}.`;
  }
}
