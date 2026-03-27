import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDatabase, type SqlDatabase } from "../../../adapters/db/client.js";
import type { RecallEvalSandboxRequest } from "./contracts.js";

const SANDBOX_DB_FILENAME = "knowledge.db";
const SANDBOX_DIR_PREFIX = "agenr-recall-eval-";

/**
 * Open isolated sandbox state for a single recall eval case.
 */
export interface RecallEvalSandboxContext {
  /** Sandbox root directory used for the case execution. */
  root: string;
  /** SQLite database path used by the isolated sandbox. */
  dbPath: string;
  /** Whether the sandbox should remain on disk after cleanup. */
  preserved: boolean;
  /** Open database adapter connected to the isolated sandbox database. */
  database: SqlDatabase;
  /**
   * Closes open resources and removes ephemeral sandbox state when needed.
   *
   * @returns Promise that resolves after cleanup finishes.
   */
  cleanup(): Promise<void>;
}

/**
 * Creates the isolated sandbox used for a single recall eval case.
 *
 * @param request - Optional sandbox controls from the eval request.
 * @returns Open sandbox context with an initialized isolated database.
 */
export async function setupRecallEvalSandbox(request: RecallEvalSandboxRequest | undefined): Promise<RecallEvalSandboxContext> {
  const suppliedRoot = request?.root !== undefined;
  const preserved = request?.preserve === true;
  const root = suppliedRoot ? path.resolve(request.root ?? "") : await mkdtemp(path.join(tmpdir(), SANDBOX_DIR_PREFIX));

  let database: SqlDatabase | undefined;
  const dbPath = path.join(root, SANDBOX_DB_FILENAME);

  try {
    if (suppliedRoot) {
      await mkdir(root, { recursive: true });
    }

    await removeDatabaseFiles(dbPath);
    database = await createDatabase(dbPath);
    const openDatabase = database;

    return {
      root,
      dbPath,
      preserved,
      database: openDatabase,
      cleanup: async (): Promise<void> => {
        await openDatabase.close().catch(() => undefined);

        if (preserved) {
          return;
        }

        if (suppliedRoot) {
          await removeDatabaseFiles(dbPath);
          return;
        }

        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await database?.close().catch(() => undefined);

    if (!preserved) {
      if (suppliedRoot) {
        await removeDatabaseFiles(dbPath).catch(() => undefined);
      } else {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    throw error;
  }
}

/** Removes a sandbox database file plus its WAL and SHM companions. */
async function removeDatabaseFiles(dbPath: string): Promise<void> {
  await Promise.all([rm(dbPath, { force: true }), rm(`${dbPath}-wal`, { force: true }), rm(`${dbPath}-shm`, { force: true })]);
}
