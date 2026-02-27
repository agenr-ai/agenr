import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initSchema } from "../../src/db/schema.js";
import { APP_VERSION } from "../../src/version.js";
import { toStringValue } from "../../src/utils/entry-utils.js";

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
    expect(entries.has("norm_content_hash")).toBe(true);
    expect(entries.has("minhash_sig")).toBe(true);
    expect(entries.has("merged_from")).toBe(true);
    expect(entries.has("consolidated_at")).toBe(true);
    expect(entries.has("platform")).toBe(true);
    expect(entries.has("project")).toBe(true);
    expect(entries.has("retired")).toBe(true);
    expect(entries.has("retired_at")).toBe(true);
    expect(entries.has("retired_reason")).toBe(true);
    expect(entries.has("suppressed_contexts")).toBe(true);
    expect(entries.has("recall_intervals")).toBe(true);
    expect(entries.has("quality_score")).toBe(true);
    expect(entries.has("subject_entity")).toBe(true);
    expect(entries.has("subject_attribute")).toBe(true);
    expect(entries.has("subject_key")).toBe(true);
    expect(entries.has("claim_predicate")).toBe(true);
    expect(entries.has("claim_object")).toBe(true);
    expect(entries.has("claim_confidence")).toBe(true);

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
    const normContentHash = entriesColumns.find((row) => toStringValue(row.name) === "norm_content_hash");
    const minhashSig = entriesColumns.find((row) => toStringValue(row.name) === "minhash_sig");
    const mergedFrom = entriesColumns.find((row) => toStringValue(row.name) === "merged_from");
    const consolidatedAt = entriesColumns.find((row) => toStringValue(row.name) === "consolidated_at");
    const platform = entriesColumns.find((row) => toStringValue(row.name) === "platform");
    const project = entriesColumns.find((row) => toStringValue(row.name) === "project");
    const retired = entriesColumns.find((row) => toStringValue(row.name) === "retired");
    const retiredAt = entriesColumns.find((row) => toStringValue(row.name) === "retired_at");
    const retiredReason = entriesColumns.find((row) => toStringValue(row.name) === "retired_reason");
    const suppressedContexts = entriesColumns.find((row) => toStringValue(row.name) === "suppressed_contexts");
    const recallIntervals = entriesColumns.find((row) => toStringValue(row.name) === "recall_intervals");
    const qualityScore = entriesColumns.find((row) => toStringValue(row.name) === "quality_score");
    const subjectEntity = entriesColumns.find((row) => toStringValue(row.name) === "subject_entity");
    const subjectAttribute = entriesColumns.find((row) => toStringValue(row.name) === "subject_attribute");
    const subjectKey = entriesColumns.find((row) => toStringValue(row.name) === "subject_key");
    const claimPredicate = entriesColumns.find((row) => toStringValue(row.name) === "claim_predicate");
    const claimObject = entriesColumns.find((row) => toStringValue(row.name) === "claim_object");
    const claimConfidence = entriesColumns.find((row) => toStringValue(row.name) === "claim_confidence");

    expect(canonicalKey).toBeTruthy();
    expect(scope).toBeTruthy();
    expect(toStringValue(scope?.dflt_value)).toContain("private");
    expect(contentHash).toBeTruthy();
    expect(normContentHash).toBeTruthy();
    expect(minhashSig).toBeTruthy();
    expect(mergedFrom).toBeTruthy();
    expect(toStringValue(mergedFrom?.dflt_value)).toBe("0");
    expect(consolidatedAt).toBeTruthy();
    expect(platform).toBeTruthy();
    expect(project).toBeTruthy();
    expect(retired).toBeTruthy();
    expect(toStringValue(retired?.dflt_value)).toBe("0");
    expect(retiredAt).toBeTruthy();
    expect(retiredReason).toBeTruthy();
    expect(suppressedContexts).toBeTruthy();
    expect(recallIntervals).toBeTruthy();
    expect(qualityScore).toBeTruthy();
    expect(subjectEntity).toBeTruthy();
    expect(subjectAttribute).toBeTruthy();
    expect(subjectKey).toBeTruthy();
    expect(claimPredicate).toBeTruthy();
    expect(claimObject).toBeTruthy();
    expect(claimConfidence).toBeTruthy();

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

    const triggers1 = await client.execute(`
      SELECT rowid, name
      FROM sqlite_master
      WHERE type = 'trigger' AND name IN ('entries_ai', 'entries_ad', 'entries_au')
    `);
    const triggerIds1 = new Map(triggers1.rows.map((r) => [String((r as { name?: unknown }).name), Number((r as { rowid?: unknown }).rowid)]));
    expect(triggerIds1.size).toBe(3);

    const sentinel1 = await client.execute({
      sql: "SELECT value FROM _meta WHERE key = ?",
      args: ["legacy_importance_backfill_from_confidence_v1"],
    });
    expect(sentinel1.rows.length).toBe(1);

    // Running initSchema twice should not re-run the expensive legacy FTS drop/recreate path.
    await initSchema(client);

    const triggers2 = await client.execute(`
      SELECT rowid, name
      FROM sqlite_master
      WHERE type = 'trigger' AND name IN ('entries_ai', 'entries_ad', 'entries_au')
    `);
    const triggerIds2 = new Map(triggers2.rows.map((r) => [String((r as { name?: unknown }).name), Number((r as { rowid?: unknown }).rowid)]));
    expect(triggerIds2.size).toBe(3);

    for (const [name, rowid] of triggerIds1) {
      expect(triggerIds2.get(name)).toBe(rowid);
    }
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

  it("creates conflict_log and subject_key index idempotently", async () => {
    const client = makeClient();
    await initSchema(client);

    const conflictTable = await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      args: ["conflict_log"],
    });
    expect(conflictTable.rows).toHaveLength(1);

    const conflictInfo = await client.execute("PRAGMA table_info(conflict_log)");
    const conflictColumns = columnNames(conflictInfo.rows as Array<{ name?: unknown }>);
    expect(conflictColumns.has("id")).toBe(true);
    expect(conflictColumns.has("entry_a")).toBe(true);
    expect(conflictColumns.has("entry_b")).toBe(true);
    expect(conflictColumns.has("relation")).toBe(true);
    expect(conflictColumns.has("confidence")).toBe(true);
    expect(conflictColumns.has("resolution")).toBe(true);
    expect(conflictColumns.has("resolved_at")).toBe(true);
    expect(conflictColumns.has("created_at")).toBe(true);

    const subjectIndex = await client.execute({
      sql: "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1",
      args: ["idx_entries_subject_key"],
    });
    expect(subjectIndex.rows).toHaveLength(1);
    expect(toStringValue((subjectIndex.rows[0] as { sql?: unknown } | undefined)?.sql)).toContain(
      "WHERE subject_key IS NOT NULL AND retired = 0 AND superseded_by IS NULL",
    );

    await initSchema(client);

    const duplicateIndex = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?",
      args: ["idx_entries_subject_key"],
    });
    expect(Number((duplicateIndex.rows[0] as { count?: unknown } | undefined)?.count ?? 0)).toBe(1);
  });
});
