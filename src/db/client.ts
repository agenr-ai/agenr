import { createClient, type Client } from "@libsql/client";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initSchema } from "./schema.js";

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

export function getDb(dbPath?: string): Client {
  const rawPath = dbPath?.trim() ? dbPath.trim() : DEFAULT_DB_PATH;

  if (rawPath === ":memory:") {
    return createClient({ url: ":memory:" });
  }

  if (rawPath.startsWith("file:")) {
    const client = createClient({ url: rawPath });
    walInitByClient.set(client, client.execute("PRAGMA journal_mode=WAL").then(() => undefined));
    return client;
  }

  const resolvedPath = resolveDbPath(rawPath);
  const client = createClient({ url: `file:${resolvedPath}` });
  walInitByClient.set(client, client.execute("PRAGMA journal_mode=WAL").then(() => undefined));
  return client;
}

export async function initDb(client: Client): Promise<void> {
  const walInit = walInitByClient.get(client);
  if (walInit) {
    await walInit;
  }
  await initSchema(client);

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

  const normalizedDbPath = dbPath.startsWith("file:") ? dbPath.slice("file:".length) : dbPath;
  const resolvedDbPath = resolveDbPath(normalizedDbPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const backupPath = path.join(
    path.dirname(resolvedDbPath),
    `${path.basename(resolvedDbPath)}.backup-pre-reset-${timestamp}Z`,
  );

  await fs.copyFile(resolvedDbPath, backupPath);
  return backupPath;
}

export function closeDb(client: Client): void {
  client.close();
}
