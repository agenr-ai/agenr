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

describe("db schema migration v4", () => {
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

  it("adds original_created_at to entry_sources", async () => {
    const client = makeClient();
    await initDb(client);

    const info = await client.execute("PRAGMA table_info(entry_sources)");
    const originalCreatedAt = info.rows.find((row) => toStringValue(row.name) === "original_created_at");
    expect(originalCreatedAt).toBeTruthy();
    expect(toStringValue(originalCreatedAt?.type).toUpperCase()).toBe("TEXT");
  });
});
