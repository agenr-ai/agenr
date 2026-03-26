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
          AND name IN ('entries', 'entries_fts', 'ingest_log', 'recall_events', 'surgeon_runs', '_meta')
      `,
    });
    const tableNames = new Set(
      tablesResult.rows.map((row) => {
        const value = row.name;
        return typeof value === "string" ? value : "";
      }),
    );

    expect(tableNames).toEqual(new Set(["entries", "entries_fts", "ingest_log", "recall_events", "surgeon_runs", "_meta"]));

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
