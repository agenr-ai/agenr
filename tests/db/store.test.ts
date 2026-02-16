import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import { hashText, storeEntries } from "../../src/db/store.js";
import type { KnowledgeEntry } from "../../src/types.js";

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return Number.NaN;
}

function vectorForText(text: string): number[] {
  const to512 = (head: number[]): number[] => [...head, ...Array.from({ length: 509 }, () => 0)];

  if (text.includes("vec-base")) return to512([1, 0, 0]);
  if (text.includes("vec-exact")) return to512([0.999, 0.01, 0]);
  if (text.includes("vec-mid")) return to512([0.94, 0.34, 0]);
  if (text.includes("vec-low")) return to512([0.7, 0.71, 0]);
  if (text.includes("vec-v2")) return to512([0, 1, 0]);
  if (text.includes("vec-v3")) return to512([0, 0, 1]);
  if (text.includes("vec-v4")) return to512([0.5, 0.5, 0.707]);
  if (text.includes("vec-v5")) return to512([-1, 0, 0]);
  return to512([0.2, 0.2, 0.9]);
}

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => vectorForText(text));
}

function makeEntry(params: {
  type?: KnowledgeEntry["type"];
  subject?: string;
  content: string;
  sourceFile?: string;
  tags?: string[];
  createdAt?: string;
}): KnowledgeEntry {
  return {
    type: params.type ?? "fact",
    subject: params.subject ?? "Jim",
    content: params.content,
    importance: 8,
    expiry: "permanent",
    tags: params.tags ?? [],
    created_at: params.createdAt,
    source: {
      file: params.sourceFile ?? "source-a.jsonl",
      context: "unit test",
    },
  };
}

describe("db store pipeline", () => {
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

  it("stores entries, then idempotently skips the same entries on re-ingest", async () => {
    const client = makeClient();
    await initDb(client);

    const entries = [
      makeEntry({ content: "entry one vec-base", tags: ["alpha"] }),
      makeEntry({ content: "entry two vec-v2", sourceFile: "source-b.jsonl", tags: ["beta"] }),
      makeEntry({ content: "entry three vec-v3", sourceFile: "source-c.jsonl", tags: ["gamma"] }),
      makeEntry({ content: "entry four vec-v4", sourceFile: "source-d.jsonl", tags: ["delta"] }),
      makeEntry({ content: "entry five vec-v5", sourceFile: "source-e.jsonl", tags: ["epsilon"] }),
    ];

    const first = await storeEntries(client, entries, "sk-test", {
      sourceFile: "/tmp/ingest-a.json",
      ingestContentHash: hashText("first"),
      embedFn: mockEmbed,
    });

    expect(first.added).toBe(5);
    expect(first.updated).toBe(0);
    expect(first.skipped).toBe(0);

    const second = await storeEntries(client, entries, "sk-test", {
      sourceFile: "/tmp/ingest-a.json",
      ingestContentHash: hashText("second"),
      embedFn: mockEmbed,
    });

    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(5);

    const tagsResult = await client.execute("SELECT tag FROM tags ORDER BY tag ASC");
    expect(tagsResult.rows.map((row) => String(row.tag))).toEqual(["alpha", "beta", "delta", "epsilon", "gamma"]);

    const ingestLogs = await client.execute(
      "SELECT file_path, content_hash, entries_added, entries_updated, entries_skipped FROM ingest_log ORDER BY ingested_at ASC",
    );
    expect(ingestLogs.rows.length).toBe(2);
    expect(String(ingestLogs.rows[0]?.file_path)).toBe("/tmp/ingest-a.json");
    expect(String(ingestLogs.rows[0]?.content_hash)).toBe(hashText("first"));
    expect(asNumber(ingestLogs.rows[0]?.entries_added)).toBe(5);
    expect(asNumber(ingestLogs.rows[1]?.entries_skipped)).toBe(5);
  });

  it("uses entry created_at when provided", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl", createdAt: "2026-02-01T10:00:00.000Z" })],
      "sk-test",
      {
        sourceFile: "seed.jsonl",
        ingestContentHash: hashText("seed"),
        embedFn: mockEmbed,
      },
    );

    const rows = await client.execute({ sql: "SELECT created_at FROM entries WHERE source_file = ?", args: ["seed.jsonl"] });
    expect(String(rows.rows[0]?.created_at)).toBe("2026-02-01T10:00:00.000Z");
  });

  it("falls back to now for created_at when missing", async () => {
    const client = makeClient();
    await initDb(client);

    const before = Date.now();
    await storeEntries(client, [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl" })], "sk-test", {
      sourceFile: "seed.jsonl",
      ingestContentHash: hashText("seed"),
      embedFn: mockEmbed,
    });
    const after = Date.now();

    const rows = await client.execute({ sql: "SELECT created_at FROM entries WHERE source_file = ?", args: ["seed.jsonl"] });
    const createdAt = new Date(String(rows.rows[0]?.created_at)).getTime();
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(after + 1_000);
  });

  it("skips near-exact semantic duplicates above 0.98 similarity", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(client, [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl" })], "sk-test", {
      sourceFile: "seed.jsonl",
      ingestContentHash: hashText("seed"),
      embedFn: mockEmbed,
    });

    const result = await storeEntries(
      client,
      [makeEntry({ content: "incoming vec-exact", sourceFile: "incoming.jsonl", subject: "Different" })],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("updates confirmations for 0.92-0.98 matches with same subject and type", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(client, [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl" })], "sk-test", {
      sourceFile: "seed.jsonl",
      ingestContentHash: hashText("seed"),
      embedFn: mockEmbed,
    });

    const result = await storeEntries(
      client,
      [makeEntry({ content: "reinforcement vec-mid", sourceFile: "incoming.jsonl", subject: "Jim", type: "fact" })],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);

    const confirmations = await client.execute({
      sql: "SELECT confirmations FROM entries WHERE content = ?",
      args: ["seed vec-base"],
    });
    expect(asNumber(confirmations.rows[0]?.confirmations)).toBe(1);
  });

  it("adds entry without relation for same-subject different-type match when online dedup is disabled", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(client, [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl", type: "fact" })], "sk-test", {
      sourceFile: "seed.jsonl",
      ingestContentHash: hashText("seed"),
      embedFn: mockEmbed,
    });

    const result = await storeEntries(
      client,
      [
        makeEntry({
          content: "preference variant vec-mid",
          sourceFile: "incoming.jsonl",
          type: "preference",
          subject: "Jim",
        }),
      ],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.relations_created).toBe(0);

    const relationResult = await client.execute("SELECT COUNT(*) AS count FROM relations");
    expect(asNumber(relationResult.rows[0]?.count)).toBe(0);
  });

  it("adds entries when similarity is below 0.92", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(client, [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl" })], "sk-test", {
      sourceFile: "seed.jsonl",
      ingestContentHash: hashText("seed"),
      embedFn: mockEmbed,
    });

    const result = await storeEntries(
      client,
      [makeEntry({ content: "low similarity vec-low", sourceFile: "incoming.jsonl", subject: "Jim", type: "fact" })],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
