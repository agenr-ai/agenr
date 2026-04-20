import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDatabase } from "../../../adapters/db/client.js";
import { createRecallEvalFixtureStore } from "../../../adapters/db/eval-fixture-store.js";
import { createRecallAdapter } from "../../../adapters/db/recall-adapter.js";
import type { EvalCorpusSeedSnapshotCopy, RecallEvalSandboxRequest, RecallEvalSnapshotMetadata } from "./contracts.js";
import type { RecallEvalSandboxContext } from "./ports.js";

const SANDBOX_DB_FILENAME = "knowledge.db";
const SANDBOX_DIR_PREFIX = "agenr-recall-eval-";

/**
 * Creates the isolated sandbox used for a single recall eval case.
 *
 * When `corpusSeed.mode` is `snapshot_copy`, the source snapshot
 * database is copied into the sandbox root before it is opened. The
 * source snapshot is never opened or mutated here; only the in-sandbox
 * copy is used for recall execution and downstream fixture overlays.
 *
 * @param request - Optional sandbox controls from the eval request.
 * @returns Open sandbox context with an initialized isolated database.
 */
export async function setupRecallEvalSandbox(request: RecallEvalSandboxRequest | undefined): Promise<RecallEvalSandboxContext> {
  const suppliedRoot = request?.root !== undefined;
  const preserved = request?.preserve === true;
  const root = suppliedRoot ? path.resolve(request.root ?? "") : await mkdtemp(path.join(tmpdir(), SANDBOX_DIR_PREFIX));
  const snapshotSeed = request?.corpusSeed?.mode === "snapshot_copy" ? request.corpusSeed : undefined;

  let database: Awaited<ReturnType<typeof createDatabase>> | undefined;
  const dbPath = path.join(root, SANDBOX_DB_FILENAME);

  try {
    if (suppliedRoot) {
      await mkdir(root, { recursive: true });
    }

    await removeDatabaseFiles(dbPath);

    if (snapshotSeed !== undefined) {
      await seedSandboxFromSnapshot(snapshotSeed, dbPath);
    }

    database = await createDatabase(dbPath);
    const openDatabase = database;
    const snapshot: RecallEvalSnapshotMetadata | undefined = snapshotSeed ? buildSnapshotMetadata(snapshotSeed) : undefined;

    return {
      root,
      dbPath,
      preserved,
      fixtureStore: createRecallEvalFixtureStore(openDatabase),
      episodeDatabase: openDatabase,
      procedureDatabase: openDatabase,
      ...(snapshot ? { snapshot } : {}),
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

/**
 * Copies a source corpus snapshot into the sandbox database path. The
 * source is opened only by the filesystem copy; it is never opened as
 * a database, which preserves the Phase 1 safety rule that the source
 * snapshot must never be mutated.
 *
 * @param seed - Validated snapshot-copy seed request.
 * @param dbPath - Target sandbox database path.
 */
async function seedSandboxFromSnapshot(seed: EvalCorpusSeedSnapshotCopy, dbPath: string): Promise<void> {
  const rawPath = seed.snapshotDbPath.trim();
  if (rawPath.length === 0) {
    throw new Error("Snapshot database path must not be empty.");
  }

  const sourcePath = path.resolve(rawPath);
  const targetPath = path.resolve(dbPath);
  if (sourcePath === targetPath) {
    throw new Error("Snapshot database path must not point at the sandbox database path.");
  }

  try {
    await access(sourcePath);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Snapshot database file is not accessible at ${sourcePath}: ${cause}`, {
      cause: error,
    });
  }

  await copyFile(sourcePath, dbPath);
}

/** Builds the response-facing snapshot metadata from a validated seed. */
function buildSnapshotMetadata(seed: EvalCorpusSeedSnapshotCopy): RecallEvalSnapshotMetadata {
  return {
    ...(seed.snapshotId !== undefined ? { id: seed.snapshotId } : {}),
    ...(seed.snapshotLabel !== undefined ? { label: seed.snapshotLabel } : {}),
    dbPathBasename: path.basename(seed.snapshotDbPath),
    allowedTelemetryWrites: seed.allowTelemetryWrites === true,
  };
}

/** Removes a sandbox database file plus its WAL and SHM companions. */
async function removeDatabaseFiles(dbPath: string): Promise<void> {
  await Promise.all([rm(dbPath, { force: true }), rm(`${dbPath}-wal`, { force: true }), rm(`${dbPath}-shm`, { force: true })]);
}
