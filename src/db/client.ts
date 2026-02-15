import { createClient, type Client } from "@libsql/client";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "./schema.js";

export const DEFAULT_DB_PATH = path.join(os.homedir(), ".agenr", "knowledge.db");

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
    return createClient({ url: rawPath });
  }

  const resolvedPath = resolveDbPath(rawPath);
  return createClient({ url: `file:${resolvedPath}` });
}

export async function initDb(client: Client): Promise<void> {
  await runMigrations(client);
}

export function closeDb(client: Client): void {
  client.close();
}
