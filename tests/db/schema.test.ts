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
      "idx_tags_tag",
      "idx_relations_source",
      "idx_relations_target",
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

    const migrationResult = await client.execute(
      "SELECT COUNT(*) AS count FROM _migrations WHERE version = 1",
    );
    const count = asNumber(migrationResult.rows[0]?.count);
    expect(count).toBe(1);
  });

  it("tracks migration version and applied timestamp", async () => {
    const client = makeClient();
    await initDb(client);

    const migrationResult = await client.execute(
      "SELECT version, applied_at FROM _migrations WHERE version = 1",
    );

    expect(migrationResult.rows.length).toBe(1);
    const row = migrationResult.rows[0] as { version?: unknown; applied_at?: unknown };
    expect(asNumber(row.version)).toBe(1);
    expect(typeof row.applied_at).toBe("string");
    expect(Number.isNaN(Date.parse(String(row.applied_at)))).toBe(false);
  });
});
