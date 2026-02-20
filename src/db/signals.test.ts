import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "./client.js";
import {
  fetchNewSignalEntries,
  formatSignal,
  getWatermark,
  initializeWatermark,
  setWatermark,
} from "./signals.js";

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
  params: {
    id: string;
    type?: string;
    subject: string;
    content?: string;
    importance?: number;
    retired?: number;
    createdAt?: string;
  },
): Promise<number> {
  const createdAt = params.createdAt ?? new Date().toISOString();
  await client.execute({
    sql: `
      INSERT INTO entries (
        id, type, subject, content, importance, expiry, scope, source_file, source_context,
        created_at, updated_at, retired
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      params.id,
      params.type ?? "fact",
      params.subject,
      params.content ?? `${params.subject} content`,
      params.importance ?? 5,
      "temporary",
      "private",
      "signals.test.jsonl",
      "unit test",
      createdAt,
      createdAt,
      params.retired ?? 0,
    ],
  });

  const row = await client.execute({
    sql: "SELECT rowid FROM entries WHERE id = ?",
    args: [params.id],
  });
  return toNumber((row.rows[0] as { rowid?: unknown } | undefined)?.rowid);
}

afterEach(() => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }
});

describe("db signals", () => {
  it("fetchNewSignalEntries returns entries above watermark", async () => {
    const client = makeClient();
    await initDb(client);

    await insertEntry(client, { id: "e1", subject: "S1", importance: 7 });
    await insertEntry(client, { id: "e2", subject: "S2", importance: 8 });
    await insertEntry(client, { id: "e3", subject: "S3", importance: 9 });

    const batch = await fetchNewSignalEntries(client, 0, 7, 10);
    expect(batch.entries).toHaveLength(3);
    expect(batch.entries.map((entry) => entry.subject)).toEqual(["S1", "S2", "S3"]);
    expect(batch.entries.map((entry) => entry.rowid)).toEqual(
      [...batch.entries.map((entry) => entry.rowid)].sort((a, b) => a - b),
    );
    expect(batch.maxSeq).toBe(batch.entries[2]?.rowid);
  });

  it("fetchNewSignalEntries respects importance threshold", async () => {
    const client = makeClient();
    await initDb(client);

    await insertEntry(client, { id: "e1", subject: "low", importance: 5 });
    await insertEntry(client, { id: "e2", subject: "mid", importance: 7 });
    await insertEntry(client, { id: "e3", subject: "high", importance: 9 });

    const batch = await fetchNewSignalEntries(client, 0, 7, 10);
    expect(batch.entries.map((entry) => entry.subject)).toEqual(["mid", "high"]);
  });

  it("fetchNewSignalEntries respects limit", async () => {
    const client = makeClient();
    await initDb(client);

    for (let i = 0; i < 10; i += 1) {
      await insertEntry(client, { id: `e${i}`, subject: `S${i}`, importance: 9 });
    }

    const batch = await fetchNewSignalEntries(client, 0, 7, 3);
    expect(batch.entries).toHaveLength(3);
  });

  it("fetchNewSignalEntries excludes retired entries", async () => {
    const client = makeClient();
    await initDb(client);

    await insertEntry(client, { id: "e1", subject: "active", importance: 8, retired: 0 });
    await insertEntry(client, { id: "e2", subject: "retired", importance: 9, retired: 1 });

    const batch = await fetchNewSignalEntries(client, 0, 7, 10);
    expect(batch.entries).toHaveLength(1);
    expect(batch.entries[0]?.subject).toBe("active");
  });

  it("fetchNewSignalEntries returns empty for no new entries", async () => {
    const client = makeClient();
    await initDb(client);

    const rowid = await insertEntry(client, { id: "e1", subject: "S1", importance: 8 });
    const batch = await fetchNewSignalEntries(client, rowid, 7, 10);

    expect(batch.entries).toEqual([]);
    expect(batch.maxSeq).toBe(rowid);
  });

  it("formatSignal produces correct format", () => {
    const formatted = formatSignal([
      {
        rowid: 1,
        id: "a",
        type: "decision",
        subject: "Switch to Postgres for prod",
        importance: 8,
        created_at: "2026-02-19T00:00:00.000Z",
      },
      {
        rowid: 2,
        id: "b",
        type: "fact",
        subject: "AWS contract signed through 2027",
        importance: 9,
        created_at: "2026-02-19T00:00:00.000Z",
      },
    ]);

    expect(formatted).toBe(
      [
        "AGENR SIGNAL: 2 new high-importance entries",
        '- [decision, imp:8] "Switch to Postgres for prod"',
        '- [fact, imp:9] "AWS contract signed through 2027"',
        '-> Use agenr_recall query="<subject>" for details.',
      ].join("\n"),
    );
  });

  it("formatSignal handles single entry (singular)", () => {
    const formatted = formatSignal([
      {
        rowid: 1,
        id: "a",
        type: "fact",
        subject: "Single item",
        importance: 7,
        created_at: "2026-02-19T00:00:00.000Z",
      },
    ]);
    expect(formatted).toContain("AGENR SIGNAL: 1 new high-importance entry");
  });

  it("formatSignal returns empty string for no entries", () => {
    expect(formatSignal([])).toBe("");
  });

  it("getWatermark returns 0 for unknown consumer", async () => {
    const client = makeClient();
    await initDb(client);

    expect(await getWatermark(client, "consumer-a")).toBe(0);
  });

  it("setWatermark creates then updates", async () => {
    const client = makeClient();
    await initDb(client);

    await setWatermark(client, "consumer-a", 12);
    expect(await getWatermark(client, "consumer-a")).toBe(12);

    await setWatermark(client, "consumer-a", 27);
    expect(await getWatermark(client, "consumer-a")).toBe(27);
  });

  it("initializeWatermark sets to max rowid on first call", async () => {
    const client = makeClient();
    await initDb(client);

    await insertEntry(client, { id: "e1", subject: "S1", importance: 8 });
    const maxRowid = await insertEntry(client, { id: "e2", subject: "S2", importance: 8 });

    const watermark = await initializeWatermark(client, "consumer-init");
    expect(watermark).toBe(maxRowid);
    expect(await getWatermark(client, "consumer-init")).toBe(maxRowid);
  });

  it("initializeWatermark is idempotent", async () => {
    const client = makeClient();
    await initDb(client);

    await insertEntry(client, { id: "e1", subject: "S1", importance: 8 });
    const first = await initializeWatermark(client, "consumer-idempotent");

    await insertEntry(client, { id: "e2", subject: "S2", importance: 8 });
    const second = await initializeWatermark(client, "consumer-idempotent");

    expect(second).toBe(first);
    expect(await getWatermark(client, "consumer-idempotent")).toBe(first);
  });
});
