import type { DreamPort } from "../../app/dreaming/ports.js";
import {
  findActiveDurablesByClaimKey,
  findExistingNormHashes,
  getDurable,
  getDurables,
  insertDurable,
  closeDurableValidity,
  supersedeDurable,
  updateDurable,
} from "./queries.js";
import {
  completeDreamRun,
  createProfileSnapshot,
  createDreamRun,
  getActiveProfileSnapshot,
  getDailyDreamCost,
  getDreamProposal,
  getLastDreamRun,
  getDreamRunActions,
  getDreamRunProposals,
  getDreamRunHistory,
  getRecentAppliedLightRuns,
  listDreamProposalBacklog,
  logDreamAction,
  logDreamProposal,
  reviewDreamProposal,
  updateDreamState,
} from "./dreaming-run-log.js";
import { heartbeatDreamStateRunLock, releaseDreamStateRunLock, tryAcquireDreamStateRunLock } from "./dreaming-run-lock.js";
import {
  countDurablesCreatedSince,
  countEpisodesSince,
  countIngestFilesSince,
  getDreamHealthStats,
  listActiveClaimKeyContext,
  listEpisodeEvidenceSince,
  listReconcileDurables,
  listSessionHostStoreDurables,
  sumDurableImportanceCreatedSince,
} from "./dreaming-queries.js";
import type { SqlExecutor } from "./queries.js";
import { runImmediateTransaction } from "./transaction.js";

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
    getRecentAppliedLightRuns: async (limit) => getRecentAppliedLightRuns(executor, limit),
    getRunActions: async (runId) => getDreamRunActions(executor, runId),
    getRunProposals: async (runId) => getDreamRunProposals(executor, runId),
    getProposal: async (proposalId) => getDreamProposal(executor, proposalId),
    reviewProposal: async (input) => reviewDreamProposal(executor, input),
    listProposalBacklog: async (query) => listDreamProposalBacklog(executor, query),
    getHealthStats: async (now) => getDreamHealthStats(executor, now),
    getActiveProfileSnapshot: async () => getActiveProfileSnapshot(executor),
    listReconcileDurables: async (query) => listReconcileDurables(executor, query),
    listEpisodeEvidenceSince: async (since, options) => listEpisodeEvidenceSince(executor, since, options),
    listSessionHostStoreDurables: async (sessionId, startedAt, endedAt) => listSessionHostStoreDurables(executor, sessionId, startedAt, endedAt),
    findActiveDurablesByClaimKey: async (claimKey) => findActiveDurablesByClaimKey(executor, claimKey),
    listActiveClaimKeyContext: async (query) => listActiveClaimKeyContext(executor, query),
    findExistingNormContentHashes: async (hashes) => findExistingNormHashes(executor, hashes),
    insertDurable: async (durable, embedding, contentHash) => insertDurable(executor, durable, embedding, contentHash),
    supersedeDurable: async (oldDurableId, newDurableId, kind, reason) => supersedeDurable(executor, oldDurableId, newDurableId, kind, reason),
    getDurable: async (durableId) => getDurable(executor, durableId),
    getDurables: async (durableIds, options) => getDurables(executor, durableIds, options),
    closeDurableValidity: async (durableId, reason) => closeDurableValidity(executor, durableId, reason),
    updateDurable: async (durableId, fields, options) => updateDurable(executor, durableId, fields, options),
    countEpisodesSince: async (since, project) => countEpisodesSince(executor, since, project),
    countIngestFilesSince: async (since) => countIngestFilesSince(executor, since),
    countDurablesCreatedSince: async (since, project) => countDurablesCreatedSince(executor, since, project),
    sumDurableImportanceCreatedSince: async (since, project) => sumDurableImportanceCreatedSince(executor, since, project),
    updateDreamState: async (input) => updateDreamState(executor, input),
    createProfileSnapshot: async (snapshot) => createProfileSnapshot(executor, snapshot),
    tryAcquireRunLock: async (holderToken) => tryAcquireDreamStateRunLock(executor, holderToken, new Date()),
    heartbeatRunLock: async (holderToken) => heartbeatDreamStateRunLock(executor, holderToken, new Date()),
    releaseRunLock: async (holderToken) => releaseDreamStateRunLock(executor, holderToken, new Date()),
    withTransaction: async (fn) => runInDreamTransaction(executor, fn),
  };
}

/**
 * Runs a dreaming callback inside a single write transaction.
 *
 * The transaction is scoped with `BEGIN IMMEDIATE`/`COMMIT` on the same executor
 * (matching the proposal-review write path) rather than libSQL's connection-based
 * transaction API. Keeping every statement on one connection is what makes this
 * correct for in-memory databases, whose schema is per-connection. The callback
 * receives a port bound to that same executor.
 *
 * @param executor - SQL executor backing the dreaming port.
 * @param fn - Callback that performs writes through the transaction-scoped port.
 * @returns Callback result after the transaction commits.
 */
async function runInDreamTransaction<T>(executor: SqlExecutor, fn: (tx: DreamPort) => Promise<T>): Promise<T> {
  return runImmediateTransaction(executor, () => fn(createDreamPort(executor)));
}
