import { createClient, type Client } from "@libsql/client";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearBulkIngestMeta,
  getBulkIngestMeta,
  initSchema,
  rebuildFtsAndTriggers,
  rebuildVectorIndex,
} from "./schema.js";

export const DEFAULT_DB_PATH = path.join(os.homedir(), ".agenr", "knowledge.db");

const walInitByClient = new WeakMap<Client, Promise<void>>();
let didWarnVectorIndexCorruption = false;
const WAL_CHECKPOINT_MAX_ATTEMPTS = 5;
const WAL_CHECKPOINT_RETRY_MS = 50;

function resolveUserPath(inputPath: string): string {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }
  return path.join(os.homedir(), inputPath.slice(1));
}

function resolveDbPath(dbPath: string): string {
  if (dbPath === ":memory:") {
    return dbPath;
  }
  return resolveUserPath(dbPath);
}

function normalizeBackupSourcePath(dbPath: string): string {
  const strippedDbPath = dbPath.startsWith("file:") ? dbPath.slice("file:".length) : dbPath;
  return path.resolve(resolveDbPath(strippedDbPath));
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

async function copySidecarIfPresent(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await fs.copyFile(sourcePath, targetPath);
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

export function buildBackupPath(dbPath: string): string {
  const resolvedDbPath = normalizeBackupSourcePath(dbPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  return path.join(
    path.dirname(resolvedDbPath),
    `${path.basename(resolvedDbPath)}.backup-pre-reset-${timestamp}Z`,
  );
}

export function getDb(dbPath?: string): Client {
  const rawPath = dbPath?.trim() ? dbPath.trim() : DEFAULT_DB_PATH;

  if (rawPath === ":memory:") {
    return createClient({ url: ":memory:" });
  }

  if (rawPath.startsWith("file:")) {
    const client = createClient({ url: rawPath });
    walInitByClient.set(
      client,
      client.execute("PRAGMA journal_mode=WAL")
        .then(() => client.execute("PRAGMA busy_timeout=3000"))
        .then(() => undefined),
    );
    return client;
  }

  const resolvedPath = resolveDbPath(rawPath);
  const client = createClient({ url: `file:${resolvedPath}` });
  walInitByClient.set(
    client,
    client.execute("PRAGMA journal_mode=WAL")
      .then(() => client.execute("PRAGMA busy_timeout=3000"))
      .then(() => undefined),
  );
  return client;
}

function readCount(row: unknown, key = "cnt"): number {
  if (!row || typeof row !== "object") {
    return 0;
  }

  const record = row as Record<string, unknown>;
  const raw = record[key] ?? Object.values(record)[0];
  return toFiniteNumber(raw) ?? 0;
}

function readIntegrityValue(row: unknown): string {
  if (!row || typeof row !== "object") {
    return "";
  }
  const record = row as Record<string, unknown>;
  const raw = record.integrity_check ?? Object.values(record)[0];
  return String(raw ?? "").trim();
}

export async function checkAndRecoverBulkIngest(client: Client): Promise<void> {
  const meta = await getBulkIngestMeta(client);
  if (!meta) {
    return;
  }

  try {
    const triggerCountResult = await client.execute(`
      SELECT COUNT(*) AS cnt
      FROM sqlite_master
      WHERE type = 'trigger' AND name IN ('entries_ai', 'entries_ad', 'entries_au')
    `);
    const triggerCount = readCount(triggerCountResult.rows[0]);

    const indexCountResult = await client.execute(`
      SELECT COUNT(*) AS cnt
      FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_entries_embedding'
    `);
    const indexCount = readCount(indexCountResult.rows[0]);

    process.stderr.write(
      `[agenr] Interrupted bulk ingest detected (phase: ${meta.phase}). Recovering...\n`,
    );

    if (triggerCount < 3) {
      await rebuildFtsAndTriggers(client);
    } else if (indexCount < 1) {
      const entriesCountResult = await client.execute("SELECT COUNT(*) AS cnt FROM entries");
      const ftsCountResult = await client.execute("SELECT COUNT(*) AS cnt FROM entries_fts");
      const entriesCount = readCount(entriesCountResult.rows[0]);
      const ftsCount = readCount(ftsCountResult.rows[0]);
      if (entriesCount > 0 && ftsCount === 0) {
        await client.execute("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')");
      }
    }

    if (indexCount < 1) {
      await rebuildVectorIndex(client);
    }

    try {
      const integrityResult = await client.execute("PRAGMA integrity_check");
      const integrity = readIntegrityValue(integrityResult.rows[0]);
      process.stderr.write(`[agenr] integrity_check: ${integrity || "unknown"}\n`);
    } catch (integrityError) {
      process.stderr.write(
        `[agenr] integrity_check failed: ${integrityError instanceof Error ? integrityError.message : String(integrityError)}\n`,
      );
    }

    await clearBulkIngestMeta(client);
    process.stderr.write("[agenr] Recovery complete.\n");
  } catch (error) {
    throw error;
  }
}

export async function initDb(client: Client, opts?: { checkBulkRecovery?: boolean }): Promise<void> {
  const walInit = walInitByClient.get(client);
  if (walInit) {
    await walInit;
    await client.execute("PRAGMA wal_autocheckpoint=1000");
  }
  await initSchema(client);
  if (opts?.checkBulkRecovery === true) {
    try {
      await checkAndRecoverBulkIngest(client);
    } catch (recoveryError) {
      process.stderr.write(
        `[agenr] Warning: bulk ingest recovery failed: ${recoveryError instanceof Error ? (recoveryError.stack ?? recoveryError.message) : String(recoveryError)}\n` +
        `[agenr] Continuing without recovery. Run 'agenr ingest --bulk' again if FTS or vector search is degraded.\n`,
      );
    }
  }

  // Probe vector index health (best-effort; do not block normal commands).
  try {
    const hasEntries = await client.execute(
      "SELECT 1 FROM entries WHERE embedding IS NOT NULL LIMIT 1",
    );
    if (hasEntries.rows.length > 0) {
      await client.execute(`
        SELECT count(*) FROM vector_top_k(
          'idx_entries_embedding',
          (SELECT embedding FROM entries WHERE embedding IS NOT NULL LIMIT 1),
          1
        )
      `);
    }
  } catch {
    if (!didWarnVectorIndexCorruption) {
      didWarnVectorIndexCorruption = true;
      process.stderr.write(
        "\n⚠️  Vector index may be corrupted. Run `agenr db rebuild-index` to fix.\n\n",
      );
    }
  }
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractBusyFromCheckpointRow(row: unknown): number | null {
  if (!row || typeof row !== "object") {
    return null;
  }

  const record = row as Record<string, unknown>;
  const busyValue = record.busy ?? Object.values(record)[0];
  return toFiniteNumber(busyValue);
}

async function validatedWalCheckpoint(client: Client): Promise<void> {
  for (let attempt = 1; attempt <= WAL_CHECKPOINT_MAX_ATTEMPTS; attempt += 1) {
    const result = await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    const busy = extractBusyFromCheckpointRow(result.rows[0]);

    if (busy === null) {
      throw new Error("WAL checkpoint returned an unexpected result and could not be validated.");
    }

    if (busy === 0) {
      return;
    }

    if (attempt < WAL_CHECKPOINT_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, WAL_CHECKPOINT_RETRY_MS * attempt));
      continue;
    }

    throw new Error(
      `WAL checkpoint did not finish (busy=${busy}). Active readers are blocking backup safety.`,
    );
  }
}

export async function walCheckpoint(client: Client): Promise<void> {
  await validatedWalCheckpoint(client);
}

export async function backupDb(dbPath: string): Promise<string> {
  if (dbPath === ":memory:") {
    throw new Error("Cannot back up in-memory databases.");
  }

  const checkpointClient = getDb(dbPath);
  try {
    await walCheckpoint(checkpointClient);
  } finally {
    closeDb(checkpointClient);
  }

  const resolvedDbPath = normalizeBackupSourcePath(dbPath);
  const backupPath = buildBackupPath(dbPath);

  await fs.copyFile(resolvedDbPath, backupPath);
  await copySidecarIfPresent(`${resolvedDbPath}-wal`, `${backupPath}-wal`);
  await copySidecarIfPresent(`${resolvedDbPath}-shm`, `${backupPath}-shm`);
  return backupPath;
}

export function closeDb(client: Client): void {
  client.close();
}
