import type { WorkingMemoryResult } from "../../app/working-memory/results.js";
import type { WorkingSetRecord } from "../../app/working-memory/records.js";
import { readGoalGeneration } from "../../app/working-memory/goal-generation.js";

/**
 * Builds structured tool details for agenr_work get responses and related host surfaces.
 *
 * @param workingSet - Loaded working set.
 * @param eventsReturned - Number of recent events included in the response payload.
 * @returns Structured details payload.
 */
export function buildWorkingSetGetDetails(workingSet: WorkingSetRecord, eventsReturned = 0): Record<string, unknown> {
  return {
    status: "ok",
    action: "get",
    workingSetId: workingSet.id,
    revision: workingSet.revision,
    goalGeneration: readGoalGeneration(workingSet.snapshot),
    goalStatus: workingSet.status,
    objective: workingSet.snapshot.objective ?? workingSet.objective ?? null,
    checkpoint: workingSet.snapshot.checkpoint ?? null,
    continuation: workingSet.snapshot.continuation ?? null,
    budgets: workingSet.snapshot.budgets ?? null,
    eventsReturned,
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
        workingSets: result.workingSets.map((set) => ({
          workingSetId: set.id,
          revision: set.revision,
          scopeKind: set.scopeKind,
          scopeKey: set.scopeKey,
          status: set.status,
          objective: set.snapshot.objective ?? set.objective ?? null,
          title: set.title ?? null,
          lastActiveAt: set.lastActiveAt,
        })),
      };
    case "create":
      return {
        status: "ok",
        action: "create",
        workingSetId: result.workingSet.id,
        revision: result.workingSet.revision,
        goalGeneration: readGoalGeneration(result.workingSet.snapshot),
      };
    case "update":
      return {
        status: "ok",
        action: "update",
        workingSetId: result.workingSet.id,
        revision: result.workingSet.revision,
        goalGeneration: readGoalGeneration(result.workingSet.snapshot),
      };
    case "close":
      return {
        status: "ok",
        action: "close",
        workingSetId: result.workingSet.id,
        revision: result.workingSet.revision,
        goalGeneration: readGoalGeneration(result.workingSet.snapshot),
        candidateCount: result.candidates.length,
      };
    case "prepare_external_goal_mutation":
      return {
        status: "ok",
        action: "prepare_external_goal_mutation",
        prepared: result.prepared,
        workingSetId: result.workingSet?.id ?? null,
        revision: result.workingSet?.revision ?? null,
        eventsReturned: result.events.length,
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
