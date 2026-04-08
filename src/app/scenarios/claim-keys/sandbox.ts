import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { createDatabase, type SqlDatabase } from "../../../adapters/db/client.js";

const SANDBOX_DB_FILENAME = "knowledge.db";

/**
 * Open sandbox state for one claim-key scenario run.
 */
export interface ClaimKeyScenarioSandbox {
  root: string;
  dbPath: string;
  database: SqlDatabase;
  cleanup(preserveSandbox: boolean): Promise<void>;
}

/**
 * Creates the isolated sandbox used for a single claim-key scenario.
 *
 * @param root - Sandbox directory path under the scenario artifact directory.
 * @returns Open sandbox context with an initialized isolated database.
 */
export async function createClaimKeyScenarioSandbox(root: string): Promise<ClaimKeyScenarioSandbox> {
  const resolvedRoot = path.resolve(root);
  const dbPath = path.join(resolvedRoot, SANDBOX_DB_FILENAME);

  await mkdir(resolvedRoot, { recursive: true });
  await removeDatabaseFiles(dbPath);

  const database = await createDatabase(dbPath);

  return {
    root: resolvedRoot,
    dbPath,
    database,
    async cleanup(preserveSandbox: boolean): Promise<void> {
      await database.close().catch(() => undefined);

      if (preserveSandbox) {
        return;
      }

      await rm(resolvedRoot, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * Removes a SQLite database file plus its WAL and SHM companions.
 *
 * @param dbPath - SQLite database path to remove.
 */
async function removeDatabaseFiles(dbPath: string): Promise<void> {
  await Promise.all([rm(dbPath, { force: true }), rm(`${dbPath}-wal`, { force: true }), rm(`${dbPath}-shm`, { force: true })]);
}
