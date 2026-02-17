import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initSchema } from "../../src/db/schema.js";

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function columnNames(rows: Array<{ name?: unknown }>): Set<string> {
  return new Set(rows.map((row) => toStringValue(row.name)));
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

  it("fresh DB gets all expected columns", async () => {
    const client = makeClient();
    await initSchema(client);

    const entriesInfo = await client.execute("PRAGMA table_info(entries)");
    const ingestInfo = await client.execute("PRAGMA table_info(ingest_log)");

    const entries = columnNames(entriesInfo.rows as Array<{ name?: unknown }>);
    const ingest = columnNames(ingestInfo.rows as Array<{ name?: unknown }>);

    expect(entries.has("canonical_key")).toBe(true);
    expect(entries.has("scope")).toBe(true);
    expect(entries.has("content_hash")).toBe(true);
    expect(entries.has("merged_from")).toBe(true);
    expect(entries.has("consolidated_at")).toBe(true);

    expect(ingest.has("content_hash")).toBe(true);
    expect(ingest.has("entries_superseded")).toBe(true);
    expect(ingest.has("dedup_llm_calls")).toBe(true);
  });

  it("old schema gets migrated (ALTER TABLE)", async () => {
    const client = makeClient();

    // Minimal historical schema (pre-canonical_key and other later columns).
    await client.execute(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER NOT NULL,
        expiry TEXT NOT NULL,
        source_file TEXT,
        source_context TEXT,
        embedding F32_BLOB(1024),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_recalled_at TEXT,
        recall_count INTEGER DEFAULT 0,
        confirmations INTEGER DEFAULT 0,
        contradictions INTEGER DEFAULT 0,
        superseded_by TEXT,
        FOREIGN KEY (superseded_by) REFERENCES entries(id)
      )
    `);

    await client.execute(`
      CREATE TABLE ingest_log (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        entries_added INTEGER NOT NULL,
        entries_updated INTEGER NOT NULL,
        entries_skipped INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      )
    `);

    await initSchema(client);

    const entriesInfo = await client.execute("PRAGMA table_info(entries)");
    const entriesColumns = entriesInfo.rows as Array<{ name?: unknown; dflt_value?: unknown }>;

    const canonicalKey = entriesColumns.find((row) => toStringValue(row.name) === "canonical_key");
    const scope = entriesColumns.find((row) => toStringValue(row.name) === "scope");
    const contentHash = entriesColumns.find((row) => toStringValue(row.name) === "content_hash");
    const mergedFrom = entriesColumns.find((row) => toStringValue(row.name) === "merged_from");
    const consolidatedAt = entriesColumns.find((row) => toStringValue(row.name) === "consolidated_at");

    expect(canonicalKey).toBeTruthy();
    expect(scope).toBeTruthy();
    expect(toStringValue(scope?.dflt_value)).toContain("private");
    expect(contentHash).toBeTruthy();
    expect(mergedFrom).toBeTruthy();
    expect(toStringValue(mergedFrom?.dflt_value)).toBe("0");
    expect(consolidatedAt).toBeTruthy();

    const ingestInfo = await client.execute("PRAGMA table_info(ingest_log)");
    const ingestColumns = ingestInfo.rows as Array<{ name?: unknown; dflt_value?: unknown }>;

    const ingestHash = ingestColumns.find((row) => toStringValue(row.name) === "content_hash");
    const entriesSuperseded = ingestColumns.find((row) => toStringValue(row.name) === "entries_superseded");
    const dedupLlmCalls = ingestColumns.find((row) => toStringValue(row.name) === "dedup_llm_calls");

    expect(ingestHash).toBeTruthy();
    expect(entriesSuperseded).toBeTruthy();
    expect(toStringValue(entriesSuperseded?.dflt_value)).toBe("0");
    expect(dedupLlmCalls).toBeTruthy();
    expect(toStringValue(dedupLlmCalls?.dflt_value)).toBe("0");
  });

  it("migration is idempotent (safe to run twice)", async () => {
    const client = makeClient();

    await client.execute(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER NOT NULL,
        expiry TEXT NOT NULL,
        source_file TEXT,
        source_context TEXT,
        embedding F32_BLOB(1024),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_recalled_at TEXT,
        recall_count INTEGER DEFAULT 0,
        confirmations INTEGER DEFAULT 0,
        contradictions INTEGER DEFAULT 0,
        superseded_by TEXT,
        FOREIGN KEY (superseded_by) REFERENCES entries(id)
      )
    `);

    await client.execute(`
      CREATE TABLE ingest_log (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        entries_added INTEGER NOT NULL,
        entries_updated INTEGER NOT NULL,
        entries_skipped INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      )
    `);

    await initSchema(client);
    await initSchema(client);

    const entriesInfo = await client.execute("PRAGMA table_info(entries)");
    const entries = columnNames(entriesInfo.rows as Array<{ name?: unknown }>);
    expect(entries.has("canonical_key")).toBe(true);
  });
});

