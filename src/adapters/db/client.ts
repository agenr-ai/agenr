import fs from "node:fs/promises";
import path from "node:path";

import { createClient, type Client, type InArgs, type InStatement, type ResultSet, type Transaction } from "@libsql/client";

import { resolveLocalFilesystemPath, toAbsoluteFileUrl } from "../../filesystem-path.js";
import type { DatabasePort, EpisodeDatabasePort, ProcedureDatabasePort } from "../../core/ports.js";
import type { EpisodeInput, TemporalWindow } from "../../core/episode/types.js";
import type { Durable, DurableUpdateInput, Episode, EpisodeSource, Procedure } from "../../core/types.js";
import {
  episodeVectorSearch,
  getEpisodeBySourceId,
  getEpisodeByTranscriptHash,
  listEpisodesByTimeWindow,
  listEpisodesWithoutEmbeddings,
  updateEpisodeEmbedding,
  upsertEpisode,
} from "./episode-queries.js";
import {
  closeProcedureValidity,
  findActiveProcedureByKey,
  getProcedure,
  hydrateProcedures,
  listProceduresWithoutEmbeddings,
  procedureFtsSearch,
  procedureVectorSearch,
  replaceProcedureRevision,
  supersedeProcedure,
  updateProcedureEmbedding,
  upsertProcedure,
} from "./procedure-queries.js";
import {
  closeDurableValidity,
  findActiveDurablesByClaimKey,
  getClaimKeyEntityPrefixStats,
  findExistingHashes,
  findExistingNormHashes,
  getClaimKeyExamples,
  getDurables,
  getDistinctClaimKeyPrefixes,
  getDurable,
  getIngestLogEntry,
  insertDurable,
  insertIngestLogEntry,
  supersedeDurable,
  type SqlExecutor,
  updateDurable,
} from "./queries.js";
import { finalizeBulkWrites, initSchema, prepareBulkWrites } from "./schema.js";

const DEFAULT_BUSY_TIMEOUT_MS = 3000;

/**
 * Database adapter contract exposed by the libSQL implementation.
 */
export interface TransactionalDatabasePort extends DatabasePort, EpisodeDatabasePort, ProcedureDatabasePort {
  /**
   * Runs a callback inside a write transaction that begins with `BEGIN IMMEDIATE`.
   *
   * @param fn - Callback that receives a transaction-scoped database adapter.
   * @returns Result returned by the callback after commit succeeds.
   */
  withTransaction<T>(fn: (db: TransactionalDatabasePort) => Promise<T>): Promise<T>;
}

/**
 * libSQL database adapter surface that also exposes raw SQL execution for other adapters.
 */
export interface SqlDatabase extends TransactionalDatabasePort, SqlExecutor {}

/**
 * Creates and initializes a libSQL-backed database adapter.
 *
 * @param dbPath - SQLite file path or `:memory:` for in-memory tests.
 * @returns Initialized database adapter that implements the core database port.
 */
export async function createDatabase(dbPath: string): Promise<SqlDatabase> {
  const client = await openClient(dbPath);
  const database = new LibsqlDatabase(client, client);
  await database.init();
  return database;
}

/** libSQL-backed implementation of the transactional database port. */
class LibsqlDatabase implements SqlDatabase {
  /** Creates a database adapter over a shared client and SQL executor. */
  public constructor(
    private readonly client: Client,
    private readonly executor: SqlExecutor,
  ) {}

  /** Inserts a new entry row and its derived storage fields. */
  public async insertDurable(entry: Durable, embedding: number[], contentHash: string): Promise<string> {
    return insertDurable(this.executor, entry, embedding, contentHash);
  }

  /** Drops indexes and triggers that slow down bulk ingest writes. */
  public async prepareForBulkWrites(): Promise<void> {
    await prepareBulkWrites(this.client);
  }

  /** Restores indexes and triggers after bulk ingest writes complete. */
  public async finalizeBulkWrites(): Promise<void> {
    await finalizeBulkWrites(this.client);
  }

  /** Loads entries by identifier while preserving caller order when possible. */
  public async getDurables(ids: string[]): Promise<Durable[]> {
    return getDurables(this.executor, ids);
  }

  /** Loads a single entry by identifier. */
  public async getDurable(id: string): Promise<Durable | null> {
    return getDurable(this.executor, id);
  }

  /** Finds which exact content hashes already exist in storage. */
  public async findExistingHashes(hashes: string[]): Promise<Set<string>> {
    return findExistingHashes(this.executor, hashes);
  }

  /** Loads one episode by stable `(source, sourceId)` identity. */
  public async getEpisodeBySourceId(source: EpisodeSource, sourceId: string): Promise<Episode | null> {
    return getEpisodeBySourceId(this.executor, source, sourceId);
  }

  /** Loads one episode by fallback `(source, transcriptHash)` identity. */
  public async getEpisodeByTranscriptHash(source: EpisodeSource, transcriptHash: string): Promise<Episode | null> {
    return getEpisodeByTranscriptHash(this.executor, source, transcriptHash);
  }

  /** Inserts or updates an episodic-memory row using normalized change detection. */
  public async upsertEpisode(input: EpisodeInput) {
    return upsertEpisode(this.executor, input);
  }

  /** Lists active episodes whose time range overlaps the requested window. */
  public async listEpisodesByTimeWindow(window: TemporalWindow, limit?: number): Promise<Episode[]> {
    return listEpisodesByTimeWindow(this.executor, window, limit);
  }

  /** Finds active episodes by vector similarity. */
  public async episodeVectorSearch(params: { embedding: number[]; limit: number }): Promise<Array<{ episode: Episode; vectorSim: number }>> {
    return episodeVectorSearch(this.executor, params);
  }

  /** Lists active episodes that are still missing embeddings. */
  public async listEpisodesWithoutEmbeddings(limit?: number): Promise<Episode[]> {
    return listEpisodesWithoutEmbeddings(this.executor, limit);
  }

  /** Updates only the embedding payload for one episode row. */
  public async updateEpisodeEmbedding(id: string, embedding: number[]): Promise<void> {
    await updateEpisodeEmbedding(this.executor, id, embedding);
  }

  /** Inserts or updates one procedure revision row. */
  public async upsertProcedure(procedure: Procedure): Promise<Procedure> {
    return upsertProcedure(this.executor, procedure);
  }

  /** Loads one active procedure by primary key. */
  public async getProcedure(id: string): Promise<Procedure | null> {
    return getProcedure(this.executor, id);
  }

  /** Hydrates active procedures by ID while preserving caller order. */
  public async hydrateProcedures(ids: string[]): Promise<Procedure[]> {
    return hydrateProcedures(this.executor, ids);
  }

  /** Loads one active procedure revision by stable procedure key. */
  public async findActiveProcedureByKey(procedureKey: string): Promise<Procedure | null> {
    return findActiveProcedureByKey(this.executor, procedureKey);
  }

  /** Finds active procedures by vector similarity. */
  public async procedureVectorSearch(params: { embedding: number[]; limit: number }): Promise<Array<{ procedure: Procedure; vectorSim: number }>> {
    return procedureVectorSearch(this.executor, params);
  }

  /** Finds active procedures by lexical FTS search. */
  public async procedureFtsSearch(params: { text: string; limit: number }): Promise<Array<{ procedure: Procedure; rank: number }>> {
    return procedureFtsSearch(this.executor, params);
  }

  /** Lists active procedures that still need embeddings. */
  public async listProceduresWithoutEmbeddings(limit?: number): Promise<Procedure[]> {
    return listProceduresWithoutEmbeddings(this.executor, limit);
  }

  /** Updates only the embedding payload for one procedure row. */
  public async updateProcedureEmbedding(id: string, embedding: number[]): Promise<void> {
    await updateProcedureEmbedding(this.executor, id, embedding);
  }

  /** Closes one active procedure revision's valid-time window. */
  public async closeProcedureValidity(id: string, reason?: string): Promise<boolean> {
    return closeProcedureValidity(this.executor, id, reason);
  }

  /** Marks one active procedure revision as superseded by a newer revision. */
  public async supersedeProcedure(oldId: string, newId: string, reason?: string): Promise<boolean> {
    return supersedeProcedure(this.executor, oldId, newId, reason);
  }

  /** Replaces one active procedure revision with a new revision atomically. */
  public async replaceProcedureRevision(existingId: string, replacement: Procedure, reason?: string): Promise<Procedure> {
    return replaceProcedureRevision(this.executor, existingId, replacement, reason);
  }

  /** Finds which normalized content hashes already exist in storage. */
  public async findExistingNormHashes(hashes: string[]): Promise<Set<string>> {
    return findExistingNormHashes(this.executor, hashes);
  }

  /** Closes one entry's valid-time window so it becomes stale for current recall. */
  public async closeDurableValidity(id: string, reason?: string): Promise<boolean> {
    return closeDurableValidity(this.executor, id, reason);
  }

  /** Marks one active entry as superseded by a newer entry. */
  public async supersedeDurable(oldId: string, newId: string, kind?: string, reason?: string): Promise<boolean> {
    return supersedeDurable(this.executor, oldId, newId, kind, reason);
  }

  /** Finds active entries by exact claim key. */
  public async findActiveDurablesByClaimKey(claimKey: string): Promise<Durable[]> {
    return findActiveDurablesByClaimKey(this.executor, claimKey);
  }

  /** Lists distinct entity prefixes derived from active claim keys. */
  public async getDistinctClaimKeyPrefixes(): Promise<string[]> {
    return getDistinctClaimKeyPrefixes(this.executor);
  }

  /** Lists bounded full claim-key examples ordered for extraction hinting. */
  public async getClaimKeyExamples(limit?: number): Promise<string[]> {
    return getClaimKeyExamples(this.executor, limit);
  }

  /** Lists active per-prefix claim-key counts for conservative alias-family handling. */
  public async getClaimKeyEntityPrefixStats() {
    return getClaimKeyEntityPrefixStats(this.executor);
  }

  /** Updates mutable entry fields such as importance, expiry, and temporal metadata. */
  public async updateDurable(id: string, fields: DurableUpdateInput): Promise<boolean> {
    return updateDurable(this.executor, id, fields);
  }

  /** Looks up the ingest log row for a previously processed file. */
  public async getIngestLogEntry(filePath: string): Promise<{ fileHash: string; ingestedAt: string } | null> {
    return getIngestLogEntry(this.executor, filePath);
  }

  /** Upserts ingest metadata for a processed transcript file. */
  public async insertIngestLogEntry(filePath: string, fileHash: string, durableCount: number): Promise<void> {
    return insertIngestLogEntry(this.executor, filePath, fileHash, durableCount);
  }

  /** Ensures the schema exists before the adapter is used. */
  public async init(): Promise<void> {
    await initSchema(this.client);
  }

  /** Closes the underlying libSQL client. */
  public async close(): Promise<void> {
    this.client.close();
  }

  /** Executes a callback inside a write transaction when supported. */
  public async withTransaction<T>(fn: (db: TransactionalDatabasePort) => Promise<T>): Promise<T> {
    if (this.executor !== this.client) {
      return fn(this);
    }

    const transaction = await this.client.transaction("write");
    const transactionDb = new LibsqlDatabase(this.client, transaction);

    try {
      const result = await fn(transactionDb);
      await transaction.commit();
      return result;
    } catch (error) {
      await rollbackTransaction(transaction);
      throw error;
    } finally {
      transaction.close();
    }
  }

  /** Executes a single SQL statement through the underlying executor. */
  public async execute(stmt: InStatement): Promise<ResultSet>;

  /** Executes a SQL statement with positional or named arguments. */
  public async execute(sql: string, args?: InArgs): Promise<ResultSet>;

  /** Executes one statement through the shared libSQL executor. */
  public async execute(statementOrSql: InStatement | string, args?: InArgs): Promise<ResultSet> {
    if (typeof statementOrSql === "string") {
      return this.executor.execute(statementOrSql, args);
    }

    return this.executor.execute(statementOrSql);
  }
}

/** Opens a libSQL client and applies required SQLite pragmas. */
async function openClient(dbPath: string): Promise<Client> {
  const trimmedPath = dbPath.trim();
  if (trimmedPath.length === 0) {
    throw new Error("Database path must not be empty.");
  }

  const localDbPath = resolveLocalFilesystemPath(trimmedPath);
  if (localDbPath) {
    await fs.mkdir(path.dirname(localDbPath), { recursive: true });
  }

  const client = createClient({ url: resolveClientUrl(trimmedPath) });
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute(`PRAGMA busy_timeout=${DEFAULT_BUSY_TIMEOUT_MS}`);

  if (trimmedPath !== ":memory:") {
    await client.execute("PRAGMA journal_mode=WAL");
  }

  return client;
}

/** Converts a database path into the libSQL client URL format. */
function resolveClientUrl(dbPath: string): string {
  if (dbPath === ":memory:") {
    return dbPath;
  }

  if (dbPath.startsWith("file:")) {
    return dbPath;
  }

  return toAbsoluteFileUrl(dbPath);
}

/** Rolls back an open libSQL transaction when it is still active. */
async function rollbackTransaction(transaction: Transaction): Promise<void> {
  if (transaction.closed) {
    return;
  }
  await transaction.rollback();
}
