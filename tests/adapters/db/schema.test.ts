import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { initSchema } from "../../../src/adapters/db/schema.js";

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

    expect(tableNames).toEqual(
      new Set(["entries", "entries_fts", "ingest_log", "recall_events", "surgeon_runs", "_meta"]),
    );

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
});
