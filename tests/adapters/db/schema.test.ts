import { createClient, type Client, type InArgs, type InStatement } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  BULK_WRITE_STATE_META_KEY,
  VECTOR_INDEX_NAME,
  finalizeBulkWrites,
  getLastBulkIngestAt,
  initSchema,
  prepareBulkWrites,
} from "../../../src/adapters/db/schema.js";

const FTS_REBUILD_SQL = "INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')";

describe("initSchema", () => {
  const clients: Array<ReturnType<typeof createClient>> = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("creates the core tables and FTS triggers", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await initSchema(client);

    const tablesResult = await client.execute({
      sql: `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('entries', 'entries_fts', 'ingest_log', 'episodes', 'recall_events', 'surgeon_runs', 'surgeon_run_actions', '_meta')
      `,
    });
    const tableNames = new Set(
      tablesResult.rows.map((row) => {
        const value = row.name;
        return typeof value === "string" ? value : "";
      }),
    );

    expect(tableNames).toEqual(new Set(["entries", "entries_fts", "ingest_log", "episodes", "recall_events", "surgeon_runs", "surgeon_run_actions", "_meta"]));
    expect(await tableColumns(client, "entries")).toEqual([
      "id",
      "type",
      "subject",
      "content",
      "importance",
      "expiry",
      "tags",
      "source_file",
      "source_context",
      "embedding",
      "content_hash",
      "norm_content_hash",
      "minhash_sig",
      "quality_score",
      "recall_count",
      "last_recalled_at",
      "superseded_by",
      "valid_from",
      "valid_to",
      "claim_key",
      "supersession_kind",
      "supersession_reason",
      "cluster_id",
      "user_id",
      "project",
      "retired",
      "retired_at",
      "retired_reason",
      "created_at",
      "updated_at",
    ]);
    expect(await tableColumns(client, "episodes")).toEqual([
      "id",
      "source",
      "source_id",
      "source_ref",
      "transcript_hash",
      "summary_hash",
      "agent_id",
      "surface",
      "started_at",
      "ended_at",
      "summary",
      "tags",
      "activity_level",
      "user_id",
      "project",
      "gen_model",
      "gen_version",
      "message_count",
      "embedding",
      "retired",
      "retired_at",
      "retired_reason",
      "superseded_by",
      "created_at",
      "updated_at",
    ]);
    const triggersResult = await client.execute({
      sql: `
        SELECT name
        FROM sqlite_master
        WHERE type = 'trigger'
          AND name IN ('entries_ai', 'entries_ad', 'entries_au')
      `,
    });
    const triggerNames = new Set(
      triggersResult.rows.map((row) => {
        const value = row.name;
        return typeof value === "string" ? value : "";
      }),
    );

    expect(triggerNames).toEqual(new Set(["entries_ai", "entries_ad", "entries_au"]));
    expect(await tableColumns(client, "surgeon_runs")).toEqual([
      "id",
      "pass_type",
      "project",
      "started_at",
      "completed_at",
      "status",
      "input_tokens",
      "output_tokens",
      "estimated_cost_usd",
      "model",
      "actions_taken",
      "actions_skipped",
      "entries_retired",
      "summary",
      "summary_json",
      "error",
      "dry_run",
      "config_json",
    ]);
    expect(await tableColumns(client, "surgeon_run_actions")).toEqual([
      "id",
      "run_id",
      "action_type",
      "entry_id",
      "entry_ids",
      "reasoning",
      "recall_delta",
      "created_at",
    ]);
    expect(await indexExists(client, "idx_surgeon_run_actions_run_id")).toBe(true);
    expect(await indexExists(client, "idx_surgeon_run_actions_entry_id")).toBe(true);
    expect(await indexExists(client, "idx_surgeon_run_actions_created_at")).toBe(true);
    expect(await indexExists(client, "idx_entries_claim_key")).toBe(true);
    expect(await indexExists(client, "idx_entries_valid_from")).toBe(true);
    expect(await indexExists(client, "idx_entries_valid_to")).toBe(true);
    expect(await indexExists(client, "idx_episodes_started_at")).toBe(true);
    expect(await indexExists(client, "idx_episodes_ended_at")).toBe(true);
    expect(await indexExists(client, "idx_episodes_source")).toBe(true);
    expect(await indexExists(client, "idx_episodes_source_id")).toBe(true);
    expect(await indexExists(client, "idx_episodes_retired")).toBe(true);
    expect(await indexExists(client, "idx_episodes_source_source_id")).toBe(true);
  });

  it("is idempotent when episode vector index creation runs more than once", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await expect(initSchema(client)).resolves.toBeUndefined();
    await expect(initSchema(client)).resolves.toBeUndefined();

    const version = await client.execute("SELECT value FROM _meta WHERE key = 'schema_version' LIMIT 1");
    expect(version.rows[0]?.value).toBe("6");
    expect(await indexExists(client, "idx_episodes_started_at")).toBe(true);
  });

  it("migrates a v5 database to schema version 6", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await client.execute("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
    await client.execute("INSERT INTO _meta (key, value) VALUES ('schema_version', '5')");
    await client.execute(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER NOT NULL,
        expiry TEXT NOT NULL,
        tags TEXT,
        source_file TEXT,
        source_context TEXT,
        embedding F32_BLOB(1024),
        content_hash TEXT,
        norm_content_hash TEXT,
        minhash_sig BLOB,
        quality_score REAL NOT NULL DEFAULT 0.5,
        recall_count INTEGER DEFAULT 0,
        last_recalled_at TEXT,
        superseded_by TEXT REFERENCES entries(id),
        cluster_id TEXT,
        user_id TEXT,
        project TEXT,
        retired INTEGER NOT NULL DEFAULT 0,
        retired_at TEXT,
        retired_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    await client.execute({
      sql: `
        INSERT INTO entries (
          id,
          type,
          subject,
          content,
          importance,
          expiry,
          tags,
          quality_score,
          recall_count,
          retired,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "v5-entry",
        "fact",
        "legacy subject",
        "Legacy content survives migration.",
        7,
        "permanent",
        "[]",
        0.5,
        0,
        0,
        "2026-03-20T00:00:00.000Z",
        "2026-03-20T00:00:00.000Z",
      ],
    });

    await initSchema(client);

    expect(await tableColumns(client, "entries")).toEqual([
      "id",
      "type",
      "subject",
      "content",
      "importance",
      "expiry",
      "tags",
      "source_file",
      "source_context",
      "embedding",
      "content_hash",
      "norm_content_hash",
      "minhash_sig",
      "quality_score",
      "recall_count",
      "last_recalled_at",
      "superseded_by",
      "cluster_id",
      "user_id",
      "project",
      "retired",
      "retired_at",
      "retired_reason",
      "created_at",
      "updated_at",
      "valid_from",
      "valid_to",
      "claim_key",
      "supersession_kind",
      "supersession_reason",
    ]);

    const migratedEntry = await client.execute({
      sql: `
        SELECT
          subject,
          content,
          valid_from,
          valid_to,
          claim_key,
          supersession_kind,
          supersession_reason
        FROM entries
        WHERE id = 'v5-entry'
      `,
    });
    expect(migratedEntry.rows[0]).toMatchObject({
      subject: "legacy subject",
      content: "Legacy content survives migration.",
      valid_from: null,
      valid_to: null,
      claim_key: null,
      supersession_kind: null,
      supersession_reason: null,
    });

    const version = await client.execute("SELECT value FROM _meta WHERE key = 'schema_version' LIMIT 1");
    expect(version.rows[0]?.value).toBe("6");
  });

  for (const version of ["2", "3", "4"] as const) {
    it(`rejects unsupported schema version ${version}`, async () => {
      const client = createClient({ url: ":memory:" });
      clients.push(client);

      await client.execute("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
      await client.execute({
        sql: `
          INSERT INTO _meta (key, value)
          VALUES ('schema_version', ?)
        `,
        args: [version],
      });

      await expect(initSchema(client)).rejects.toThrow(new RegExp(`schema version "${version}"`, "i"));
      await expect(initSchema(client)).rejects.toThrow(/agenr db reset/i);
    });
  }

  it("rejects an existing database without schema metadata", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await client.execute(`
      CREATE TABLE surgeon_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        actions_taken INTEGER DEFAULT 0,
        summary TEXT
      )
    `);

    await expect(initSchema(client)).rejects.toThrow(/without schema metadata/i);
    expect(await tableColumns(client, "surgeon_run_actions")).toEqual([]);
  });

  it("rebuilds FTS on first initialization", async () => {
    const tracker = createTrackedClient();
    clients.push(tracker.client);

    await initSchema(tracker.trackedClient);

    expect(tracker.rebuildCount()).toBe(1);
  });

  it("skips the FTS rebuild when the schema version is unchanged", async () => {
    const tracker = createTrackedClient();
    clients.push(tracker.client);

    await initSchema(tracker.trackedClient);
    tracker.reset();

    await initSchema(tracker.trackedClient);

    expect(tracker.rebuildCount()).toBe(0);
  });

  it("is idempotent when initSchema runs multiple times on an initialized database", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await initSchema(client);
    await initSchema(client);

    expect(await tableColumns(client, "surgeon_runs")).toEqual([
      "id",
      "pass_type",
      "project",
      "started_at",
      "completed_at",
      "status",
      "input_tokens",
      "output_tokens",
      "estimated_cost_usd",
      "model",
      "actions_taken",
      "actions_skipped",
      "entries_retired",
      "summary",
      "summary_json",
      "error",
      "dry_run",
      "config_json",
    ]);
    expect(await tableColumns(client, "surgeon_run_actions")).toEqual([
      "id",
      "run_id",
      "action_type",
      "entry_id",
      "entry_ids",
      "reasoning",
      "recall_delta",
      "created_at",
    ]);
  });

  it("rejects a database whose stored schema version changes away from the current version", async () => {
    const tracker = createTrackedClient();
    clients.push(tracker.client);

    await initSchema(tracker.trackedClient);
    await tracker.client.execute({
      sql: `
        UPDATE _meta
        SET value = '0'
        WHERE key = 'schema_version'
      `,
    });
    tracker.reset();

    await expect(initSchema(tracker.trackedClient)).rejects.toThrow(/schema version "0"/i);
    expect(tracker.rebuildCount()).toBe(0);
  });

  it("drops FTS triggers during bulk-write preparation and restores searchability on finalize", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await initSchema(client);
    const vectorIndexExisted = await indexExists(client, VECTOR_INDEX_NAME);

    await prepareBulkWrites(client);

    expect(await triggerNames(client)).toEqual(new Set());
    expect(await indexExists(client, VECTOR_INDEX_NAME)).toBe(false);

    await insertTestEntry(client, "entry-1", "Bulk finalize restores FTS searchability.");

    const beforeFinalize = await client.execute({
      sql: "SELECT rowid FROM entries_fts WHERE entries_fts MATCH 'searchability'",
    });
    expect(beforeFinalize.rows).toHaveLength(0);

    await finalizeBulkWrites(client);

    expect(await triggerNames(client)).toEqual(new Set(["entries_ai", "entries_ad", "entries_au"]));
    expect(await indexExists(client, VECTOR_INDEX_NAME)).toBe(vectorIndexExisted);
    const lastBulkIngestAt = await getLastBulkIngestAt(client);
    expect(lastBulkIngestAt).toEqual(expect.any(String));
    expect(Date.parse(lastBulkIngestAt ?? "")).not.toBeNaN();

    const afterFinalize = await client.execute({
      sql: "SELECT rowid FROM entries_fts WHERE entries_fts MATCH 'searchability'",
    });
    expect(afterFinalize.rows).toHaveLength(1);
  });

  it("recovers and finalizes an interrupted bulk-write state during schema init", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await initSchema(client);
    await prepareBulkWrites(client);
    await insertTestEntry(client, "entry-2", "Crash recovery should rebuild FTS and clear dirty bulk state.");

    await initSchema(client);

    expect(await triggerNames(client)).toEqual(new Set(["entries_ai", "entries_ad", "entries_au"]));

    const recovered = await client.execute({
      sql: "SELECT rowid FROM entries_fts WHERE entries_fts MATCH 'dirty'",
    });
    expect(recovered.rows).toHaveLength(1);

    const meta = await client.execute({
      sql: "SELECT value FROM _meta WHERE key = ?",
      args: [BULK_WRITE_STATE_META_KEY],
    });
    expect(meta.rows).toHaveLength(0);
    const lastBulkIngestAt = await getLastBulkIngestAt(client);
    expect(lastBulkIngestAt).toEqual(expect.any(String));
    expect(Date.parse(lastBulkIngestAt ?? "")).not.toBeNaN();
  });
});

function createTrackedClient(): {
  client: ReturnType<typeof createClient>;
  trackedClient: Client;
  rebuildCount: () => number;
  reset: () => void;
} {
  const client = createClient({ url: ":memory:" });
  let rebuilds = 0;

  const trackedClient = {
    execute: async (statement: InStatement | string, args?: InArgs) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql.includes(FTS_REBUILD_SQL)) {
        rebuilds += 1;
      }

      return typeof statement === "string" ? client.execute(statement, args) : client.execute(statement);
    },
    close: () => {
      client.close();
    },
  } as unknown as Client;

  return {
    client,
    trackedClient,
    rebuildCount: () => rebuilds,
    reset: () => {
      rebuilds = 0;
    },
  };
}

async function insertTestEntry(client: Client, id: string, content: string): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO entries (
        id,
        type,
        subject,
        content,
        importance,
        expiry,
        tags,
        source_file,
        source_context,
        embedding,
        content_hash,
        norm_content_hash,
        minhash_sig,
        quality_score,
        recall_count,
        last_recalled_at,
        superseded_by,
        cluster_id,
        retired,
        retired_at,
        retired_reason,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      id,
      "fact",
      "bulk write",
      content,
      7,
      "permanent",
      "[]",
      "/tmp/session.jsonl",
      null,
      null,
      `hash-${id}`,
      `norm-${id}`,
      null,
      0.5,
      0,
      null,
      null,
      null,
      0,
      null,
      null,
      "2026-03-26T00:00:00.000Z",
      "2026-03-26T00:00:00.000Z",
    ],
  });
}

async function triggerNames(client: Client): Promise<Set<string>> {
  const result = await client.execute({
    sql: `
      SELECT name
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN ('entries_ai', 'entries_ad', 'entries_au')
    `,
  });

  return new Set(
    result.rows.map((row) => {
      const value = row.name;
      return typeof value === "string" ? value : "";
    }),
  );
}

async function tableColumns(client: Client, tableName: string): Promise<string[]> {
  const result = await client.execute(`PRAGMA table_info('${tableName}')`);

  return result.rows.flatMap((row) => {
    const name = row.name;
    return typeof name === "string" ? [name] : [];
  });
}

async function indexExists(client: Client, indexName: string): Promise<boolean> {
  const result = await client.execute({
    sql: `
      SELECT 1
      FROM sqlite_master
      WHERE type = 'index'
        AND name = ?
      LIMIT 1
    `,
    args: [indexName],
  });

  return result.rows.length > 0;
}
