import { createClient, type Client } from "@libsql/client";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "./schema.js";

export const DEFAULT_DB_PATH = path.join(os.homedir(), ".agenr", "knowledge.db");

const walInitByClient = new WeakMap<Client, Promise<void>>();

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
  await runMigrations(client);
}

export async function walCheckpoint(client: Client): Promise<void> {
  await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
}

export function closeDb(client: Client): void {
  client.close();
}
