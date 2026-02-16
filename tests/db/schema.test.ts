import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return Number.NaN;
}

describe("db schema migrations", () => {
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
      "_migrations",
      "entries",
      "tags",
      "relations",
      "ingest_log",
      "entries_fts",
      "idx_entries_embedding",
      "idx_entries_type",
      "idx_entries_expiry",
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
  });

  it("is idempotent when migrations run more than once", async () => {
    const client = makeClient();

    await initDb(client);
    await initDb(client);

    const migrationResult = await client.execute("SELECT version, COUNT(*) AS count FROM _migrations GROUP BY version");
    const countsByVersion = new Map<number, number>();
    for (const row of migrationResult.rows) {
      countsByVersion.set(asNumber(row.version), asNumber(row.count));
    }

    expect(countsByVersion.get(1)).toBe(1);
    expect(countsByVersion.get(2)).toBe(1);
    expect(countsByVersion.get(3)).toBe(1);
    expect(countsByVersion.get(4)).toBe(1);
    expect(countsByVersion.get(5)).toBe(1);
  });

  it("tracks migration version and applied timestamp", async () => {
    const client = makeClient();
    await initDb(client);

    const migrationResult = await client.execute("SELECT version, applied_at FROM _migrations ORDER BY version ASC");
    expect(migrationResult.rows.length).toBe(5);

    for (const row of migrationResult.rows as Array<{ version?: unknown; applied_at?: unknown }>) {
      expect([1, 2, 3, 4, 5]).toContain(asNumber(row.version));
      expect(typeof row.applied_at).toBe("string");
      expect(Number.isNaN(Date.parse(String(row.applied_at)))).toBe(false);
    }
  });

  it("adds content hash columns in migration v2", async () => {
    const client = makeClient();
    await initDb(client);

    const entriesInfo = await client.execute("PRAGMA table_info(entries)");
    const ingestInfo = await client.execute("PRAGMA table_info(ingest_log)");
    const entryColumns = new Set(entriesInfo.rows.map((row) => String(row.name)));
    const ingestColumns = new Set(ingestInfo.rows.map((row) => String(row.name)));

    expect(entryColumns.has("content_hash")).toBe(true);
    expect(ingestColumns.has("content_hash")).toBe(true);
    expect(ingestColumns.has("entries_superseded")).toBe(true);
    expect(ingestColumns.has("dedup_llm_calls")).toBe(true);
  });
});
