import type { DreamPort } from "../../app/dreaming/ports.js";
import { updateDurable } from "./queries.js";
import {
  completeDreamRun,
  createDreamRun,
  getDailyDreamCost,
  getLastDreamRun,
  getDreamRunActions,
  getDreamRunProposals,
  getDreamRunHistory,
  listDreamProposalBacklog,
  logDreamAction,
  logDreamProposal,
  updateDreamState,
} from "./dreaming-run-log.js";
import { countDurablesCreatedSince, countEpisodesSince, countIngestFilesSince, getDreamHealthStats, listReconcileDurables } from "./dreaming-queries.js";
import type { SqlExecutor } from "./queries.js";

/**
 * Creates the DB-backed dreaming persistence boundary.
 *
 * @param executor - SQL executor used for all dreaming persistence and query operations.
 * @returns Dream port implemented on top of the DB adapter.
 */
export function createDreamPort(executor: SqlExecutor): DreamPort {
  return {
    getDailyCost: async (now) => getDailyDreamCost(executor, now),
    createRun: async (run) => createDreamRun(executor, run),
    completeRun: async (runId, result) => completeDreamRun(executor, runId, result),
    logRunAction: async (action) => logDreamAction(executor, action),
    logRunProposal: async (proposal) => logDreamProposal(executor, proposal),
    getLastRun: async () => getLastDreamRun(executor),
    getRunHistory: async (limit) => getDreamRunHistory(executor, limit),
    getRunActions: async (runId) => getDreamRunActions(executor, runId),
    getRunProposals: async (runId) => getDreamRunProposals(executor, runId),
    listProposalBacklog: async (query) => listDreamProposalBacklog(executor, query),
    getHealthStats: async (now) => getDreamHealthStats(executor, now),
    listReconcileDurables: async (query) => listReconcileDurables(executor, query),
    updateDurable: async (durableId, fields, options) => updateDurable(executor, durableId, fields, options),
    countEpisodesSince: async (since, project) => countEpisodesSince(executor, since, project),
    countIngestFilesSince: async (since) => countIngestFilesSince(executor, since),
    countDurablesCreatedSince: async (since, project) => countDurablesCreatedSince(executor, since, project),
    updateDreamState: async (input) => updateDreamState(executor, input),
  };
}
