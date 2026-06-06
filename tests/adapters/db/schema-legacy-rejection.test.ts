import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { LEGACY_DB_COLUMNS, legacyColumnReason, missingRequiredTableReason } from "../../../src/adapters/db/schema/legacy-artifacts.js";
import { initSchema } from "../../../src/adapters/db/schema.js";

describe("initSchema legacy rejection", () => {
  const clients: Array<ReturnType<typeof createClient>> = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("rejects legacy database state when the entries table is present", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await client.execute("CREATE TABLE entries (id TEXT PRIMARY KEY)");

    await expect(initSchema(client)).rejects.toThrow(/unsupported agenr database/i);
    await expect(initSchema(client)).rejects.toThrow(/agenr db reset/i);
  });

  it("rejects legacy database state when surgeon tables are present", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await client.execute("CREATE TABLE surgeon_runs (id TEXT PRIMARY KEY)");

    await expect(initSchema(client)).rejects.toThrow(/legacy tables with prefix "surgeon_" are present/i);
  });

  for (const marker of LEGACY_DB_COLUMNS) {
    it(`rejects legacy database state when ${marker.table}.${marker.column} is present`, async () => {
      const client = createClient({ url: ":memory:" });
      clients.push(client);

      await setupLegacyColumnDatabase(client, marker.table, marker.column);

      await expect(initSchema(client)).rejects.toThrow(new RegExp(legacyColumnReason(marker.table, marker.column), "i"));
      await expect(initSchema(client)).rejects.toThrow(/agenr db reset/i);
    });
  }

  it("rejects partially initialized databases that are missing required tables", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await client.execute(MINIMAL_DURABLES_TABLE_SQL);

    await expect(initSchema(client)).rejects.toThrow(new RegExp(missingRequiredTableReason("durables_fts"), "i"));
  });

  it("rejects an existing database without the durables table", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await client.execute(`
      CREATE TABLE dream_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        actions_taken INTEGER DEFAULT 0,
        summary TEXT
      )
    `);

    await expect(initSchema(client)).rejects.toThrow(new RegExp(missingRequiredTableReason("durables"), "i"));
    expect(await tableColumns(client, "dream_run_actions")).toEqual([]);
  });
});

const MINIMAL_DURABLES_TABLE_SQL = `
  CREATE TABLE durables (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    importance INTEGER NOT NULL,
    expiry TEXT NOT NULL,
    tags TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

async function setupLegacyColumnDatabase(client: Client, table: string, column: string): Promise<void> {
  if (table === "durables") {
    await client.execute(`
      CREATE TABLE durables (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER NOT NULL,
        expiry TEXT NOT NULL,
        tags TEXT,
        ${column} TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    return;
  }

  await client.execute(MINIMAL_DURABLES_TABLE_SQL);

  if (table === "dream_runs") {
    await client.execute(`
      CREATE TABLE dream_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ${column} INTEGER DEFAULT 0
      )
    `);
    return;
  }

  if (table === "dream_run_actions") {
    await client.execute(`
      CREATE TABLE dream_run_actions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        ${column} TEXT,
        created_at TEXT NOT NULL
      )
    `);
  }
}

async function tableColumns(client: Client, tableName: string): Promise<string[]> {
  const result = await client.execute(`PRAGMA table_info('${tableName}')`);

  return result.rows.flatMap((row) => {
    const name = row.name;
    return typeof name === "string" ? [name] : [];
  });
}
