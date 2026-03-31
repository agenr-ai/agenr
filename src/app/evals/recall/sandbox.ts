import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDatabase } from "../../../adapters/db/client.js";
import { createRecallEvalFixtureStore } from "../../../adapters/db/eval-fixture-store.js";
import { createRecallAdapter } from "../../../adapters/db/recall-adapter.js";
import type { RecallEvalSandboxRequest } from "./contracts.js";
import type { RecallEvalSandboxContext } from "./ports.js";

const SANDBOX_DB_FILENAME = "knowledge.db";
const SANDBOX_DIR_PREFIX = "agenr-recall-eval-";

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

  let database: Awaited<ReturnType<typeof createDatabase>> | undefined;
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
      fixtureStore: createRecallEvalFixtureStore(openDatabase),
      createRecallPorts: (embedding) => createRecallAdapter(openDatabase, embedding),
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
