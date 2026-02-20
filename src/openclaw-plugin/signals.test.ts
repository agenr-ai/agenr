import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../db/client.js";
import { getWatermark } from "../db/signals.js";
import { checkSignals, resolveSignalConfig } from "./signals.js";

const clients: Client[] = [];

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    return Number(value);
  }
  return Number.NaN;
}

function makeClient(): Client {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  return client;
}

async function insertEntry(
  client: Client,
  params: { id: string; subject: string; importance: number; createdAt?: string },
): Promise<number> {
  const createdAt = params.createdAt ?? new Date().toISOString();
  await client.execute({
    sql: `
      INSERT INTO entries (
        id, type, subject, content, importance, expiry, scope, source_file, source_context,
        created_at, updated_at, retired
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `,
    args: [
      params.id,
      "fact",
      params.subject,
      `${params.subject} content`,
      params.importance,
      "temporary",
      "private",
      "signals.test.jsonl",
      "unit test",
      createdAt,
      createdAt,
    ],
  });
  const row = await client.execute({ sql: "SELECT rowid FROM entries WHERE id = ?", args: [params.id] });
  return toNumber((row.rows[0] as { rowid?: unknown } | undefined)?.rowid);
}

afterEach(() => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }
});

describe("openclaw plugin signals adapter", () => {
  it("checkSignals returns null when no new entries", async () => {
    const client = makeClient();
    await initDb(client);

    await insertEntry(client, { id: "e1", subject: "Existing", importance: 8 });
    const first = await checkSignals(client, "consumer-no-new");
    expect(first).toBeNull();

    const second = await checkSignals(client, "consumer-no-new");
    expect(second).toBeNull();
  });

  it("checkSignals returns formatted signal and advances watermark", async () => {
    const client = makeClient();
    await initDb(client);

    await insertEntry(client, { id: "seed", subject: "Seed", importance: 8 });
    await checkSignals(client, "consumer-new");

    await insertEntry(client, { id: "e1", subject: "New A", importance: 7 });
    const newestRowid = await insertEntry(client, { id: "e2", subject: "New B", importance: 9 });

    const signal = await checkSignals(client, "consumer-new");
    expect(signal).toContain("AGENR SIGNAL: 2 new high-importance entries");
    expect(signal).toContain('- [fact, imp:7] "New A"');
    expect(signal).toContain('- [fact, imp:9] "New B"');
    expect(await getWatermark(client, "consumer-new")).toBe(newestRowid);
  });

  it("checkSignals initializes watermark on first call", async () => {
    const client = makeClient();
    await initDb(client);

    const maxRowid = await insertEntry(client, { id: "e1", subject: "Existing", importance: 9 });

    const signal = await checkSignals(client, "consumer-init");
    expect(signal).toBeNull();
    expect(await getWatermark(client, "consumer-init")).toBe(maxRowid);
  });

  it("checkSignals does not replay pre-existing entries on first call", async () => {
    const client = makeClient();
    await initDb(client);

    // Insert entries BEFORE any signal check (simulate session-start state).
    await insertEntry(client, { id: "pre1", subject: "Pre-existing A", importance: 9 });
    await insertEntry(client, { id: "pre2", subject: "Pre-existing B", importance: 8 });

    // First checkSignals call: must return null (watermark init skips pre-existing).
    const first = await checkSignals(client, "consumer-no-replay");
    expect(first).toBeNull();

    // Add a new entry after initialization.
    await insertEntry(client, { id: "new1", subject: "New entry", importance: 7 });

    // Second call: must return the new entry only.
    const second = await checkSignals(client, "consumer-no-replay");
    expect(second).toContain("New entry");
    expect(second).not.toContain("Pre-existing A");
    expect(second).not.toContain("Pre-existing B");
  });

  it("resolveSignalConfig uses defaults", () => {
    expect(resolveSignalConfig()).toEqual({ minImportance: 7, maxPerSignal: 5 });
  });

  it("resolveSignalConfig respects overrides", () => {
    expect(resolveSignalConfig({ signalMinImportance: 9, signalMaxPerSignal: 2 })).toEqual({
      minImportance: 9,
      maxPerSignal: 2,
    });
  });

  it("resolveSignalConfig allows zero thresholds", () => {
    expect(resolveSignalConfig({ signalMinImportance: 0, signalMaxPerSignal: 0 })).toEqual({
      minImportance: 0,
      maxPerSignal: 0,
    });
  });
});
