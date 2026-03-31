import { createClient, type Client, type InArgs, type InStatement } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { BULK_WRITE_STATE_META_KEY, VECTOR_INDEX_NAME, finalizeBulkWrites, initSchema, prepareBulkWrites } from "../../../src/adapters/db/schema.js";

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
          AND name IN ('entries', 'entries_fts', 'ingest_log', 'episodes', 'tasks', 'recall_events', 'surgeon_runs', 'surgeon_run_actions', '_meta')
      `,
    });
    const tableNames = new Set(
      tablesResult.rows.map((row) => {
        const value = row.name;
        return typeof value === "string" ? value : "";
      }),
    );

    expect(tableNames).toEqual(
      new Set(["entries", "entries_fts", "ingest_log", "episodes", "tasks", "recall_events", "surgeon_runs", "surgeon_run_actions", "_meta"]),
    );
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
    expect(await tableColumns(client, "tasks")).toEqual([
      "id",
      "subject",
      "content",
      "status",
      "priority",
      "tags",
      "source_context",
      "project",
      "created_at",
      "updated_at",
      "completed_at",
      "due_at",
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
    expect(await indexExists(client, "idx_tasks_status")).toBe(true);
    expect(await indexExists(client, "idx_tasks_created_at")).toBe(true);
    expect(await indexExists(client, "idx_tasks_project")).toBe(true);
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
    expect(version.rows[0]?.value).toBe("4");
    expect(await indexExists(client, "idx_episodes_started_at")).toBe(true);
  });

  it("migrates schema version 2 entries to current semantics", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

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
        embedding BLOB,
        content_hash TEXT,
        norm_content_hash TEXT,
        minhash_sig BLOB,
        quality_score REAL NOT NULL DEFAULT 0.5,
        recall_count INTEGER DEFAULT 0,
        last_recalled_at TEXT,
        superseded_by TEXT,
        cluster_id TEXT,
        retired INTEGER NOT NULL DEFAULT 0,
        retired_at TEXT,
        retired_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    await client.execute("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
    await client.execute({
      sql: `
        INSERT INTO _meta (key, value)
        VALUES ('schema_version', '2')
      `,
    });
    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, tags, source_context, quality_score, recall_count, retired, created_at, updated_at
        )
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "event-1",
        "event",
        "Launch event",
        "The recall v1 launch completed on 2026-03-01.",
        6,
        "permanent",
        '["launch"]',
        "Completed rollout.",
        0.5,
        0,
        0,
        "2026-03-01T00:00:00.000Z",
        "2026-03-01T00:00:00.000Z",
        "todo-1",
        "todo",
        "Open follow-up",
        "Clean up the temporary compatibility shim after rollout.",
        5,
        "temporary",
        '["cleanup"]',
        "Identified during rollout.",
        0.5,
        0,
        0,
        "2026-03-02T00:00:00.000Z",
        "2026-03-02T00:00:00.000Z",
        "todo-retired",
        "todo",
        "Retired follow-up",
        "This old follow-up no longer matters.",
        4,
        "temporary",
        '["cleanup"]',
        "Resolved already.",
        0.5,
        0,
        1,
        "2026-03-03T00:00:00.000Z",
        "2026-03-03T00:00:00.000Z",
        "reflection-1",
        "reflection",
        "Legacy reflection",
        "This summary should be deleted during migration.",
        3,
        "temporary",
        "[]",
        "Legacy data.",
        0.5,
        0,
        0,
        "2026-03-04T00:00:00.000Z",
        "2026-03-04T00:00:00.000Z",
      ],
    });

    await initSchema(client);

    expect(await tableColumns(client, "entries")).toContain("user_id");
    expect(await tableColumns(client, "entries")).toContain("project");

    const migratedEntries = await client.execute({
      sql: "SELECT id, type FROM entries ORDER BY id",
    });
    expect(migratedEntries.rows).toEqual([{ id: "event-1", type: "milestone" }]);

    const migratedTasks = await client.execute({
      sql: "SELECT id, subject, content, status, priority, tags, source_context FROM tasks ORDER BY id",
    });
    expect(migratedTasks.rows).toEqual([
      {
        id: "todo-1",
        subject: "Open follow-up",
        content: "Clean up the temporary compatibility shim after rollout.",
        status: "open",
        priority: 5,
        tags: '["cleanup"]',
        source_context: "Identified during rollout.",
      },
    ]);

    const versionResult = await client.execute({
      sql: "SELECT value FROM _meta WHERE key = 'schema_version' LIMIT 1",
    });
    expect(versionResult.rows).toEqual([{ value: "4" }]);
    expect(await tableColumns(client, "episodes")).toContain("summary_hash");
    expect(await tableColumns(client, "episodes")).toContain("surface");
  });

  it("migrates schema version 3 databases additively to version 4 without losing entry data", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

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
        embedding BLOB,
        content_hash TEXT,
        norm_content_hash TEXT,
        minhash_sig BLOB,
        quality_score REAL NOT NULL DEFAULT 0.5,
        recall_count INTEGER DEFAULT 0,
        last_recalled_at TEXT,
        superseded_by TEXT,
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
    await client.execute("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
    await client.execute({
      sql: `
        INSERT INTO _meta (key, value)
        VALUES ('schema_version', '3')
      `,
    });
    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, tags, source_file, source_context, embedding,
          content_hash, norm_content_hash, minhash_sig, quality_score, recall_count, last_recalled_at,
          superseded_by, cluster_id, user_id, project, retired, retired_at, retired_reason, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "entry-v3",
        "fact",
        "legacy entry",
        "A pre-existing v3 entry should survive the episodic schema upgrade.",
        7,
        "permanent",
        '["legacy"]',
        "/tmp/legacy.jsonl",
        "v3 fixture",
        null,
        "hash-v3",
        "norm-hash-v3",
        null,
        0.5,
        1,
        "2026-03-28T00:00:00.000Z",
        null,
        null,
        "user-1",
        "agenr",
        0,
        null,
        null,
        "2026-03-28T00:00:00.000Z",
        "2026-03-28T00:00:00.000Z",
      ],
    });

    await initSchema(client);

    expect(await tableColumns(client, "episodes")).toContain("transcript_hash");
    expect(await tableColumns(client, "episodes")).toContain("surface");
    expect(await indexExists(client, "idx_episodes_source_source_id")).toBe(true);

    const upgradedVersion = await client.execute({
      sql: "SELECT value FROM _meta WHERE key = 'schema_version' LIMIT 1",
    });
    expect(upgradedVersion.rows).toEqual([{ value: "4" }]);

    const entryResult = await client.execute({
      sql: "SELECT id, subject, project FROM entries WHERE id = ? LIMIT 1",
      args: ["entry-v3"],
    });
    expect(entryResult.rows).toEqual([
      {
        id: "entry-v3",
        subject: "legacy entry",
        project: "agenr",
      },
    ]);
  });

  it("migrates the minimal legacy surgeon_runs table without losing data", async () => {
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
    await client.execute({
      sql: `
        INSERT INTO surgeon_runs (id, started_at, completed_at, actions_taken, summary)
        VALUES (?, ?, ?, ?, ?)
      `,
      args: ["run-1", "2026-03-28T10:00:00.000Z", "2026-03-28T10:05:00.000Z", 3, "legacy summary"],
    });

    await initSchema(client);

    expect(await tableColumns(client, "surgeon_runs")).toEqual([
      "id",
      "started_at",
      "completed_at",
      "actions_taken",
      "summary",
      "pass_type",
      "project",
      "status",
      "input_tokens",
      "output_tokens",
      "estimated_cost_usd",
      "model",
      "actions_skipped",
      "entries_retired",
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

    const runResult = await client.execute({
      sql: `
        SELECT
          id,
          started_at,
          completed_at,
          actions_taken,
          summary,
          pass_type,
          status,
          actions_skipped,
          entries_retired,
          dry_run
        FROM surgeon_runs
        WHERE id = ?
      `,
      args: ["run-1"],
    });
    expect(runResult.rows).toEqual([
      {
        id: "run-1",
        started_at: "2026-03-28T10:00:00.000Z",
        completed_at: "2026-03-28T10:05:00.000Z",
        actions_taken: 3,
        summary: "legacy summary",
        pass_type: "retirement",
        status: "completed",
        actions_skipped: 0,
        entries_retired: 0,
        dry_run: 1,
      },
    ]);
    expect(await indexExists(client, "idx_surgeon_run_actions_run_id")).toBe(true);
    expect(await indexExists(client, "idx_surgeon_run_actions_entry_id")).toBe(true);
    expect(await indexExists(client, "idx_surgeon_run_actions_created_at")).toBe(true);
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

  it("treats an already-expanded surgeon_runs table as a no-op migration", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await client.execute(`
      CREATE TABLE surgeon_runs (
        id TEXT PRIMARY KEY,
        pass_type TEXT NOT NULL DEFAULT 'retirement',
        project TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        estimated_cost_usd REAL DEFAULT 0,
        model TEXT,
        actions_taken INTEGER DEFAULT 0,
        actions_skipped INTEGER DEFAULT 0,
        entries_retired INTEGER DEFAULT 0,
        summary TEXT,
        summary_json TEXT,
        error TEXT,
        dry_run INTEGER NOT NULL DEFAULT 1,
        config_json TEXT
      )
    `);

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

  it("rebuilds FTS when the stored schema version changes", async () => {
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

    await initSchema(tracker.trackedClient);

    expect(tracker.rebuildCount()).toBe(1);
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
