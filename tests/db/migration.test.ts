import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initSchema } from "../../src/db/schema.js";
import { APP_VERSION } from "../../src/version.js";

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
    expect(entries.has("platform")).toBe(true);
    expect(entries.has("project")).toBe(true);

    expect(ingest.has("content_hash")).toBe(true);
    expect(ingest.has("entries_superseded")).toBe(true);
    expect(ingest.has("dedup_llm_calls")).toBe(true);
  });

  it("fresh DB gets schema version stamp", async () => {
    const client = makeClient();
    await initSchema(client);

    const metaInfo = await client.execute("PRAGMA table_info(_meta)");
    expect(columnNames(metaInfo.rows as Array<{ name?: unknown }>).has("key")).toBe(true);

    const versionRow = await client.execute({
      sql: "SELECT value FROM _meta WHERE key = ?",
      args: ["schema_version"],
    });
    const stamped = toStringValue((versionRow.rows[0] as { value?: unknown } | undefined)?.value);
    expect(stamped).toBe(APP_VERSION);

    const createdRow = await client.execute({
      sql: "SELECT value FROM _meta WHERE key = ?",
      args: ["db_created_at"],
    });
    expect(toStringValue((createdRow.rows[0] as { value?: unknown } | undefined)?.value)).toBeTruthy();
  });

  it("upgrade stamps schema version on existing _meta", async () => {
    const client = makeClient();

    await client.execute(`
      CREATE TABLE IF NOT EXISTS _meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    await client.execute({
      sql: "INSERT INTO _meta (key, value, updated_at) VALUES (?, ?, ?)",
      args: ["schema_version", "0.1.0", "1999-01-01 00:00:00"],
    });

    await initSchema(client);

    const row = await client.execute({
      sql: "SELECT value, updated_at FROM _meta WHERE key = ?",
      args: ["schema_version"],
    });
    const value = toStringValue((row.rows[0] as { value?: unknown } | undefined)?.value);
    const updatedAt = toStringValue((row.rows[0] as { updated_at?: unknown } | undefined)?.updated_at);
    expect(value).toBe(APP_VERSION);
    expect(updatedAt).not.toBe("1999-01-01 00:00:00");
  });

  it("pre-existing DB without _meta table gets _meta created and stamped", async () => {
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
    await client.execute({
      sql: "INSERT INTO entries (id, type, subject, content, importance, expiry, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["x", "fact", "S", "C", 5, "temporary", "2026-02-14T00:00:00.000Z", "2026-02-14T00:00:00.000Z"],
    });

    await initSchema(client);

    const metaMaster = await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_meta' LIMIT 1",
      args: [],
    });
    expect(metaMaster.rows.length).toBe(1);

    const versionRow = await client.execute({
      sql: "SELECT value FROM _meta WHERE key = ?",
      args: ["schema_version"],
    });
    expect(toStringValue((versionRow.rows[0] as { value?: unknown } | undefined)?.value)).toBe(APP_VERSION);

    const count = await client.execute("SELECT COUNT(*) AS count FROM entries");
    expect(Number((count.rows[0] as { count?: unknown } | undefined)?.count ?? 0)).toBe(1);
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
    const platform = entriesColumns.find((row) => toStringValue(row.name) === "platform");
    const project = entriesColumns.find((row) => toStringValue(row.name) === "project");

    expect(canonicalKey).toBeTruthy();
    expect(scope).toBeTruthy();
    expect(toStringValue(scope?.dflt_value)).toContain("private");
    expect(contentHash).toBeTruthy();
    expect(mergedFrom).toBeTruthy();
    expect(toStringValue(mergedFrom?.dflt_value)).toBe("0");
    expect(consolidatedAt).toBeTruthy();
    expect(platform).toBeTruthy();
    expect(project).toBeTruthy();

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

  it("existing entries keep NULL platform after migration", async () => {
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

    await client.execute({
      sql: "INSERT INTO entries (id, type, subject, content, importance, expiry, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["legacy-1", "fact", "S", "C", 5, "temporary", "2026-02-14T00:00:00.000Z", "2026-02-14T00:00:00.000Z"],
    });

    await initSchema(client);

    const row = await client.execute({ sql: "SELECT platform FROM entries WHERE id = ?", args: ["legacy-1"] });
    expect(row.rows.length).toBeGreaterThan(0);
    expect(row.rows[0]).toBeDefined();
    expect((row.rows[0] as { platform?: unknown } | undefined)?.platform ?? null).toBe(null);
  });

  it("existing entries keep NULL project after migration", async () => {
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

    await client.execute({
      sql: "INSERT INTO entries (id, type, subject, content, importance, expiry, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["legacy-2", "fact", "S", "C", 5, "temporary", "2026-02-14T00:00:00.000Z", "2026-02-14T00:00:00.000Z"],
    });

    await initSchema(client);

    const row = await client.execute({ sql: "SELECT project FROM entries WHERE id = ?", args: ["legacy-2"] });
    expect(row.rows.length).toBeGreaterThan(0);
    expect(row.rows[0]).toBeDefined();
    expect((row.rows[0] as { project?: unknown } | undefined)?.project ?? null).toBe(null);
  });

  it("legacy confidence schema gets importance column and backfills from confidence levels", async () => {
    const client = makeClient();

    await client.execute(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence TEXT NOT NULL,
        expiry TEXT NOT NULL,
        scope TEXT DEFAULT 'private',
        source_file TEXT,
        source_context TEXT,
        embedding F32_BLOB(512),
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

    await client.execute({
      sql: "INSERT INTO entries (id, type, subject, content, confidence, expiry, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["legacy-confidence-1", "fact", "S", "C", "high", "temporary", "2026-02-14T00:00:00.000Z", "2026-02-14T00:00:00.000Z"],
    });

    await initSchema(client);

    const info = await client.execute("PRAGMA table_info(entries)");
    const columns = columnNames(info.rows as Array<{ name?: unknown }>);
    expect(columns.has("importance")).toBe(true);

    const row = await client.execute({ sql: "SELECT importance FROM entries WHERE id = ?", args: ["legacy-confidence-1"] });
    const importance = Number((row.rows[0] as { importance?: unknown } | undefined)?.importance ?? 0);
    expect(importance).toBe(8);
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
