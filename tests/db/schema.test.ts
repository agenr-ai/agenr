import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import { resetDb } from "../../src/db/schema.js";

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
      "idx_entries_type_canonical_key",
      "idx_entries_expiry",
      "idx_entries_scope",
      "idx_entries_platform",
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
        'idx_entries_type_canonical_key',
        'idx_entries_expiry',
        'idx_entries_scope',
        'idx_entries_platform',
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
    expect(namesResult.rows).toHaveLength(22);
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
    expect(entryColumns.has("canonical_key")).toBe(true);
    expect(entryColumns.has("merged_from")).toBe(true);
    expect(entryColumns.has("consolidated_at")).toBe(true);
    expect(entryColumns.has("platform")).toBe(true);
    expect(entryColumns.has("retired")).toBe(true);
    expect(entryColumns.has("retired_at")).toBe(true);
    expect(entryColumns.has("retired_reason")).toBe(true);
    expect(entryColumns.has("suppressed_contexts")).toBe(true);
    expect(ingestColumns.has("content_hash")).toBe(true);
    expect(ingestColumns.has("entries_superseded")).toBe(true);
    expect(ingestColumns.has("dedup_llm_calls")).toBe(true);
    expect(sourceColumns.has("original_created_at")).toBe(true);
  });

  it("resetDb drops user objects and recreates schema", async () => {
    const client = makeClient();
    await initDb(client);

    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, scope, source_file, source_context, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "entry-1",
        "fact",
        "subject",
        "content",
        5,
        "temporary",
        "private",
        "seed.jsonl",
        "test",
        "2026-02-19T00:00:00.000Z",
        "2026-02-19T00:00:00.000Z",
      ],
    });
    await client.execute("CREATE TABLE IF NOT EXISTS scratch (id TEXT PRIMARY KEY)");

    await resetDb(client);

    const entriesResult = await client.execute("SELECT COUNT(*) AS count FROM entries");
    const entriesCount = Number((entriesResult.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
    expect(entriesCount).toBe(0);

    const scratchResult = await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scratch' LIMIT 1",
      args: [],
    });
    expect(scratchResult.rows).toHaveLength(0);

    const requiredTables = await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)",
      args: ["entries", "ingest_log", "entry_sources"],
    });
    expect(requiredTables.rows.map((row) => String((row as { name?: unknown }).name)).sort()).toEqual([
      "entries",
      "entry_sources",
      "ingest_log",
    ]);
  });

  it("resetDb restores foreign_keys pragma to its previous value", async () => {
    const client = makeClient();
    await initDb(client);
    await client.execute("PRAGMA foreign_keys=ON");

    await resetDb(client);

    const foreignKeysResult = await client.execute("PRAGMA foreign_keys");
    const foreignKeysRow = foreignKeysResult.rows[0] as Record<string, unknown> | undefined;
    const foreignKeysValue = Number(foreignKeysRow?.foreign_keys ?? (foreignKeysRow ? Object.values(foreignKeysRow)[0] : 0));
    expect(foreignKeysValue).toBe(1);
  });
});
