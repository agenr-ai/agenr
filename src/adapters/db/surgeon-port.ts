import type { SurgeonPort } from "../../app/surgeon/ports.js";
import { getLastBulkIngestAt } from "./schema.js";
import { getEntry, retireEntry, updateEntry } from "./queries.js";
import {
  completeSurgeonRun,
  createSurgeonRun,
  getDailySurgeonCost,
  getLastSurgeonRun,
  getSurgeonRunActions,
  getSurgeonRunHistory,
  logSurgeonAction,
} from "./surgeon-run-log.js";
import { countRetirementCandidates, getSurgeonHealthStats, inspectSurgeonEntry, listRetirementCandidates } from "./surgeon-queries.js";
import type { SqlExecutor } from "./queries.js";

/**
 * Creates the DB-backed surgeon persistence boundary.
 *
 * @param executor - SQL executor used for all surgeon persistence and query operations.
 * @returns Surgeon port implemented on top of the DB adapter.
 */
export function createSurgeonPort(executor: SqlExecutor): SurgeonPort {
  return {
    getDailyCost: async (now) => getDailySurgeonCost(executor, now),
    createRun: async (run) => createSurgeonRun(executor, run),
    completeRun: async (runId, result) => completeSurgeonRun(executor, runId, result),
    logRunAction: async (action) => logSurgeonAction(executor, action),
    getLastRun: async () => getLastSurgeonRun(executor),
    getRunHistory: async (limit) => getSurgeonRunHistory(executor, limit),
    getRunActions: async (runId) => getSurgeonRunActions(executor, runId),
    getHealthStats: async (options) => getSurgeonHealthStats(executor, options),
    countRetirementCandidates: async (options) => countRetirementCandidates(executor, options),
    listRetirementCandidates: async (query) => listRetirementCandidates(executor, query),
    inspectEntry: async (entryId) => inspectSurgeonEntry(executor, entryId),
    getEntry: async (entryId) => getEntry(executor, entryId),
    retireEntry: async (entryId, reason) => retireEntry(executor, entryId, reason),
    updateEntry: async (entryId, fields) => updateEntry(executor, entryId, fields),
    getLastBulkIngestAt: async () => getLastBulkIngestAt(executor),
  };
}
