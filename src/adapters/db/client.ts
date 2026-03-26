import fs from "node:fs/promises";
import path from "node:path";

import { createClient, type Client, type Transaction } from "@libsql/client";

import type { DatabasePort } from "../../core/ports.js";
import type { Entry } from "../../core/types.js";
import {
  findExistingHashes,
  getEntries,
  getEntry,
  getIngestLogEntry,
  insertEntry,
  insertIngestLogEntry,
  recordRecallEvent,
  retireEntry,
  type SqlExecutor,
  textSearch,
  updateEntry,
  vectorSearch,
} from "./queries.js";
import { initSchema } from "./schema.js";

const DEFAULT_BUSY_TIMEOUT_MS = 3000;

/**
 * Database adapter contract exposed by the libSQL implementation.
 */
export interface TransactionalDatabasePort extends DatabasePort {
  /**
   * Runs a callback inside a write transaction that begins with `BEGIN IMMEDIATE`.
   *
   * @param fn - Callback that receives a transaction-scoped database adapter.
   * @returns Result returned by the callback after commit succeeds.
   */
  withTransaction<T>(fn: (db: TransactionalDatabasePort) => Promise<T>): Promise<T>;
}

/**
 * Creates and initializes a libSQL-backed database adapter.
 *
 * @param dbPath - SQLite file path or `:memory:` for in-memory tests.
 * @returns Initialized database adapter that implements the core database port.
 */
export async function createDatabase(dbPath: string): Promise<TransactionalDatabasePort> {
  const client = await openClient(dbPath);
  const database = new LibsqlDatabase(client, client);
  await database.init();
  return database;
}

class LibsqlDatabase implements TransactionalDatabasePort {
  public constructor(
    private readonly client: Client,
    private readonly executor: SqlExecutor,
  ) {}

  public async insertEntry(entry: Entry, embedding: number[], contentHash: string): Promise<string> {
    return insertEntry(this.executor, entry, embedding, contentHash);
  }

  public async vectorSearch(embedding: number[], limit: number): Promise<Array<{ id: string; score: number }>> {
    return vectorSearch(this.executor, embedding, limit);
  }

  public async textSearch(query: string, limit: number): Promise<Array<{ id: string; score: number }>> {
    return textSearch(this.executor, query, limit);
  }

  public async getEntries(ids: string[]): Promise<Entry[]> {
    return getEntries(this.executor, ids);
  }

  public async getEntry(id: string): Promise<Entry | null> {
    return getEntry(this.executor, id);
  }

  public async findExistingHashes(hashes: string[]): Promise<Set<string>> {
    return findExistingHashes(this.executor, hashes);
  }

  public async retireEntry(id: string, reason?: string): Promise<boolean> {
    return retireEntry(this.executor, id, reason);
  }

  public async updateEntry(id: string, fields: { importance?: number; expiry?: string }): Promise<boolean> {
    return updateEntry(this.executor, id, fields);
  }

  public async recordRecallEvent(entryId: string, query: string, sessionKey?: string): Promise<void> {
    return recordRecallEvent(this.executor, entryId, query, sessionKey);
  }

  public async getIngestLogEntry(filePath: string): Promise<{ fileHash: string; ingestedAt: string } | null> {
    return getIngestLogEntry(this.executor, filePath);
  }

  public async insertIngestLogEntry(filePath: string, fileHash: string, entryCount: number): Promise<void> {
    return insertIngestLogEntry(this.executor, filePath, fileHash, entryCount);
  }

  public async init(): Promise<void> {
    await initSchema(this.client);
  }

  public async close(): Promise<void> {
    this.client.close();
  }

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
}

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

function resolveClientUrl(dbPath: string): string {
  if (dbPath === ":memory:") {
    return dbPath;
  }

  if (dbPath.startsWith("file:")) {
    return dbPath;
  }
  return `file:${path.resolve(dbPath)}`;
}

async function rollbackTransaction(transaction: Transaction): Promise<void> {
  if (transaction.closed) {
    return;
  }
  await transaction.rollback();
}
