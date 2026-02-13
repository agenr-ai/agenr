import { createClient, type Client } from "@libsql/client";

let db: Client | null = null;

export function setDb(client: Client | null): void {
  db = client;
}

export function getDb(): Client {
  if (!db) {
    const url = process.env.AGENR_DB_URL ?? "file:data/agenr.db";
    const authToken = process.env.AGENR_DB_AUTH_TOKEN;
    db = createClient({ url, authToken });
  }

  return db;
}
