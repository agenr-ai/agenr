import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";

describe("db schema", () => {
  const clients: Client[] = [];

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
  });

  function makeClient(): Client {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    return client;
  }

  it("creates all tables, indexes, and triggers", async () => {
    const client = makeClient();
    await initDb(client);

    const expectedObjects = [
      "entries",
      "tags",
      "relations",
      "ingest_log",
      "entry_sources",
      "entries_fts",
      "idx_entries_embedding",
      "idx_entries_type",
      "idx_entries_expiry",
      "idx_entries_scope",
      "idx_entries_created",
      "idx_entries_superseded",
      "idx_entries_content_hash",
      "idx_tags_tag",
      "idx_relations_source",
      "idx_relations_target",
      "idx_ingest_log_file_hash",
      "entries_ai",
      "entries_ad",
      "entries_au",
    ];

    const placeholders = expectedObjects.map(() => "?").join(", ");
    const schemaResult = await client.execute({
      sql: `SELECT name FROM sqlite_master WHERE name IN (${placeholders})`,
      args: expectedObjects,
    });

    const actualObjects = new Set(schemaResult.rows.map((row) => String(row.name)));
    for (const expectedName of expectedObjects) {
      expect(actualObjects.has(expectedName)).toBe(true);
    }

    const migrationsTable = await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE name = ?",
      args: ["_migrations"],
    });
    expect(migrationsTable.rows).toHaveLength(0);
  });

  it("is idempotent when schema init runs more than once", async () => {
    const client = makeClient();

    await initDb(client);
    await initDb(client);

    const namesResult = await client.execute(`
      SELECT name, COUNT(*) AS count
      FROM sqlite_master
      WHERE name IN (
        'entries',
        'tags',
        'relations',
        'ingest_log',
        'entry_sources',
        'entries_fts',
        'idx_entries_embedding',
        'idx_entries_type',
        'idx_entries_expiry',
        'idx_entries_scope',
        'idx_entries_created',
        'idx_entries_superseded',
        'idx_entries_content_hash',
        'idx_tags_tag',
        'idx_relations_source',
        'idx_relations_target',
        'idx_ingest_log_file_hash',
        'entries_ai',
        'entries_ad',
        'entries_au'
      )
      GROUP BY name
    `);
    expect(namesResult.rows).toHaveLength(20);
    for (const row of namesResult.rows as Array<{ count?: unknown }>) {
      expect(Number(row.count)).toBe(1);
    }
  });

  it("creates all final schema columns", async () => {
    const client = makeClient();
    await initDb(client);

    const entriesInfo = await client.execute("PRAGMA table_info(entries)");
    const ingestInfo = await client.execute("PRAGMA table_info(ingest_log)");
    const sourceInfo = await client.execute("PRAGMA table_info(entry_sources)");
    const entryColumns = new Set(entriesInfo.rows.map((row) => String(row.name)));
    const ingestColumns = new Set(ingestInfo.rows.map((row) => String(row.name)));
    const sourceColumns = new Set(sourceInfo.rows.map((row) => String(row.name)));

    expect(entryColumns.has("content_hash")).toBe(true);
    expect(entryColumns.has("merged_from")).toBe(true);
    expect(entryColumns.has("consolidated_at")).toBe(true);
    expect(ingestColumns.has("content_hash")).toBe(true);
    expect(ingestColumns.has("entries_superseded")).toBe(true);
    expect(ingestColumns.has("dedup_llm_calls")).toBe(true);
    expect(sourceColumns.has("original_created_at")).toBe(true);
  });
});
