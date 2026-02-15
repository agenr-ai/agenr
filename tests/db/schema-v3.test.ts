import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

describe("db schema migration v3", () => {
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

  it("creates entry_sources and adds merged_from/consolidated_at columns", async () => {
    const client = makeClient();
    await initDb(client);

    const tableResult = await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: ["entry_sources"],
    });
    expect(tableResult.rows.length).toBe(1);

    const entriesInfo = await client.execute("PRAGMA table_info(entries)");
    const mergedFromColumn = entriesInfo.rows.find((row) => toStringValue(row.name) === "merged_from");
    const consolidatedAtColumn = entriesInfo.rows.find((row) => toStringValue(row.name) === "consolidated_at");

    expect(mergedFromColumn).toBeTruthy();
    expect(consolidatedAtColumn).toBeTruthy();
    expect(toStringValue(mergedFromColumn?.dflt_value)).toBe("0");
    expect(consolidatedAtColumn?.dflt_value ?? null).toBe(null);
  });

  it("is idempotent when v3 migration runs more than once", async () => {
    const client = makeClient();
    await initDb(client);
    await initDb(client);

    const migrationRows = await client.execute("SELECT version FROM _migrations ORDER BY version ASC");
    expect(migrationRows.rows.map((row) => Number(row.version))).toEqual([1, 2, 3]);
  });
});
