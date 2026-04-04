import fs from "node:fs/promises";
import path from "node:path";

import { createClient, type Client, type InArgs, type InStatement, type ResultSet, type Transaction } from "@libsql/client";

import type { DatabasePort, EpisodeDatabasePort } from "../../core/ports.js";
import type { EpisodeInput, TemporalWindow } from "../../core/episode/types.js";
import type { Entry } from "../../core/types.js";
import type { Episode, EpisodeSource } from "../../core/types.js";
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
  findActiveEntriesByClaimKey,
  findExistingHashes,
  findExistingNormHashes,
  getClaimKeyExamples,
  getEntries,
  getDistinctClaimKeyPrefixes,
  getEntry,
  getIngestLogEntry,
  insertEntry,
  insertIngestLogEntry,
  retireEntry,
  supersedeEntry,
  type SqlExecutor,
  updateEntry,
} from "./queries.js";
import { finalizeBulkWrites, initSchema, prepareBulkWrites } from "./schema.js";

const DEFAULT_BUSY_TIMEOUT_MS = 3000;

/**
 * Database adapter contract exposed by the libSQL implementation.
 */
export interface TransactionalDatabasePort extends DatabasePort, EpisodeDatabasePort {
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
  public async insertEntry(entry: Entry, embedding: number[], contentHash: string): Promise<string> {
    return insertEntry(this.executor, entry, embedding, contentHash);
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
  public async getEntries(ids: string[]): Promise<Entry[]> {
    return getEntries(this.executor, ids);
  }

  /** Loads a single entry by identifier. */
  public async getEntry(id: string): Promise<Entry | null> {
    return getEntry(this.executor, id);
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

  /** Finds which normalized content hashes already exist in storage. */
  public async findExistingNormHashes(hashes: string[]): Promise<Set<string>> {
    return findExistingNormHashes(this.executor, hashes);
  }

  /** Marks an entry as retired with an optional reason. */
  public async retireEntry(id: string, reason?: string): Promise<boolean> {
    return retireEntry(this.executor, id, reason);
  }

  /** Marks one active entry as superseded by a newer entry. */
  public async supersedeEntry(oldId: string, newId: string, kind?: string, reason?: string): Promise<boolean> {
    return supersedeEntry(this.executor, oldId, newId, kind, reason);
  }

  /** Finds active entries by exact claim key. */
  public async findActiveEntriesByClaimKey(claimKey: string): Promise<Entry[]> {
    return findActiveEntriesByClaimKey(this.executor, claimKey);
  }

  /** Lists distinct entity prefixes derived from active claim keys. */
  public async getDistinctClaimKeyPrefixes(): Promise<string[]> {
    return getDistinctClaimKeyPrefixes(this.executor);
  }

  /** Lists bounded full claim-key examples ordered for extraction hinting. */
  public async getClaimKeyExamples(limit?: number): Promise<string[]> {
    return getClaimKeyExamples(this.executor, limit);
  }

  /** Updates mutable entry fields such as importance, expiry, and temporal metadata. */
  public async updateEntry(
    id: string,
    fields: { importance?: number; expiry?: string; claim_key?: string; valid_from?: string; valid_to?: string },
  ): Promise<boolean> {
    return updateEntry(this.executor, id, fields);
  }

  /** Looks up the ingest log row for a previously processed file. */
  public async getIngestLogEntry(filePath: string): Promise<{ fileHash: string; ingestedAt: string } | null> {
    return getIngestLogEntry(this.executor, filePath);
  }

  /** Upserts ingest metadata for a processed transcript file. */
  public async insertIngestLogEntry(filePath: string, fileHash: string, entryCount: number): Promise<void> {
    return insertIngestLogEntry(this.executor, filePath, fileHash, entryCount);
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

  if (trimmedPath !== ":memory:" && !trimmedPath.startsWith("file:")) {
    const resolvedPath = path.resolve(trimmedPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
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
  return `file:${path.resolve(dbPath)}`;
}

/** Rolls back an open libSQL transaction when it is still active. */
async function rollbackTransaction(transaction: Transaction): Promise<void> {
  if (transaction.closed) {
    return;
  }
  await transaction.rollback();
}
