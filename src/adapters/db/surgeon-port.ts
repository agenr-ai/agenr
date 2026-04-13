import type { SurgeonPort } from "../../app/surgeon/ports.js";
import { getLastBulkIngestAt } from "./schema.js";
import { getEntry, retireEntry, supersedeEntry, updateEntry } from "./queries.js";
import {
  completeSurgeonRun,
  createSurgeonRun,
  getDailySurgeonCost,
  getLastSurgeonRun,
  getSurgeonProposal,
  getSurgeonRunActions,
  getSurgeonRunProposals,
  getSurgeonRunHistory,
  listSurgeonProposalBacklog,
  logSurgeonAction,
  logSurgeonProposal,
  reviewSurgeonProposal,
} from "./surgeon-run-log.js";
import {
  countSupersessionCandidates,
  countRetirementCandidates,
  getSurgeonHealthStats,
  inspectSurgeonEntry,
  listClaimKeyQualityEntries,
  listRetirementCandidates,
  listSupersessionCandidates,
} from "./surgeon-queries.js";
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
    logRunProposal: async (proposal) => logSurgeonProposal(executor, proposal),
    getLastRun: async () => getLastSurgeonRun(executor),
    getRunHistory: async (limit) => getSurgeonRunHistory(executor, limit),
    getRunActions: async (runId) => getSurgeonRunActions(executor, runId),
    getRunProposals: async (runId) => getSurgeonRunProposals(executor, runId),
    getProposal: async (proposalId) => getSurgeonProposal(executor, proposalId),
    listProposalBacklog: async (query) => listSurgeonProposalBacklog(executor, query),
    getHealthStats: async (options) => getSurgeonHealthStats(executor, options),
    countRetirementCandidates: async (options) => countRetirementCandidates(executor, options),
    listRetirementCandidates: async (query) => listRetirementCandidates(executor, query),
    listSupersessionCandidates: async (query) => listSupersessionCandidates(executor, query),
    countSupersessionCandidates: async (query) => countSupersessionCandidates(executor, query),
    listClaimKeyQualityEntries: async (query) => listClaimKeyQualityEntries(executor, query),
    inspectEntry: async (entryId) => inspectSurgeonEntry(executor, entryId),
    getEntry: async (entryId) => getEntry(executor, entryId),
    retireEntry: async (entryId, reason) => retireEntry(executor, entryId, reason),
    supersedeEntry: async (oldEntryId, newEntryId, kind, reason) => supersedeEntry(executor, oldEntryId, newEntryId, kind, reason),
    updateEntry: async (entryId, fields, options) => updateEntry(executor, entryId, fields, options),
    getLastBulkIngestAt: async () => getLastBulkIngestAt(executor),
    reviewProposal: async (input) => reviewSurgeonProposal(executor, input),
  };
}
